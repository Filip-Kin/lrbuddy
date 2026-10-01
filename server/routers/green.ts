import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { bus } from "../bus.ts";
import { db } from "../db/index.ts";
import { broadcasts, companies, companyDays, crews, LOT_GRADES, LOT_STATUSES, lots, requests, trucks, type Lot } from "../db/schema.ts";
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
import { assignDrawnArea, dayOfMap, deleteArea, markArea, moveArea, reassignArea } from "../dayof.ts";
import { paint, paintDepth, paintInput, undoPaint } from "../paint.ts";
import { createDrawnLot, deleteDrawnLot, drawnPolygon, editDrawnShape, suggestDrawn } from "../drawn.ts";
import { bareParcelsFor, setLot, type Actor } from "../parcel-status.ts";
import { buildCrewsFor } from "./plan/assignments.ts";
import { areaInput } from "./plan/common.ts";
import { emitLot } from "../lots-import.ts";
import { filterPairs, pairState, photoCounts, photoPairs, photoSummary, sitePhotos } from "../photos.ts";
import { pushToCc } from "../push.ts";
import { catalogFor, latestPositions, lotsAt, requestsWhere, requestViews, siteCcIds } from "../queries.ts";
import { greenProcedure, router } from "../trpc.ts";

const ACTIVE_CREW_MS = 30 * 60_000;

// #region builders
const greenActor = (ctx: { session: { role: string }; cc: Actor["cc"]; day: Actor["day"]; event: Actor["event"] }): Actor => ({
  role: ctx.session.role === "admin" ? "admin" : "green",
  cc: ctx.cc,
  day: ctx.day,
  event: ctx.event,
  crew: null,
});

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
  // The join token is the crew's password; green views never need it.
  return rows.map(({ crew: { token: _token, ...crew }, company }) => ({
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
  overview: greenProcedure.query(({ ctx }) => {
    const crewList = crewsAt(ctx.cc.id, ctx.day.id);
    const here = [...new Set(crewList.map((c) => c.companyId).filter((x): x is number => x !== null))];
    return {
      cc: ctx.cc,
      day: ctx.day,
      crews: crewList,
      trucks: trucksAt(ctx.cc.id, ctx.day.id),
      openRequests: requestsWhere(
        and(eq(requests.ccId, ctx.cc.id), eq(requests.dayId, ctx.day.id), inArray(requests.status, [...OPEN_STATUSES])),
      ),
      lots: lotsAt(ctx.cc.id, ctx.day.id),
      /** Companies with a crew at this CC today; the filter offers nothing that would show an empty board. */
      companies: here.length === 0 ? [] : db.select().from(companies).where(inArray(companies.id, here)).orderBy(companies.name).all(),
    };
  }),

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
    const summary = photoSummary(ctx.event.id);
    const rows = lotsAt(ctx.cc.id, ctx.day.id).map((l) => ({ ...l, photos: pairState(summary.get(l.id)) }));
    const crewList = crewsAt(ctx.cc.id, ctx.day.id);
    const byCrew = new Map<number | null, Record<Lot["status"], number>>();
    for (const l of rows) {
      const k = l.crewId;
      const c = byCrew.get(k) ?? { open: 0, in_progress: 0, done: 0, do_not_touch: 0, not_todo: 0 };
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
        .where(and(inArray(lots.id, input.lotIds), inArray(lots.ccId, siteCcIds(ctx.cc.id))))
        .returning()
        .all();
      for (const l of updated) emitLot(l);
      return { updated: updated.length };
    }),

  // #region day of (SPEC 19 Marks): rectangles on the map
  /** This CC's rectangles on its day, with lot counts, and the companies a rectangle can go to. */
  plan: greenProcedure.query(({ ctx }) => {
    const m = dayOfMap({ cc: ctx.cc, day: ctx.day });
    // Companies of the event with no crew on the day: Draw area offers Build crews for them.
    const withCrews = new Set(
      db.select({ companyId: crews.companyId }).from(crews).where(eq(crews.dayId, ctx.day.id)).all().map((r) => r.companyId),
    );
    const promised = new Map(db.select().from(companyDays).where(eq(companyDays.dayId, ctx.day.id)).all().map((r) => [r.companyId, r.headcount]));
    const buildable = db
      .select()
      .from(companies)
      .where(eq(companies.eventId, ctx.event.id))
      .orderBy(companies.name)
      .all()
      .filter((c) => !withCrews.has(c.id))
      .map((c) => ({ id: c.id, name: c.name, headcount: promised.get(c.id) ?? null }));
    return { ...m, buildable };
  }),

  /** Every unfinished lot of the rectangle Done, or Do not touch (which also flags the rectangle). */
  markArea: greenProcedure
    .input(z.object({ areaId: z.number().int(), action: z.enum(["done", "doNotTouch"]) }))
    .mutation(({ ctx, input }) => markArea({ cc: ctx.cc, day: ctx.day }, input.areaId, input.action)),


  /** Hands a rectangle to one or more crews of a company at this CC. */
  reassignArea: greenProcedure
    .input(z.object({ areaId: z.number().int(), companyId: z.number().int(), crewIds: z.array(z.number().int()).min(1).max(50) }))
    .mutation(({ ctx, input }) => reassignArea({ cc: ctx.cc, day: ctx.day }, input)),
  // #endregion

  // #region SPEC 21: one parcel status, areas drawn on the map
  /** Cached parcels in the CC's day area with no lot: drawn as thin outlines, tappable. */
  parcels: greenProcedure.query(({ ctx }) => bareParcelsFor({ role: ctx.session.role === "admin" ? "admin" : "green", cc: ctx.cc, day: ctx.day, event: ctx.event, crew: null })),

  /** Status, grade or note of a lot or a bare parcel; Todo on a bare parcel creates the lot. */
  setLotStatus: greenProcedure
    .input(
      z.object({
        lotId: z.number().int().nullish(),
        parcelId: z.string().min(1).max(40).nullish(),
        status: z.enum(LOT_STATUSES).optional(),
        grade: z.enum(LOT_GRADES).nullish(),
        note: z.string().max(500).nullish(),
      }),
    )
    .mutation(({ ctx, input }) =>
      setLot(
        { role: ctx.session.role === "admin" ? "admin" : "green", cc: ctx.cc, day: ctx.day, event: ctx.event, crew: null },
        { lotId: input.lotId, parcelId: input.parcelId, status: input.status, grade: input.grade, note: input.note },
        ctx.session.displayName,
      ),
    ),

  /** Paint mode (SPEC 23): one stroke of statuses or a crew over many parcels. */
  paint: greenProcedure.input(paintInput).mutation(({ ctx, input }) => paint(greenActor(ctx), ctx.session.id, input, ctx.session.displayName)),

  /** Takes back this session's last stroke at the CC. */
  paintUndo: greenProcedure.mutation(({ ctx }) => undoPaint(greenActor(ctx), ctx.session.id)),

  /** Strokes Undo can take back, for the Undo button when Paint opens. */
  paintState: greenProcedure.query(({ ctx }) => ({ strokes: paintDepth(ctx.session.id, ctx.cc.id) })),

  // #region Draw lot (SPEC 24)
  /** The name ("Alley, Lawrence to Collingwood" or "Lot") and crew the Save sheet starts with. */
  drawLotStart: greenProcedure.input(z.object({ polygon: drawnPolygon })).query(({ ctx, input }) => suggestDrawn(greenActor(ctx), input.polygon)),
  drawLot: greenProcedure
    .input(z.object({ polygon: drawnPolygon, name: z.string().max(120), status: z.enum(LOT_STATUSES), crewId: z.number().int().nullable() }))
    .mutation(({ ctx, input }) => createDrawnLot(greenActor(ctx), input)),
  editLotShape: greenProcedure
    .input(z.object({ lotId: z.number().int(), polygon: drawnPolygon }))
    .mutation(({ ctx, input }) => editDrawnShape(greenActor(ctx), input.lotId, input.polygon)),
  deleteLot: greenProcedure.input(z.object({ lotId: z.number().int() })).mutation(({ ctx, input }) => deleteDrawnLot(greenActor(ctx), input.lotId)),
  // #endregion

  /** Draw area, then Assign: the crews take the rectangle and the Todo lots inside it. */
  assignArea: greenProcedure
    .input(z.object({ polygon: areaInput, crewIds: z.array(z.number().int()).min(1).max(50) }))
    .mutation(({ ctx, input }) => assignDrawnArea({ cc: ctx.cc, day: ctx.day }, input)),

  /** Edit corners. */
  moveArea: greenProcedure
    .input(z.object({ areaId: z.number().int(), polygon: areaInput }))
    .mutation(({ ctx, input }) => moveArea({ cc: ctx.cc, day: ctx.day }, input)),

  /** Delete area: lots stay, unassigned. */
  deleteArea: greenProcedure.input(z.object({ areaId: z.number().int() })).mutation(({ ctx, input }) => deleteArea({ cc: ctx.cc, day: ctx.day }, input.areaId)),

  /** Crews for a company with none on the day, from its headcount (SPEC 16 Build crews), at this CC. */
  buildCrews: greenProcedure
    .input(z.object({ companyId: z.number().int(), headcount: z.number().int().min(1).max(5000).optional() }))
    .mutation(({ ctx, input }) => buildCrewsFor({ eventId: ctx.event.id, dayId: ctx.day.id, ccId: ctx.cc.id, companyId: input.companyId, headcount: input.headcount })),
  // #endregion

  /** Before and after pairs at this CC's site, newest first, with the filter options. */
  photos: greenProcedure
    .input(
      z
        .object({
          companyId: z.number().int().nullish(),
          crewId: z.number().int().nullish(),
          status: z.enum(LOT_STATUSES).nullish(),
          missingAfter: z.boolean().nullish(),
        })
        .optional(),
    )
    .query(({ ctx, input }) => {
      const all = photoPairs(sitePhotos(ctx.cc.id));
      const crewList = crewsAt(ctx.cc.id, ctx.day.id);
      const companyIds = new Set([...crewList.map((c) => c.companyId), ...all.map((p) => p.companyId)].filter((x): x is number => x !== null));
      return {
        pairs: filterPairs(all, input ?? {}),
        total: all.length,
        crews: crewList.map((c) => ({ id: c.id, name: c.name, companyId: c.companyId })),
        companies: companyIds.size === 0 ? [] : db.select().from(companies).where(inArray(companies.id, [...companyIds])).orderBy(companies.name).all(),
      };
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
    db.select().from(broadcasts).where(and(eq(broadcasts.ccId, ctx.cc.id), eq(broadcasts.dayId, ctx.day.id))).orderBy(desc(broadcasts.at), desc(broadcasts.id)).all(),
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
    const lotRows = lotsAt(ctx.cc.id, ctx.day.id);
    const lotsByStatus: Record<Lot["status"], number> = { open: 0, in_progress: 0, done: 0, do_not_touch: 0, not_todo: 0 };
    for (const l of lotRows) lotsByStatus[l.status]++;
    const photographed = photoCounts(lotRows.map((l) => l.id), photoSummary(ctx.event.id));
    return {
      /** Lots with a before and an after photo, and lots with a before and no after. */
      photographed: photographed.both,
      missingAfter: photographed.missingAfter,
      requestsByType: [...byType.values()].sort((a, b) => b.count - a.count),
      medianDeliverMs: median(deliverMs),
      delivered: deliverMs.length,
      /** Same meaning as the Requests board's Open column: no truck yet. */
      open: all.filter((r) => r.status === "open").length,
      onTruck: all.filter((r) => r.status === "assigned" || r.status === "en_route").length,
      cancelled: all.filter((r) => r.status === "cancelled").length,
      lotsByStatus,
      /** Work lots: every lot but Not todo. */
      lotsTotal: lotRows.length - lotsByStatus.not_todo,
      lotsDoneByCompany: [...byCompany.entries()].map(([company, done]) => ({ company, done })).sort((a, b) => b.done - a.done),
      activeCrews: crewList.filter((c) => c.lastSeenAt !== null && now - c.lastSeenAt <= ACTIVE_CREW_MS).length,
      totalCrews: crewList.length,
    };
  }),
});
