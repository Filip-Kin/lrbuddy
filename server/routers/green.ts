import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { bus } from "../bus.ts";
import { db } from "../db/index.ts";
import { broadcasts, companies, crews, lots, requests, trucks, type Lot } from "../db/schema.ts";
import {
  cancelRequest,
  createRequest,
  crewLabel,
  deliverRequests,
  getRequest,
  getType,
  isLow,
  OPEN_STATUSES,
  reassign,
  stockFor,
  stopsForTruck,
} from "../dispatch.ts";
import { emitLot } from "../lots-import.ts";
import { pushToCc } from "../push.ts";
import { catalogFor, latestPositions, requestsWhere, requestViews } from "../queries.ts";
import { greenProcedure, router } from "../trpc.ts";

const ACTIVE_CREW_MS = 30 * 60_000;

// #region builders
const crewsAt = (ccId: number, dayId: number) => {
  const rows = db
    .select({ crew: crews, company: companies })
    .from(crews)
    .leftJoin(companies, eq(companies.id, crews.companyId))
    .where(and(eq(crews.ccId, ccId), eq(crews.dayId, dayId)))
    .orderBy(crews.number)
    .all();
  const pos = latestPositions("crew", rows.map((r) => r.crew.id));
  const ids = rows.map((r) => r.crew.id);
  const openCounts = new Map<number, number>();
  const doneCounts = new Map<number, number>();
  if (ids.length > 0) {
    for (const r of db
      .select({ crewId: requests.crewId, n: sql<number>`count(*)` })
      .from(requests)
      .where(and(inArray(requests.crewId, ids), inArray(requests.status, [...OPEN_STATUSES])))
      .groupBy(requests.crewId)
      .all()) {
      if (r.crewId !== null) openCounts.set(r.crewId, r.n);
    }
    for (const r of db
      .select({ crewId: lots.crewId, n: sql<number>`count(*)` })
      .from(lots)
      .where(and(inArray(lots.crewId, ids), eq(lots.status, "done")))
      .groupBy(lots.crewId)
      .all()) {
      if (r.crewId !== null) doneCounts.set(r.crewId, r.n);
    }
  }
  return rows.map(({ crew, company }) => ({
    ...crew,
    name: crewLabel(crew),
    companyName: company?.name ?? null,
    position: pos.get(crew.id) ?? null,
    openRequests: openCounts.get(crew.id) ?? 0,
    lotsDone: doneCounts.get(crew.id) ?? 0,
  }));
};

const trucksAt = (ccId: number, dayId: number) => {
  const now = Date.now();
  const rows = db
    .select()
    .from(trucks)
    .where(and(eq(trucks.ccId, ccId), eq(trucks.dayId, dayId)))
    .orderBy(trucks.name)
    .all();
  const pos = latestPositions("truck", rows.map((t) => t.id));
  return rows.map((t) => {
    const stock = stockFor(t.id);
    return {
      ...t,
      position: pos.get(t.id) ?? null,
      stopsLeft: stopsForTruck(t.id, now).length,
      stock,
      lowStock: stock.some(isLow),
    };
  });
};

const lotsAt = (ccId: number): Lot[] => db.select().from(lots).where(eq(lots.ccId, ccId)).orderBy(lots.address).all();

const scopedRequest = (id: number, ccId: number) => {
  const r = getRequest(id);
  if (r.ccId !== ccId) throw new TRPCError({ code: "FORBIDDEN", message: "Not at this command center" });
  return r;
};

const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
// #endregion

export const greenRouter = router({
  overview: greenProcedure.query(({ ctx }) => ({
    cc: ctx.cc,
    day: ctx.day,
    crews: crewsAt(ctx.cc.id, ctx.day.id),
    trucks: trucksAt(ctx.cc.id, ctx.day.id),
    openRequests: requestsWhere(
      and(eq(requests.ccId, ctx.cc.id), eq(requests.dayId, ctx.day.id), inArray(requests.status, [...OPEN_STATUSES])),
    ),
    lots: lotsAt(ctx.cc.id),
    companies: db.select().from(companies).where(eq(companies.eventId, ctx.event.id)).orderBy(companies.name).all(),
  })),

  requests: greenProcedure.input(z.object({ companyId: z.number().int().nullish() }).optional()).query(({ ctx, input }) => {
    const all = requestsWhere(and(eq(requests.ccId, ctx.cc.id), eq(requests.dayId, ctx.day.id)), 1000);
    return input?.companyId ? all.filter((r) => r.companyId === input.companyId) : all;
  }),

  assign: greenProcedure.input(z.object({ requestId: z.number().int(), truckId: z.number().int() })).mutation(({ ctx, input }) => {
    scopedRequest(input.requestId, ctx.cc.id);
    return requestViews([reassign(input.requestId, input.truckId)])[0]!;
  }),

  cancel: greenProcedure.input(z.object({ requestId: z.number().int() })).mutation(({ ctx, input }) => {
    scopedRequest(input.requestId, ctx.cc.id);
    return requestViews([cancelRequest(input.requestId, "green")])[0]!;
  }),

  deliver: greenProcedure.input(z.object({ requestId: z.number().int() })).mutation(({ ctx, input }) => {
    scopedRequest(input.requestId, ctx.cc.id);
    const done = deliverRequests([input.requestId]);
    if (done.length === 0) throw new TRPCError({ code: "BAD_REQUEST", message: "Request already closed" });
    return requestViews(done)[0]!;
  }),

  createStop: greenProcedure
    .input(
      z.object({
        typeId: z.number().int(),
        qty: z.number().int().min(1).max(99),
        lat: z.number().min(-90).max(90),
        lng: z.number().min(-180).max(180),
        crewId: z.number().int().nullish(),
        label: z.string().max(120).nullish(),
        note: z.string().max(500).nullish(),
      }),
    )
    .mutation(({ ctx, input }) => {
      const type = getType(input.typeId);
      if (type.eventId !== ctx.event.id) throw new TRPCError({ code: "BAD_REQUEST", message: "Item not available" });
      if (input.crewId) {
        const crew = db.select().from(crews).where(eq(crews.id, input.crewId)).get();
        if (!crew || crew.ccId !== ctx.cc.id) throw new TRPCError({ code: "BAD_REQUEST", message: "Crew not at this command center" });
      }
      const r = createRequest({
        crewId: input.crewId ?? null,
        ccId: ctx.cc.id,
        dayId: ctx.day.id,
        typeId: input.typeId,
        qty: input.qty,
        note: input.note ?? null,
        label: input.label ?? null,
        createdBy: "green",
        lat: input.lat,
        lng: input.lng,
      });
      return requestViews([r])[0]!;
    }),

  catalog: greenProcedure.query(({ ctx }) => catalogFor(ctx.event.id)),

  lots: greenProcedure.query(({ ctx }) => {
    const rows = lotsAt(ctx.cc.id);
    const crewList = crewsAt(ctx.cc.id, ctx.day.id);
    const byCrew = new Map<number | null, Record<Lot["status"], number>>();
    for (const l of rows) {
      const k = l.crewId;
      const c = byCrew.get(k) ?? { open: 0, in_progress: 0, done: 0, skipped: 0 };
      c[l.status]++;
      byCrew.set(k, c);
    }
    return {
      lots: rows,
      crews: crewList.map((c) => ({ id: c.id, name: c.name, companyName: c.companyName })),
      counts: [...byCrew.entries()].map(([crewId, counts]) => ({ crewId, counts })),
    };
  }),

  assignLots: greenProcedure
    .input(z.object({ lotIds: z.array(z.number().int()).min(1).max(2000), crewId: z.number().int().nullable() }))
    .mutation(({ ctx, input }) => {
      if (input.crewId !== null) {
        const crew = db.select().from(crews).where(eq(crews.id, input.crewId)).get();
        if (!crew || crew.ccId !== ctx.cc.id) throw new TRPCError({ code: "BAD_REQUEST", message: "Crew not at this command center" });
      }
      const updated = db
        .update(lots)
        .set({ crewId: input.crewId })
        .where(and(inArray(lots.id, input.lotIds), eq(lots.ccId, ctx.cc.id)))
        .returning()
        .all();
      for (const l of updated) emitLot(l);
      return { updated: updated.length };
    }),

  crews: greenProcedure.query(({ ctx }) => crewsAt(ctx.cc.id, ctx.day.id)),

  trucks: greenProcedure.query(({ ctx }) => trucksAt(ctx.cc.id, ctx.day.id)),

  broadcast: greenProcedure.input(z.object({ body: z.string().trim().min(1).max(500) })).mutation(({ ctx, input }) => {
    const b = db
      .insert(broadcasts)
      .values({ ccId: ctx.cc.id, dayId: ctx.day.id, body: input.body, sentBy: ctx.session.displayName, at: Date.now() })
      .returning()
      .get();
    bus.emit("broadcast", { ccId: ctx.cc.id, dayId: ctx.day.id }, { broadcast: b });
    pushToCc(ctx.cc.id, { title: `CC ${ctx.cc.name}`, body: input.body, url: "/", tag: `broadcast-${b.id}` });
    return b;
  }),

  broadcasts: greenProcedure.query(({ ctx }) =>
    db.select().from(broadcasts).where(and(eq(broadcasts.ccId, ctx.cc.id), eq(broadcasts.dayId, ctx.day.id))).orderBy(desc(broadcasts.at)).all(),
  ),

  stats: greenProcedure.query(({ ctx }) => {
    const all = requestsWhere(and(eq(requests.ccId, ctx.cc.id), eq(requests.dayId, ctx.day.id)), 5000);
    const byType = new Map<string, { label: string; count: number; qty: number }>();
    for (const r of all) {
      if (r.status === "cancelled") continue;
      const e = byType.get(r.typeKey) ?? { label: r.typeLabel, count: 0, qty: 0 };
      e.count++;
      e.qty += r.qty;
      byType.set(r.typeKey, e);
    }
    const deliverMs = all.filter((r) => r.status === "delivered" && r.deliveredAt !== null).map((r) => r.deliveredAt! - r.createdAt);
    const crewList = crewsAt(ctx.cc.id, ctx.day.id);
    const byCompany = new Map<string, number>();
    for (const c of crewList) {
      const k = c.companyName ?? "No company";
      byCompany.set(k, (byCompany.get(k) ?? 0) + c.lotsDone);
    }
    const now = Date.now();
    return {
      requestsByType: [...byType.values()].sort((a, b) => b.count - a.count),
      medianDeliverMs: median(deliverMs),
      delivered: deliverMs.length,
      open: all.filter((r) => r.status === "open" || r.status === "assigned" || r.status === "en_route").length,
      lotsDoneByCompany: [...byCompany.entries()].map(([company, done]) => ({ company, done })).sort((a, b) => b.done - a.done),
      activeCrews: crewList.filter((c) => c.lastSeenAt !== null && now - c.lastSeenAt <= ACTIVE_CREW_MS).length,
      totalCrews: crewList.length,
    };
  }),
});
