import { TRPCError } from "@trpc/server";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import Papa from "papaparse";
import QRCode from "qrcode";
import { z } from "zod";
import { newCrewToken, uniqueCode } from "../auth.ts";
import { config } from "../config.ts";
import { db } from "../db/index.ts";
import {
  commandCenters,
  companies,
  crews,
  days,
  events,
  greenCodes,
  greenShirts,
  lots,
  positions,
  requests,
  requestTypes,
  stockMoves,
  trucks,
  truckStock,
  UNITS,
  type Event,
} from "../db/schema.ts";
import { crewLabel, scheduleRoute, stockFor } from "../dispatch.ts";
import { normalizeBBox } from "../geo.ts";
import { addManualLot, assignLotsToCcByBBox, importDlba, importLotsCsv } from "../lots-import.ts";
import { activeEvent, catalogFor, requestViews } from "../queries.ts";
import { copySetupFromPreviousDay, createCc, createCrew, createEvent, createTruck, setActiveEvent } from "../setup.ts";
import { adminProcedure, router } from "../trpc.ts";

// #region helpers
const bboxInput = z.tuple([z.number(), z.number(), z.number(), z.number()]);
const phone = z.string().trim().max(40).nullish();
const id = z.number().int();

const requireActive = (): Event => {
  const ev = activeEvent();
  if (!ev) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "No active event" });
  return ev;
};

const eventOrActive = (eventId: number | null | undefined): number => eventId ?? requireActive().id;

const toCsv = (rows: ReadonlyArray<Record<string, string | number | boolean | null>>): string => Papa.unparse(rows as object[]);

const iso = (ms: number | null): string => (ms === null ? "" : new Date(ms).toISOString());
// #endregion

// #region events and days
const eventsRouter = router({
  list: adminProcedure.query(() => db.select().from(events).orderBy(asc(events.year), asc(events.id)).all()),
  create: adminProcedure
    .input(
      z.object({
        name: z.string().trim().min(1).max(100),
        year: z.number().int().min(2000).max(2100),
        startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        dayCount: z.number().int().min(1).max(14).default(6),
        active: z.boolean().optional(),
      }),
    )
    .mutation(({ input }) => createEvent(input)),
  setActive: adminProcedure.input(z.object({ id })).mutation(({ input }) => {
    setActiveEvent(input.id);
    return { ok: true };
  }),
  rename: adminProcedure.input(z.object({ id, name: z.string().trim().min(1).max(100) })).mutation(({ input }) =>
    db.update(events).set({ name: input.name }).where(eq(events.id, input.id)).returning().get(),
  ),
});

const daysRouter = router({
  list: adminProcedure.input(z.object({ eventId: id.nullish() }).optional()).query(({ input }) => {
    const eventId = eventOrActive(input?.eventId);
    return db.select().from(days).where(eq(days.eventId, eventId)).orderBy(days.sort).all();
  }),
  /** Everything the Day screen edits. */
  get: adminProcedure.input(z.object({ id })).query(({ input }) => {
    const day = db.select().from(days).where(eq(days.id, input.id)).get();
    if (!day) throw new TRPCError({ code: "NOT_FOUND", message: "Day not found" });
    const ccs = db.select().from(commandCenters).where(eq(commandCenters.dayId, day.id)).orderBy(commandCenters.name).all();
    const ccIds = ccs.map((c) => c.id);
    const shirts = ccIds.length ? db.select().from(greenShirts).where(inArray(greenShirts.ccId, ccIds)).all() : [];
    const codes = ccIds.length ? db.select().from(greenCodes).where(inArray(greenCodes.ccId, ccIds)).all() : [];
    const truckRows = db.select().from(trucks).where(eq(trucks.dayId, day.id)).orderBy(trucks.name).all();
    return {
      day,
      catalog: catalogFor(day.eventId, true),
      ccs: ccs.map((cc) => ({
        ...cc,
        greenShirts: shirts.filter((g) => g.ccId === cc.id),
        greenCode: codes.find((g) => g.ccId === cc.id)?.code ?? null,
        trucks: truckRows.filter((t) => t.ccId === cc.id).map((t) => ({ ...t, stock: stockFor(t.id) })),
      })),
    };
  }),
  update: adminProcedure
    .input(z.object({ id, date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), label: z.string().trim().min(1).max(40).optional() }))
    .mutation(({ input }) => {
      const { id: dayId, ...set } = input;
      return db.update(days).set(set).where(eq(days.id, dayId)).returning().get();
    }),
  copyFromPrevious: adminProcedure.input(z.object({ id })).mutation(({ input }) => copySetupFromPreviousDay(input.id)),
});
// #endregion

// #region command centers, green shirts, codes, trucks
const ccsRouter = router({
  /** Every CC of the active event, for the admin CC picker. */
  list: adminProcedure.input(z.object({ eventId: id.nullish() }).optional()).query(({ input }) => {
    const eventId = eventOrActive(input?.eventId);
    return db
      .select({ cc: commandCenters, day: days })
      .from(commandCenters)
      .innerJoin(days, eq(days.id, commandCenters.dayId))
      .where(eq(days.eventId, eventId))
      .orderBy(days.sort, commandCenters.name)
      .all()
      .map(({ cc, day }) => ({ ...cc, dayLabel: day.label, date: day.date }));
  }),
  create: adminProcedure
    .input(z.object({ dayId: id, name: z.string().trim().min(1).max(80), lat: z.number(), lng: z.number(), address: z.string().max(200).nullish(), notes: z.string().max(1000).nullish() }))
    .mutation(({ input }) => createCc(input)),
  update: adminProcedure
    .input(
      z.object({
        id,
        name: z.string().trim().min(1).max(80).optional(),
        lat: z.number().optional(),
        lng: z.number().optional(),
        address: z.string().max(200).nullish(),
        notes: z.string().max(1000).nullish(),
      }),
    )
    .mutation(({ input }) => {
      const { id: ccId, ...set } = input;
      return db.update(commandCenters).set(set).where(eq(commandCenters.id, ccId)).returning().get();
    }),
  delete: adminProcedure.input(z.object({ id })).mutation(({ input }) => {
    db.delete(commandCenters).where(eq(commandCenters.id, input.id)).run();
    return { ok: true };
  }),
});

const greenShirtsRouter = router({
  create: adminProcedure
    .input(z.object({ ccId: id, name: z.string().trim().min(1).max(80), phone, roleLabel: z.string().trim().max(40).nullish() }))
    .mutation(({ input }) => db.insert(greenShirts).values(input).returning().get()),
  update: adminProcedure
    .input(z.object({ id, name: z.string().trim().min(1).max(80).optional(), phone, roleLabel: z.string().trim().max(40).nullish() }))
    .mutation(({ input }) => {
      const { id: gid, ...set } = input;
      return db.update(greenShirts).set(set).where(eq(greenShirts.id, gid)).returning().get();
    }),
  delete: adminProcedure.input(z.object({ id })).mutation(({ input }) => {
    db.delete(greenShirts).where(eq(greenShirts.id, input.id)).run();
    return { ok: true };
  }),
});

const greenCodesRouter = router({
  regenerate: adminProcedure.input(z.object({ ccId: id })).mutation(({ input }) => {
    const code = uniqueCode();
    db.insert(greenCodes).values({ ccId: input.ccId, code }).onConflictDoUpdate({ target: greenCodes.ccId, set: { code } }).run();
    return { code };
  }),
});

const trucksRouter = router({
  create: adminProcedure
    .input(z.object({ dayId: id, ccId: id, name: z.string().trim().min(1).max(40), driverName: z.string().trim().max(80).nullish(), driverPhone: phone }))
    .mutation(({ input }) => createTruck(input)),
  update: adminProcedure
    .input(
      z.object({
        id,
        name: z.string().trim().min(1).max(40).optional(),
        ccId: id.optional(),
        driverName: z.string().trim().max(80).nullish(),
        driverPhone: phone,
        status: z.enum(["idle", "delivering", "returning", "offline"]).optional(),
      }),
    )
    .mutation(({ input }) => {
      const { id: tid, ...set } = input;
      const t = db.update(trucks).set(set).where(eq(trucks.id, tid)).returning().get();
      scheduleRoute(tid);
      return t;
    }),
  regenerateCode: adminProcedure.input(z.object({ id })).mutation(({ input }) =>
    db.update(trucks).set({ code: uniqueCode() }).where(eq(trucks.id, input.id)).returning().get(),
  ),
  setCapacity: adminProcedure
    .input(z.object({ truckId: id, typeId: id, capacity: z.number().int().min(0).max(1000) }))
    .mutation(({ input }) => {
      db.insert(truckStock)
        .values({ truckId: input.truckId, typeId: input.typeId, qty: input.capacity, capacity: input.capacity })
        .onConflictDoUpdate({ target: [truckStock.truckId, truckStock.typeId], set: { capacity: input.capacity } })
        .run();
      return stockFor(input.truckId);
    }),
  delete: adminProcedure.input(z.object({ id })).mutation(({ input }) => {
    db.delete(trucks).where(eq(trucks.id, input.id)).run();
    return { ok: true };
  }),
});
// #endregion

// #region companies and crews
const companiesRouter = router({
  list: adminProcedure.input(z.object({ eventId: id.nullish() }).optional()).query(({ input }) =>
    db.select().from(companies).where(eq(companies.eventId, eventOrActive(input?.eventId))).orderBy(companies.name).all(),
  ),
  create: adminProcedure.input(z.object({ name: z.string().trim().min(1).max(100), eventId: id.nullish() })).mutation(({ input }) =>
    db.insert(companies).values({ eventId: eventOrActive(input.eventId), name: input.name }).returning().get(),
  ),
  rename: adminProcedure.input(z.object({ id, name: z.string().trim().min(1).max(100) })).mutation(({ input }) =>
    db.update(companies).set({ name: input.name }).where(eq(companies.id, input.id)).returning().get(),
  ),
  delete: adminProcedure.input(z.object({ id })).mutation(({ input }) => {
    db.delete(companies).where(eq(companies.id, input.id)).run();
    return { ok: true };
  }),
});

const crewInput = z.object({
  dayId: id,
  ccId: id,
  companyId: id.nullable(),
  leadName: z.string().trim().max(80).nullish(),
  leadPhone: phone,
  headcount: z.number().int().min(0).max(500).nullish(),
  notes: z.string().max(1000).nullish(),
});

const crewsRouter = router({
  list: adminProcedure.input(z.object({ dayId: id })).query(({ input }) =>
    db
      .select({ crew: crews, company: companies, cc: commandCenters })
      .from(crews)
      .leftJoin(companies, eq(companies.id, crews.companyId))
      .innerJoin(commandCenters, eq(commandCenters.id, crews.ccId))
      .where(eq(crews.dayId, input.dayId))
      .orderBy(crews.number)
      .all()
      .map(({ crew, company, cc }) => ({
        ...crew,
        name: crewLabel(crew),
        companyName: company?.name ?? null,
        ccName: cc.name,
        joinUrl: `${config.publicUrl}/j/${crew.token}`,
      })),
  ),
  create: adminProcedure.input(crewInput).mutation(({ input }) => createCrew(input)),
  update: adminProcedure.input(crewInput.partial().extend({ id })).mutation(({ input }) => {
    const { id: cid, ...set } = input;
    return db.update(crews).set(set).where(eq(crews.id, cid)).returning().get();
  }),
  delete: adminProcedure.input(z.object({ id })).mutation(({ input }) => {
    db.delete(crews).where(eq(crews.id, input.id)).run();
    return { ok: true };
  }),
  regenerateToken: adminProcedure.input(z.object({ id })).mutation(({ input }) =>
    db.update(crews).set({ token: newCrewToken() }).where(eq(crews.id, input.id)).returning().get(),
  ),
  /** CSV `day, cc, company, lead_name, lead_phone, headcount`. Day matches label, date or number. */
  importCsv: adminProcedure.input(z.object({ csv: z.string().max(2_000_000), eventId: id.nullish() })).mutation(({ input }) => {
    const eventId = eventOrActive(input.eventId);
    const parsed = Papa.parse<Record<string, string>>(input.csv.trim(), {
      header: true,
      skipEmptyLines: true,
      transformHeader: (h) => h.trim().toLowerCase().replace(/\s+/g, "_"),
    });
    const dayRows = db.select().from(days).where(eq(days.eventId, eventId)).all();
    const findDay = (v: string) => {
      const s = v.trim().toLowerCase();
      return dayRows.find((d) => d.label.toLowerCase() === s || d.date === s || String(d.sort) === s || `day ${d.sort}` === s);
    };
    const companyCache = new Map(
      db.select().from(companies).where(eq(companies.eventId, eventId)).all().map((c) => [c.name.toLowerCase(), c.id]),
    );
    let added = 0;
    const errors: string[] = [];
    parsed.data.forEach((r, i) => {
      const line = i + 2;
      const day = findDay(r.day ?? "");
      if (!day) {
        errors.push(`Row ${line}: day`);
        return;
      }
      const ccName = (r.cc ?? "").trim().toLowerCase().replace(/^cc\s+/, "");
      const cc = db
        .select()
        .from(commandCenters)
        .where(and(eq(commandCenters.dayId, day.id), sql`lower(${commandCenters.name}) = ${ccName}`))
        .get();
      if (!cc) {
        errors.push(`Row ${line}: cc`);
        return;
      }
      const companyName = (r.company ?? "").trim();
      let companyId: number | null = null;
      if (companyName) {
        companyId = companyCache.get(companyName.toLowerCase()) ?? null;
        if (companyId === null) {
          companyId = db.insert(companies).values({ eventId, name: companyName }).returning().get().id;
          companyCache.set(companyName.toLowerCase(), companyId);
        }
      }
      const head = Number(r.headcount);
      createCrew({
        dayId: day.id,
        ccId: cc.id,
        companyId,
        leadName: r.lead_name?.trim() || null,
        leadPhone: r.lead_phone?.trim() || null,
        headcount: Number.isFinite(head) && r.headcount?.trim() ? head : null,
      });
      added++;
    });
    return { added, errors };
  }),
});
// #endregion

// #region catalog
const catalogRouter = router({
  list: adminProcedure.input(z.object({ eventId: id.nullish() }).optional()).query(({ input }) => catalogFor(eventOrActive(input?.eventId), true)),
  create: adminProcedure
    .input(
      z.object({
        eventId: id.nullish(),
        key: z.string().trim().min(1).max(40).regex(/^[a-z0-9_]+$/),
        label: z.string().trim().min(1).max(60),
        unit: z.enum(UNITS),
        priority: z.number().int().min(1).max(3),
        tracksStock: z.boolean(),
        defaultCapacity: z.number().int().min(0).max(1000).default(0),
      }),
    )
    .mutation(({ input }) => {
      const eventId = eventOrActive(input.eventId);
      const last = db.select({ n: sql<number>`coalesce(max(${requestTypes.sort}), 0)` }).from(requestTypes).where(eq(requestTypes.eventId, eventId)).get();
      const { eventId: _e, ...rest } = input;
      return db.insert(requestTypes).values({ ...rest, eventId, sort: (last?.n ?? 0) + 1, active: true }).returning().get();
    }),
  update: adminProcedure
    .input(
      z.object({
        id,
        label: z.string().trim().min(1).max(60).optional(),
        unit: z.enum(UNITS).optional(),
        priority: z.number().int().min(1).max(3).optional(),
        tracksStock: z.boolean().optional(),
        defaultCapacity: z.number().int().min(0).max(1000).optional(),
        active: z.boolean().optional(),
      }),
    )
    .mutation(({ input }) => {
      const { id: tid, ...set } = input;
      return db.update(requestTypes).set(set).where(eq(requestTypes.id, tid)).returning().get();
    }),
  /** Sets the order to the given id list. */
  reorder: adminProcedure.input(z.object({ ids: z.array(id).min(1).max(200) })).mutation(({ input }) => {
    db.transaction((tx) => {
      input.ids.forEach((tid, i) => tx.update(requestTypes).set({ sort: i + 1 }).where(eq(requestTypes.id, tid)).run());
    });
    return { ok: true };
  }),
});
// #endregion

// #region lots
const lotsRouter = router({
  list: adminProcedure.input(z.object({ eventId: id.nullish() }).optional()).query(({ input }) =>
    db.select().from(lots).where(eq(lots.eventId, eventOrActive(input?.eventId))).all(),
  ),
  counts: adminProcedure.input(z.object({ eventId: id.nullish() }).optional()).query(({ input }) => {
    const eventId = eventOrActive(input?.eventId);
    const bySource = db.select({ source: lots.source, n: sql<number>`count(*)` }).from(lots).where(eq(lots.eventId, eventId)).groupBy(lots.source).all();
    const byStatus = db.select({ status: lots.status, n: sql<number>`count(*)` }).from(lots).where(eq(lots.eventId, eventId)).groupBy(lots.status).all();
    const unassigned = db.select({ n: sql<number>`count(*)` }).from(lots).where(and(eq(lots.eventId, eventId), sql`${lots.ccId} is null`)).get();
    return { bySource, byStatus, unassigned: unassigned?.n ?? 0 };
  }),
  importDlba: adminProcedure.input(z.object({ bbox: bboxInput, eventId: id.nullish(), limit: z.number().int().min(1).max(20000).optional() })).mutation(async ({ input }) => {
    const [w, s, e, n] = normalizeBBox(input.bbox);
    if (e - w > 0.3 || n - s > 0.3) throw new TRPCError({ code: "BAD_REQUEST", message: "Area too large" });
    try {
      return await importDlba(eventOrActive(input.eventId), [w, s, e, n], { limit: input.limit });
    } catch (err) {
      throw new TRPCError({ code: "BAD_GATEWAY", message: "Land Bank unavailable", cause: err });
    }
  }),
  importCsv: adminProcedure.input(z.object({ csv: z.string().max(5_000_000), eventId: id.nullish() })).mutation(({ input }) =>
    importLotsCsv(eventOrActive(input.eventId), input.csv),
  ),
  add: adminProcedure
    .input(z.object({ lat: z.number(), lng: z.number(), address: z.string().max(200).nullish(), ccId: id.nullish(), eventId: id.nullish() }))
    .mutation(({ input }) => addManualLot(eventOrActive(input.eventId), input)),
  assignCc: adminProcedure.input(z.object({ bbox: bboxInput, ccId: id.nullable(), eventId: id.nullish() })).mutation(({ input }) => ({
    updated: assignLotsToCcByBBox(eventOrActive(input.eventId), input.bbox, input.ccId),
  })),
  delete: adminProcedure.input(z.object({ ids: z.array(id).min(1).max(5000) })).mutation(({ input }) => {
    const r = db.delete(lots).where(inArray(lots.id, input.ids)).returning({ id: lots.id }).all();
    return { deleted: r.length };
  }),
});
// #endregion

// #region print and export
const printRouter = router({
  /** One page per crew with its join QR, plus one page per CC with its codes. */
  sheet: adminProcedure.input(z.object({ dayId: id })).query(async ({ input }) => {
    const day = db.select().from(days).where(eq(days.id, input.dayId)).get();
    if (!day) throw new TRPCError({ code: "NOT_FOUND", message: "Day not found" });
    const ccs = db.select().from(commandCenters).where(eq(commandCenters.dayId, day.id)).orderBy(commandCenters.name).all();
    const ccIds = ccs.map((c) => c.id);
    const shirts = ccIds.length ? db.select().from(greenShirts).where(inArray(greenShirts.ccId, ccIds)).all() : [];
    const codes = ccIds.length ? db.select().from(greenCodes).where(inArray(greenCodes.ccId, ccIds)).all() : [];
    const truckRows = db.select().from(trucks).where(eq(trucks.dayId, day.id)).orderBy(trucks.name).all();
    const crewRows = db
      .select({ crew: crews, company: companies })
      .from(crews)
      .leftJoin(companies, eq(companies.id, crews.companyId))
      .where(eq(crews.dayId, day.id))
      .orderBy(crews.number)
      .all();
    const loginUrl = `${config.publicUrl}/login`;
    const crewPages = await Promise.all(
      crewRows.map(async ({ crew, company }) => {
        const url = `${config.publicUrl}/j/${crew.token}`;
        const cc = ccs.find((c) => c.id === crew.ccId);
        return {
          crewId: crew.id,
          name: crewLabel(crew),
          companyName: company?.name ?? null,
          leadName: crew.leadName,
          ccName: cc?.name ?? null,
          ccAddress: cc?.address ?? null,
          url,
          qrSvg: await QRCode.toString(url, { type: "svg", margin: 1, errorCorrectionLevel: "M" }),
          greenShirts: shirts.filter((g) => g.ccId === crew.ccId).map((g) => ({ name: g.name, phone: g.phone, roleLabel: g.roleLabel })),
        };
      }),
    );
    const ccPages = await Promise.all(
      ccs.map(async (cc) => ({
        ccId: cc.id,
        name: cc.name,
        address: cc.address,
        greenCode: codes.find((g) => g.ccId === cc.id)?.code ?? null,
        loginUrl,
        loginQrSvg: await QRCode.toString(loginUrl, { type: "svg", margin: 1 }),
        trucks: truckRows.filter((t) => t.ccId === cc.id).map((t) => ({ name: t.name, driverName: t.driverName, code: t.code })),
        greenShirts: shirts.filter((g) => g.ccId === cc.id).map((g) => ({ name: g.name, phone: g.phone, roleLabel: g.roleLabel })),
      })),
    );
    return { day, crewPages, ccPages };
  }),
});

const exportRouter = router({
  requests: adminProcedure.input(z.object({ eventId: id.nullish() }).optional()).query(({ input }) => {
    const eventId = eventOrActive(input?.eventId);
    const dayIds = db.select({ id: days.id }).from(days).where(eq(days.eventId, eventId)).all().map((d) => d.id);
    if (dayIds.length === 0) return toCsv([]);
    const rows = requestViews(db.select().from(requests).where(inArray(requests.dayId, dayIds)).orderBy(requests.createdAt).all());
    return toCsv(
      rows.map((r) => ({
        id: r.id,
        day_id: r.dayId,
        cc_id: r.ccId,
        crew: r.crewName,
        company: r.companyName,
        label: r.label,
        item: r.typeLabel,
        qty: r.qty,
        note: r.note,
        created_by: r.createdBy,
        status: r.status,
        truck: r.truckName,
        created_at: iso(r.createdAt),
        assigned_at: iso(r.assignedAt),
        en_route_at: iso(r.enRouteAt),
        delivered_at: iso(r.deliveredAt),
        cancelled_at: iso(r.cancelledAt),
        cancelled_by: r.cancelledBy,
        cancel_note: r.cancelNote,
        lat: r.lat,
        lng: r.lng,
      })),
    );
  }),
  lots: adminProcedure.input(z.object({ eventId: id.nullish() }).optional()).query(({ input }) => {
    const rows = db.select().from(lots).where(eq(lots.eventId, eventOrActive(input?.eventId))).all();
    return toCsv(
      rows.map((l) => ({
        id: l.id,
        parcel_id: l.parcelId,
        address: l.address,
        lat: l.lat,
        lng: l.lng,
        source: l.source,
        cc_id: l.ccId,
        crew_id: l.crewId,
        status: l.status,
        status_at: iso(l.statusAt),
        note: l.note,
      })),
    );
  }),
  positions: adminProcedure.input(z.object({ eventId: id.nullish() }).optional()).query(({ input }) => {
    const eventId = eventOrActive(input?.eventId);
    const dayIds = db.select({ id: days.id }).from(days).where(eq(days.eventId, eventId)).all().map((d) => d.id);
    if (dayIds.length === 0) return toCsv([]);
    const crewIds = db.select({ id: crews.id }).from(crews).where(inArray(crews.dayId, dayIds)).all().map((c) => c.id);
    const truckIds = db.select({ id: trucks.id }).from(trucks).where(inArray(trucks.dayId, dayIds)).all().map((t) => t.id);
    const rows = [
      ...(crewIds.length ? db.select().from(positions).where(and(eq(positions.kind, "crew"), inArray(positions.refId, crewIds))).all() : []),
      ...(truckIds.length ? db.select().from(positions).where(and(eq(positions.kind, "truck"), inArray(positions.refId, truckIds))).all() : []),
    ].sort((a, b) => a.at - b.at);
    return toCsv(rows.map((p) => ({ kind: p.kind, ref_id: p.refId, lat: p.lat, lng: p.lng, accuracy: p.accuracy, heading: p.heading, speed: p.speed, at: iso(p.at) })));
  }),
  stockMoves: adminProcedure.input(z.object({ eventId: id.nullish() }).optional()).query(({ input }) => {
    const eventId = eventOrActive(input?.eventId);
    const rows = db
      .select({ m: stockMoves, truck: trucks, type: requestTypes, day: days })
      .from(stockMoves)
      .innerJoin(trucks, eq(trucks.id, stockMoves.truckId))
      .innerJoin(requestTypes, eq(requestTypes.id, stockMoves.typeId))
      .innerJoin(days, eq(days.id, trucks.dayId))
      .where(eq(days.eventId, eventId))
      .orderBy(stockMoves.at)
      .all();
    return toCsv(
      rows.map(({ m, truck, type, day }) => ({
        id: m.id,
        day: day.label,
        truck: truck.name,
        item: type.label,
        delta: m.delta,
        reason: m.reason,
        request_id: m.requestId,
        at: iso(m.at),
      })),
    );
  }),
});
// #endregion

export const adminRouter = router({
  events: eventsRouter,
  days: daysRouter,
  ccs: ccsRouter,
  greenShirts: greenShirtsRouter,
  greenCodes: greenCodesRouter,
  trucks: trucksRouter,
  companies: companiesRouter,
  crews: crewsRouter,
  catalog: catalogRouter,
  lots: lotsRouter,
  print: printRouter,
  export: exportRouter,
  /** Active event with its days, for the Event screen header. */
  overview: adminProcedure.query(() => {
    const ev = activeEvent() ?? null;
    return { event: ev, days: ev ? db.select().from(days).where(eq(days.eventId, ev.id)).orderBy(days.sort).all() : [] };
  }),
});
