import { TRPCError } from "@trpc/server";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import Papa from "papaparse";
import { z } from "zod";
import { newCrewToken, uniqueCode } from "../auth.ts";
import { bus, type BusMessage } from "../bus.ts";
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
  lotPhotos,
  lots,
  positions,
  requests,
  requestTypes,
  sessions,
  stockMoves,
  trucks,
  truckStock,
  LOT_STATUSES,
  UNITS,
  type CommandCenter,
  type Event,
} from "../db/schema.ts";
import { crewLabel, emitStock, scheduleRoute, stockFor, sweepOpen } from "../dispatch.ts";
import { ringBBox, type Ring } from "../geo.ts";
import {
  addManualLot,
  assignLotIdsToCc,
  assignLotsToCcInArea,
  countVacantParcels,
  emitLot,
  importDlba,
  importLotsCsv,
  importVacantParcels,
  parcelAtPoint,
} from "../lots-import.ts";
import { eventPhotos, filterPairs, photoFileNames, photoPairs, sweepPhotoFiles } from "../photos.ts";
import { activeEvent, catalogFor, requestViews } from "../queries.ts";
import { copySetupFromPreviousDay, createCc, createCrew, createEvent, createTruck, setActiveEvent, stockTypeOnTrucks } from "../setup.ts";
import { adminProcedure, liveFor, readAdmin, router } from "../trpc.ts";

// #region helpers
/** A drawn rectangle as a GeoJSON ring of [lng, lat] pairs. */
const ringInput = z.array(z.tuple([z.number(), z.number()])).min(4).max(64);
/** Imports refuse a rectangle wider than about 25 km either way. */
const checkImportRing = (ring: Ring): Ring => {
  const [w, s, e, n] = ringBBox(ring);
  if (e - w > 0.3 || n - s > 0.3) throw new TRPCError({ code: "BAD_REQUEST", message: "Area too large" });
  return ring;
};
const phone = z.string().trim().max(40).nullish();
const id = z.number().int();

const requireActive = (): Event => {
  const ev = activeEvent();
  if (!ev) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "No active event" });
  return ev;
};

const eventOrActive = (eventId: number | null | undefined): number => eventId ?? requireActive().id;

const notFound = (what: string): TRPCError => new TRPCError({ code: "NOT_FOUND", message: `${what} not found` });

const getCcOrThrow = (ccId: number): CommandCenter => {
  const cc = db.select().from(commandCenters).where(eq(commandCenters.id, ccId)).get();
  if (!cc) throw notFound("Command center");
  return cc;
};

/** Event id of a CC, through its day. */
const eventOfCc = (cc: CommandCenter): number => {
  const d = db.select({ eventId: days.eventId }).from(days).where(eq(days.id, cc.dayId)).get();
  if (!d) throw notFound("Day");
  return d.eventId;
};

const countBy = <K extends string | number>(rows: ReadonlyArray<{ k: K | null; n: number }>): Map<K, number> => {
  const m = new Map<K, number>();
  for (const r of rows) if (r.k !== null) m.set(r.k, r.n);
  return m;
};

/** Per-day counts of CCs, crews and trucks. */
const dayCounts = (dayIds: readonly number[]) => {
  if (dayIds.length === 0) return { ccs: new Map<number, number>(), crews: new Map<number, number>(), trucks: new Map<number, number>() };
  return {
    ccs: countBy(db.select({ k: commandCenters.dayId, n: sql<number>`count(*)` }).from(commandCenters).where(inArray(commandCenters.dayId, dayIds)).groupBy(commandCenters.dayId).all()),
    crews: countBy(db.select({ k: crews.dayId, n: sql<number>`count(*)` }).from(crews).where(inArray(crews.dayId, dayIds)).groupBy(crews.dayId).all()),
    trucks: countBy(db.select({ k: trucks.dayId, n: sql<number>`count(*)` }).from(trucks).where(inArray(trucks.dayId, dayIds)).groupBy(trucks.dayId).all()),
  };
};

const withDayCounts = <D extends { id: number }>(rows: readonly D[]) => {
  const c = dayCounts(rows.map((d) => d.id));
  return rows.map((d) => ({ ...d, ccCount: c.ccs.get(d.id) ?? 0, crewCount: c.crews.get(d.id) ?? 0, truckCount: c.trucks.get(d.id) ?? 0 }));
};

/** "water", "gas_mower": lowercase words joined by underscores, unique within the event. */
const keyFor = (eventId: number, label: string): string => {
  const base = label.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 32) || "item";
  const taken = new Set(db.select({ key: requestTypes.key }).from(requestTypes).where(eq(requestTypes.eventId, eventId)).all().map((r) => r.key));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}_${i}`)) return `${base}_${i}`;
};

type Cell = string | number | boolean | null;

/** CSV with a fixed header, so an empty export still names its columns. */
const toCsv = <F extends string>(fields: readonly F[], rows: ReadonlyArray<Record<F, Cell>>): string =>
  Papa.unparse({ fields: [...fields], data: rows.map((r) => fields.map((f) => r[f])) });

/** Day labels and CC names of an event, for export columns. */
const eventNames = (eventId: number) => {
  const dayRows = db.select().from(days).where(eq(days.eventId, eventId)).all();
  const dayIds = dayRows.map((d) => d.id);
  const ccRows = dayIds.length ? db.select().from(commandCenters).where(inArray(commandCenters.dayId, dayIds)).all() : [];
  return {
    dayIds,
    day: new Map(dayRows.map((d) => [d.id, d.label])),
    date: new Map(dayRows.map((d) => [d.id, d.date])),
    cc: new Map(ccRows.map((c) => [c.id, c.name])),
  };
};

const DETROIT = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "America/Detroit",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

/** Detroit local time, "2026-09-28 14:05:09", for exports. */
const iso = (ms: number | null): string => (ms === null ? "" : DETROIT.format(new Date(ms)));
// #endregion

// #region events and days
const eventsRouter = router({
  /** Every event, newest first, with its first and last day. */
  list: adminProcedure.query(() => {
    const evs = db.select().from(events).orderBy(sql`${events.year} desc`, sql`${events.id} desc`).all();
    const ranges = db
      .select({ eventId: days.eventId, first: sql<string>`min(${days.date})`, last: sql<string>`max(${days.date})`, n: sql<number>`count(*)` })
      .from(days)
      .groupBy(days.eventId)
      .all();
    return evs.map((e) => {
      const r = ranges.find((x) => x.eventId === e.id);
      return { ...e, dayCount: r?.n ?? 0, firstDate: r?.first ?? null, lastDate: r?.last ?? null };
    });
  }),
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
    return withDayCounts(db.select().from(days).where(eq(days.eventId, eventId)).orderBy(days.sort).all());
  }),
  /** Everything the Day screen edits. */
  get: adminProcedure.input(z.object({ id })).query(({ input }) => {
    const day = db.select().from(days).where(eq(days.id, input.id)).get();
    if (!day) throw notFound("Day");
    const ccs = db.select().from(commandCenters).where(eq(commandCenters.dayId, day.id)).orderBy(commandCenters.name).all();
    const ccIds = ccs.map((c) => c.id);
    const shirts = ccIds.length ? db.select().from(greenShirts).where(inArray(greenShirts.ccId, ccIds)).orderBy(greenShirts.id).all() : [];
    const codes = ccIds.length ? db.select().from(greenCodes).where(inArray(greenCodes.ccId, ccIds)).all() : [];
    const truckRows = db.select().from(trucks).where(eq(trucks.dayId, day.id)).orderBy(trucks.name).all();
    const crewCounts = countBy(
      db.select({ k: crews.ccId, n: sql<number>`count(*)` }).from(crews).where(eq(crews.dayId, day.id)).groupBy(crews.ccId).all(),
    );
    const siblings = db.select().from(days).where(eq(days.eventId, day.eventId)).orderBy(days.sort).all();
    const prev = siblings.filter((d) => d.sort < day.sort).at(-1) ?? null;
    const prevCcCount = prev
      ? (db.select({ n: sql<number>`count(*)` }).from(commandCenters).where(eq(commandCenters.dayId, prev.id)).get()?.n ?? 0)
      : 0;
    return {
      day,
      days: siblings,
      previous: prev ? { id: prev.id, label: prev.label, ccCount: prevCcCount } : null,
      catalog: catalogFor(day.eventId, true),
      ccs: ccs.map((cc) => ({
        ...cc,
        crewCount: crewCounts.get(cc.id) ?? 0,
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
  /** Only into an empty day, so a second tap never doubles the setup. */
  copyFromPrevious: adminProcedure.input(z.object({ id })).mutation(({ input }) => {
    const existing = db.select({ n: sql<number>`count(*)` }).from(commandCenters).where(eq(commandCenters.dayId, input.id)).get();
    if ((existing?.n ?? 0) > 0) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Day already has command centers" });
    return copySetupFromPreviousDay(input.id);
  }),
});
// #endregion

// #region command centers, green shirts, codes, trucks
/** A CC's letter for the day ("A"): one letter or digit, stored upper case; empty clears it. */
const ccLetter = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9]?$/, "One letter or digit")
  .transform((v) => v.toUpperCase())
  .nullish();

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
    .input(
      z.object({
        dayId: id,
        name: z.string().trim().min(1).max(80),
        lat: z.number().min(-90).max(90),
        lng: z.number().min(-180).max(180),
        address: z.string().trim().max(200).nullish(),
        notes: z.string().max(1000).nullish(),
        letter: ccLetter,
      }),
    )
    .mutation(({ input }) => {
      if (!db.select({ id: days.id }).from(days).where(eq(days.id, input.dayId)).get()) throw notFound("Day");
      return createCc({ ...input, address: input.address || null, letter: input.letter || null });
    }),
  /** Street address of the parcel under a point, to prefill a new CC. Null when none or the city layer is down. */
  addressAt: adminProcedure.input(z.object({ lat: z.number(), lng: z.number() })).query(async ({ input }) => {
    try {
      const p = await parcelAtPoint(input.lat, input.lng, { timeoutMs: 6000 });
      return { address: p?.address ?? null };
    } catch {
      return { address: null };
    }
  }),
  update: adminProcedure
    .input(
      z.object({
        id,
        name: z.string().trim().min(1).max(80).optional(),
        lat: z.number().optional(),
        lng: z.number().optional(),
        address: z.string().max(200).nullish(),
        notes: z.string().max(1000).nullish(),
        letter: ccLetter,
      }),
    )
    .mutation(({ input }) => {
      const { id: ccId, letter, ...rest } = input;
      const set = letter === undefined ? rest : { ...rest, letter: letter || null };
      return db.update(commandCenters).set(set).where(eq(commandCenters.id, ccId)).returning().get();
    }),
  delete: adminProcedure.input(z.object({ id })).mutation(({ input }) => {
    db.delete(commandCenters).where(eq(commandCenters.id, input.id)).run();
    bus.checkScopes();
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
    // A new code exists to lock out whoever holds the old one.
    db.delete(sessions).where(and(eq(sessions.role, "green"), eq(sessions.ccId, input.ccId))).run();
    bus.checkScopes();
    return { code };
  }),
});

/** Puts a truck's assigned and en route requests back to open. Call `afterReopen` once the truck change is saved. */
const reopenStops = (truckId: number) =>
  db
    .update(requests)
    .set({ status: "open", truckId: null, assignedAt: null, enRouteAt: null })
    .where(and(eq(requests.truckId, truckId), inArray(requests.status, ["assigned", "en_route"])))
    .returning()
    .all();

const afterReopen = (reopened: ReturnType<typeof reopenStops>, truck: { ccId: number; dayId: number }): void => {
  for (const request of reopened) bus.emit("request.changed", { ccId: request.ccId, dayId: request.dayId }, { request });
  if (reopened.length > 0) sweepOpen(truck.ccId, truck.dayId);
};

const trucksRouter = router({
  create: adminProcedure
    .input(z.object({ ccId: id, name: z.string().trim().min(1).max(40), driverName: z.string().trim().max(80).nullish(), driverPhone: phone }))
    .mutation(({ input }) => {
      const cc = getCcOrThrow(input.ccId);
      return createTruck({ ...input, dayId: cc.dayId, driverName: input.driverName || null, driverPhone: input.driverPhone || null });
    }),
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
      const current = db.select().from(trucks).where(eq(trucks.id, tid)).get();
      if (!current) throw notFound("Truck");
      if (set.ccId !== undefined && getCcOrThrow(set.ccId).dayId !== current.dayId) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Command center is on another day" });
      }
      const moving = set.ccId !== undefined && set.ccId !== current.ccId;
      // Stops belong to the old CC; they go back to open there.
      const reopened = moving ? reopenStops(tid) : [];
      const t = db.update(trucks).set(set).where(eq(trucks.id, tid)).returning().get();
      // Push to a CC goes by sessions.cc_id; the driver's phones follow the truck.
      if (moving) {
        db.update(sessions).set({ ccId: t.ccId }).where(eq(sessions.truckId, tid)).run();
        // Open streams switch to the new CC before the reopened stops go out.
        bus.checkScopes();
      }
      afterReopen(reopened, current);
      // Back from offline: it can take what sat open while it was off.
      if (current.status === "offline" && t.status !== "offline") sweepOpen(t.ccId, t.dayId);
      scheduleRoute(tid);
      return t;
    }),
  /** Also signs out every phone that used the old code. */
  regenerateCode: adminProcedure.input(z.object({ id })).mutation(({ input }) => {
    const t = db.update(trucks).set({ code: uniqueCode() }).where(eq(trucks.id, input.id)).returning().get();
    db.delete(sessions).where(eq(sessions.truckId, input.id)).run();
    bus.checkScopes();
    return t;
  }),
  setCapacity: adminProcedure
    .input(z.object({ truckId: id, typeId: id, capacity: z.number().int().min(0).max(1000) }))
    .mutation(({ input }) => {
      db.insert(truckStock)
        .values({ truckId: input.truckId, typeId: input.typeId, qty: input.capacity, capacity: input.capacity })
        .onConflictDoUpdate({ target: [truckStock.truckId, truckStock.typeId], set: { capacity: input.capacity } })
        .run();
      return stockFor(input.truckId);
    }),
  /** Its assigned and en route requests go back to open first, then to whichever truck is nearest. */
  delete: adminProcedure.input(z.object({ id })).mutation(({ input }) => {
    const truck = db.select().from(trucks).where(eq(trucks.id, input.id)).get();
    if (!truck) throw notFound("Truck");
    const reopened = reopenStops(truck.id);
    db.delete(trucks).where(eq(trucks.id, truck.id)).run();
    bus.checkScopes();
    afterReopen(reopened, truck);
    return { ok: true, reopened: reopened.length };
  }),
});
// #endregion

// #region companies and crews
const companiesRouter = router({
  /** Companies of the event with crew and volunteer totals across its days. */
  list: adminProcedure.input(z.object({ eventId: id.nullish() }).optional()).query(({ input }) => {
    const eventId = eventOrActive(input?.eventId);
    const rows = db.select().from(companies).where(eq(companies.eventId, eventId)).orderBy(sql`lower(${companies.name})`).all();
    const ids = rows.map((c) => c.id);
    const stats = ids.length
      ? db
          .select({ companyId: crews.companyId, n: sql<number>`count(*)`, people: sql<number>`coalesce(sum(${crews.headcount}), 0)` })
          .from(crews)
          .where(inArray(crews.companyId, ids))
          .groupBy(crews.companyId)
          .all()
      : [];
    return rows.map((c) => {
      const st = stats.find((x) => x.companyId === c.id);
      return { ...c, crewCount: st?.n ?? 0, headcount: st?.people ?? 0 };
    });
  }),
  create: adminProcedure.input(z.object({ name: z.string().trim().min(1).max(100), short: z.string().trim().max(16).nullish(), eventId: id.nullish() })).mutation(({ input }) => {
    const eventId = eventOrActive(input.eventId);
    const dup = db
      .select({ id: companies.id })
      .from(companies)
      .where(and(eq(companies.eventId, eventId), sql`lower(${companies.name}) = ${input.name.toLowerCase()}`))
      .get();
    if (dup) throw new TRPCError({ code: "CONFLICT", message: "Company already listed" });
    return db.insert(companies).values({ eventId, name: input.name, short: input.short || null }).returning().get();
  }),
  /** Name and the short used for crew names ("GM" makes "GM 1"); an empty short falls back to the first word. */
  update: adminProcedure
    .input(z.object({ id, name: z.string().trim().min(1).max(100), short: z.string().trim().max(16).nullish() }))
    .mutation(({ input }) => {
      const set = input.short === undefined ? { name: input.name } : { name: input.name, short: input.short || null };
      const r = db.update(companies).set(set).where(eq(companies.id, input.id)).returning().get();
      if (!r) throw notFound("Company");
      return r;
    }),
  delete: adminProcedure.input(z.object({ id })).mutation(({ input }) => {
    db.delete(companies).where(eq(companies.id, input.id)).run();
    return { ok: true };
  }),
});

const crewInput = z.object({
  ccId: id,
  companyId: id.nullable(),
  leadName: z.string().trim().max(80).nullish(),
  leadPhone: phone,
  headcount: z.number().int().min(0).max(500).nullish(),
  notes: z.string().max(1000).nullish(),
});

/**
 * A crew now at another CC: its lot assignments at the old CC end, and its
 * phones' sessions follow it, since push to a CC goes by sessions.cc_id.
 */
const afterCrewMoved = (crewId: number, ccId: number): void => {
  db.update(lots).set({ crewId: null }).where(eq(lots.crewId, crewId)).run();
  db.update(sessions).set({ ccId }).where(eq(sessions.crewId, crewId)).run();
  bus.checkScopes();
};

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
  create: adminProcedure.input(crewInput).mutation(({ input }) => {
    const cc = getCcOrThrow(input.ccId);
    return createCrew({ ...input, dayId: cc.dayId, leadName: input.leadName || null, leadPhone: input.leadPhone || null });
  }),
  /** Moving a crew to another CC moves it to that CC's day and clears its lot assignments at the old CC. */
  update: adminProcedure.input(crewInput.partial().extend({ id })).mutation(({ input }) => {
    const { id: cid, ...set } = input;
    const current = db.select().from(crews).where(eq(crews.id, cid)).get();
    if (!current) throw notFound("Crew");
    const patch: Partial<typeof crews.$inferInsert> = { ...set };
    if (set.leadName !== undefined) patch.leadName = set.leadName || null;
    if (set.leadPhone !== undefined) patch.leadPhone = set.leadPhone || null;
    const moving = set.ccId !== undefined && set.ccId !== current.ccId;
    if (moving && set.ccId !== undefined) patch.dayId = getCcOrThrow(set.ccId).dayId;
    const row = db.update(crews).set(patch).where(eq(crews.id, cid)).returning().get();
    if (moving) afterCrewMoved(cid, row.ccId);
    return row;
  }),
  delete: adminProcedure.input(z.object({ id })).mutation(({ input }) => {
    db.delete(crews).where(eq(crews.id, input.id)).run();
    bus.checkScopes();
    return { ok: true };
  }),
  /** Also signs out every phone that joined with the old link. */
  regenerateToken: adminProcedure.input(z.object({ id })).mutation(({ input }) => {
    const row = db.update(crews).set({ token: newCrewToken() }).where(eq(crews.id, input.id)).returning().get();
    db.delete(sessions).where(eq(sessions.crewId, input.id)).run();
    bus.checkScopes();
    return row;
  }),
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
    let updated = 0;
    const errors: string[] = [];
    parsed.data.forEach((r, i) => {
      const line = i + 2;
      const day = findDay(r.day ?? "");
      if (!day) {
        errors.push(`Row ${line}: day "${(r.day ?? "").trim()}" not found`);
        return;
      }
      const ccName = (r.cc ?? "").trim().toLowerCase().replace(/^cc\s+/, "");
      const cc = db
        .select()
        .from(commandCenters)
        .where(and(eq(commandCenters.dayId, day.id), sql`lower(${commandCenters.name}) = ${ccName}`))
        .get();
      const onlyCc = ccName === "" ? db.select().from(commandCenters).where(eq(commandCenters.dayId, day.id)).all() : [];
      const target = cc ?? (onlyCc.length === 1 ? onlyCc[0] : undefined);
      if (!target) {
        errors.push(`Row ${line}: CC "${(r.cc ?? "").trim()}" not found on ${day.label}`);
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
      const fields = {
        ccId: target.id,
        companyId,
        leadName: r.lead_name?.trim() || null,
        leadPhone: r.lead_phone?.trim() || null,
        headcount: Number.isFinite(head) && r.headcount?.trim() ? head : null,
      };
      // Same day, same company, same lead (phone digits or name, any case): the row updates
      // that crew, so a corrected CSV imported twice never doubles the crews.
      const digits = (v: string | null) => (v ?? "").replace(/\D/g, "");
      const existing = db
        .select()
        .from(crews)
        .where(and(eq(crews.dayId, day.id), companyId === null ? isNull(crews.companyId) : eq(crews.companyId, companyId)))
        .all()
        .find(
          (c) =>
            (digits(fields.leadPhone) !== "" && digits(c.leadPhone) === digits(fields.leadPhone)) ||
            (fields.leadName !== null && (c.leadName ?? "").toLowerCase() === fields.leadName.toLowerCase()),
        );
      if (existing) {
        db.update(crews).set(fields).where(eq(crews.id, existing.id)).run();
        if (existing.ccId !== fields.ccId) afterCrewMoved(existing.id, fields.ccId);
        updated++;
      } else {
        createCrew({ dayId: day.id, ...fields });
        added++;
      }
    });
    return { added, updated, errors };
  }),
});
// #endregion

// #region catalog
/** Trucks set up before a tracked item existed get a full row of it; their drivers' stock refetches. */
const afterStockTypeChange = (typeId: number): void => {
  for (const truckId of stockTypeOnTrucks(typeId)) emitStock(truckId);
};

const catalogRouter = router({
  list: adminProcedure.input(z.object({ eventId: id.nullish() }).optional()).query(({ input }) => catalogFor(eventOrActive(input?.eventId), true)),
  create: adminProcedure
    .input(
      z.object({
        eventId: id.nullish(),
        key: z.string().trim().min(1).max(40).regex(/^[a-z0-9_]+$/).optional(),
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
      const { eventId: _e, key, ...rest } = input;
      const row = db
        .insert(requestTypes)
        .values({ ...rest, key: key ?? keyFor(eventId, input.label), eventId, sort: (last?.n ?? 0) + 1, active: true })
        .returning()
        .get();
      afterStockTypeChange(row.id);
      return row;
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
      const row = db.update(requestTypes).set(set).where(eq(requestTypes.id, tid)).returning().get();
      afterStockTypeChange(tid);
      return row;
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
  /** Every lot of the event with its crew's number. */
  list: adminProcedure.input(z.object({ eventId: id.nullish() }).optional()).query(({ input }) =>
    db
      .select({ lot: lots, crewNumber: crews.number })
      .from(lots)
      .leftJoin(crews, eq(crews.id, lots.crewId))
      .where(eq(lots.eventId, eventOrActive(input?.eventId)))
      .all()
      .map(({ lot, crewNumber }) => ({ ...lot, crewNumber })),
  ),
  counts: adminProcedure.input(z.object({ eventId: id.nullish() }).optional()).query(({ input }) => {
    const eventId = eventOrActive(input?.eventId);
    const bySource = db.select({ source: lots.source, n: sql<number>`count(*)` }).from(lots).where(eq(lots.eventId, eventId)).groupBy(lots.source).all();
    const byStatus = db.select({ status: lots.status, n: sql<number>`count(*)` }).from(lots).where(eq(lots.eventId, eventId)).groupBy(lots.status).all();
    const unassigned = db.select({ n: sql<number>`count(*)` }).from(lots).where(and(eq(lots.eventId, eventId), sql`${lots.ccId} is null`)).get();
    return { bySource, byStatus, unassigned: unassigned?.n ?? 0 };
  }),
  /** Land Bank lots in the drawn rectangle; with `ccId`, lots in it that have no CC go to that CC. */
  importDlba: adminProcedure
    .input(z.object({ ring: ringInput, ccId: id.nullish(), eventId: id.nullish(), limit: z.number().int().min(1).max(20000).optional() }))
    .mutation(async ({ input }) => {
      const ring = checkImportRing(input.ring);
      const eventId = eventOrActive(input.eventId);
      if (input.ccId != null && eventOfCc(getCcOrThrow(input.ccId)) !== eventId) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Command center is in another event" });
      }
      let res: Awaited<ReturnType<typeof importDlba>>;
      try {
        res = await importDlba(eventId, ring, { limit: input.limit });
      } catch (err) {
        throw new TRPCError({ code: "BAD_GATEWAY", message: "Land Bank unavailable", cause: err });
      }
      const assigned = input.ccId != null ? assignLotsToCcInArea(eventId, ring, input.ccId, true) : 0;
      return { ...res, assigned };
    }),
  /** Residential vacant parcels touching the drawn rectangle, counted before an import. */
  countVacant: adminProcedure.input(z.object({ ring: ringInput })).query(async ({ input }) => {
    const ring = checkImportRing(input.ring);
    try {
      return { count: await countVacantParcels(ring) };
    } catch (err) {
      throw new TRPCError({ code: "BAD_GATEWAY", message: "Parcel layer unavailable", cause: err });
    }
  }),
  /** Residential vacant parcels whose centre is in the drawn rectangle. */
  importVacant: adminProcedure
    .input(z.object({ ring: ringInput, ccId: id.nullish(), eventId: id.nullish(), limit: z.number().int().min(1).max(20000).optional() }))
    .mutation(async ({ input }) => {
      const ring = checkImportRing(input.ring);
      const eventId = eventOrActive(input.eventId);
      if (input.ccId != null && eventOfCc(getCcOrThrow(input.ccId)) !== eventId) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Command center is in another event" });
      }
      let res: Awaited<ReturnType<typeof importVacantParcels>>;
      try {
        res = await importVacantParcels(eventId, ring, { limit: input.limit });
      } catch (err) {
        throw new TRPCError({ code: "BAD_GATEWAY", message: "Parcel layer unavailable", cause: err });
      }
      const assigned = input.ccId != null ? assignLotsToCcInArea(eventId, ring, input.ccId, true) : 0;
      return { ...res, assigned };
    }),
  importCsv: adminProcedure
    .input(z.object({ csv: z.string().max(5_000_000), ccId: id.nullish(), eventId: id.nullish() }))
    .mutation(async ({ input }) => {
      const eventId = eventOrActive(input.eventId);
      if (input.ccId != null && eventOfCc(getCcOrThrow(input.ccId)) !== eventId) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Command center is in another event" });
      }
      return importLotsCsv(eventId, input.csv, {}, input.ccId ?? null);
    }),
  add: adminProcedure
    .input(z.object({ lat: z.number(), lng: z.number(), address: z.string().max(200).nullish(), ccId: id.nullish(), eventId: id.nullish() }))
    .mutation(({ input }) => addManualLot(eventOrActive(input.eventId), input)),
  /** The selected lots go to the CC (or to none). A move to another site clears the crew; between days of one site it stays. */
  assignCc: adminProcedure.input(z.object({ ids: z.array(id).min(1).max(20000), ccId: id.nullable(), eventId: id.nullish() })).mutation(({ input }) => {
    const eventId = eventOrActive(input.eventId);
    if (input.ccId !== null && eventOfCc(getCcOrThrow(input.ccId)) !== eventId) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "Command center is in another event" });
    }
    return { updated: assignLotIdsToCc(eventId, input.ids, input.ccId) };
  }),
  /** One lot: CC, address, note, status. A new CC clears the crew. */
  update: adminProcedure
    .input(
      z.object({
        id,
        ccId: id.nullable().optional(),
        address: z.string().trim().max(200).nullish(),
        note: z.string().trim().max(1000).nullish(),
        status: z.enum(LOT_STATUSES).optional(),
      }),
    )
    .mutation(({ input }) => {
      const lot = db.select().from(lots).where(eq(lots.id, input.id)).get();
      if (!lot) throw notFound("Lot");
      const patch: Partial<typeof lots.$inferInsert> = {};
      if (input.ccId !== undefined && input.ccId !== lot.ccId) {
        if (input.ccId !== null && eventOfCc(getCcOrThrow(input.ccId)) !== lot.eventId) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Command center is in another event" });
        }
        patch.ccId = input.ccId;
        patch.crewId = null;
      }
      if (input.address !== undefined) patch.address = input.address || null;
      if (input.note !== undefined) patch.note = input.note || null;
      if (input.status !== undefined && input.status !== lot.status) {
        patch.status = input.status;
        patch.statusAt = Date.now();
        patch.statusByCrewId = null;
      }
      if (Object.keys(patch).length === 0) return lot;
      const next = db.update(lots).set(patch).where(eq(lots.id, lot.id)).returning().get();
      emitLot(next);
      return next;
    }),
  delete: adminProcedure.input(z.object({ ids: z.array(id).min(1).max(5000) })).mutation(({ input }) => {
    const r = db.delete(lots).where(inArray(lots.id, input.ids)).returning({ id: lots.id }).all();
    sweepPhotoFiles();
    return { deleted: r.length };
  }),
});
// #endregion

// #region print and export
const exportRouter = router({
  /** Row counts for each download, for the active event. */
  counts: adminProcedure.input(z.object({ eventId: id.nullish() }).optional()).query(({ input }) => {
    const eventId = eventOrActive(input?.eventId);
    const dayIds = db.select({ id: days.id }).from(days).where(eq(days.eventId, eventId)).all().map((d) => d.id);
    const n = (q: { n: number } | undefined): number => q?.n ?? 0;
    const photos = n(
      db
        .select({ n: sql<number>`count(*)` })
        .from(lotPhotos)
        .innerJoin(lots, eq(lots.id, lotPhotos.lotId))
        .where(and(eq(lots.eventId, eventId), isNull(lotPhotos.deletedAt)))
        .get(),
    );
    if (dayIds.length === 0) {
      return { requests: 0, lots: n(db.select({ n: sql<number>`count(*)` }).from(lots).where(eq(lots.eventId, eventId)).get()), positions: 0, stockMoves: 0, photos };
    }
    const crewIds = db.select({ id: crews.id }).from(crews).where(inArray(crews.dayId, dayIds)).all().map((c) => c.id);
    const truckIds = db.select({ id: trucks.id }).from(trucks).where(inArray(trucks.dayId, dayIds)).all().map((t) => t.id);
    const posCount = (kind: "crew" | "truck", ids: number[]): number =>
      ids.length ? n(db.select({ n: sql<number>`count(*)` }).from(positions).where(and(eq(positions.kind, kind), inArray(positions.refId, ids))).get()) : 0;
    return {
      requests: n(db.select({ n: sql<number>`count(*)` }).from(requests).where(inArray(requests.dayId, dayIds)).get()),
      lots: n(db.select({ n: sql<number>`count(*)` }).from(lots).where(eq(lots.eventId, eventId)).get()),
      positions: posCount("crew", crewIds) + posCount("truck", truckIds),
      stockMoves: truckIds.length ? n(db.select({ n: sql<number>`count(*)` }).from(stockMoves).where(inArray(stockMoves.truckId, truckIds)).get()) : 0,
      photos,
    };
  }),
  requests: adminProcedure.input(z.object({ eventId: id.nullish() }).optional()).query(({ input }) => {
    const names = eventNames(eventOrActive(input?.eventId));
    const fields = [
      "id", "day", "date", "cc", "crew", "company", "label", "item", "qty", "note", "created_by", "status", "truck",
      "created_at", "assigned_at", "en_route_at", "delivered_at", "cancelled_at", "cancelled_by", "cancel_note", "lat", "lng",
    ] as const;
    if (names.dayIds.length === 0) return toCsv(fields, []);
    const rows = requestViews(db.select().from(requests).where(inArray(requests.dayId, names.dayIds)).orderBy(requests.createdAt).all());
    return toCsv(
      fields,
      rows.map((r) => ({
        id: r.id,
        day: names.day.get(r.dayId) ?? "",
        date: names.date.get(r.dayId) ?? "",
        cc: names.cc.get(r.ccId) ?? "",
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
    const eventId = eventOrActive(input?.eventId);
    const names = eventNames(eventId);
    const rows = db
      .select({ lot: lots, crewNumber: crews.number, crewCompany: companies.name })
      .from(lots)
      .leftJoin(crews, eq(crews.id, lots.crewId))
      .leftJoin(companies, eq(companies.id, crews.companyId))
      .where(eq(lots.eventId, eventId))
      .orderBy(lots.id)
      .all();
    const ccDay = new Map(
      names.dayIds.length
        ? db.select({ id: commandCenters.id, dayId: commandCenters.dayId }).from(commandCenters).where(inArray(commandCenters.dayId, names.dayIds)).all().map((c) => [c.id, c.dayId])
        : [],
    );
    const fields = ["id", "parcel_id", "address", "lat", "lng", "source", "day", "cc", "crew", "company", "status", "status_at", "note"] as const;
    return toCsv(
      fields,
      rows.map(({ lot: l, crewNumber, crewCompany }) => ({
        id: l.id,
        parcel_id: l.parcelId,
        address: l.address,
        lat: l.lat,
        lng: l.lng,
        source: l.source,
        day: l.ccId !== null ? (names.day.get(ccDay.get(l.ccId) ?? -1) ?? "") : "",
        cc: l.ccId !== null ? (names.cc.get(l.ccId) ?? "") : "",
        crew: crewNumber !== null ? crewLabel({ number: crewNumber }) : "",
        company: crewCompany,
        status: l.status,
        status_at: iso(l.statusAt),
        note: l.note,
      })),
    );
  }),
  positions: adminProcedure.input(z.object({ eventId: id.nullish() }).optional()).query(({ input }) => {
    const names = eventNames(eventOrActive(input?.eventId));
    const fields = ["day", "cc", "kind", "name", "lat", "lng", "accuracy", "heading", "speed", "at"] as const;
    if (names.dayIds.length === 0) return toCsv(fields, []);
    const crewRows = db.select().from(crews).where(inArray(crews.dayId, names.dayIds)).all();
    const truckRows = db.select().from(trucks).where(inArray(trucks.dayId, names.dayIds)).all();
    const who = new Map<string, { name: string; dayId: number; ccId: number }>([
      ...crewRows.map((c) => [`crew:${c.id}`, { name: crewLabel(c), dayId: c.dayId, ccId: c.ccId }] as const),
      ...truckRows.map((t) => [`truck:${t.id}`, { name: t.name, dayId: t.dayId, ccId: t.ccId }] as const),
    ]);
    const crewIds = crewRows.map((c) => c.id);
    const truckIds = truckRows.map((t) => t.id);
    const rows = [
      ...(crewIds.length ? db.select().from(positions).where(and(eq(positions.kind, "crew"), inArray(positions.refId, crewIds))).all() : []),
      ...(truckIds.length ? db.select().from(positions).where(and(eq(positions.kind, "truck"), inArray(positions.refId, truckIds))).all() : []),
    ].sort((a, b) => a.at - b.at);
    return toCsv(
      fields,
      rows.map((p) => {
        const w = who.get(`${p.kind}:${p.refId}`);
        return {
          day: w ? (names.day.get(w.dayId) ?? "") : "",
          cc: w ? (names.cc.get(w.ccId) ?? "") : "",
          kind: p.kind,
          name: w?.name ?? "",
          lat: p.lat,
          lng: p.lng,
          accuracy: p.accuracy,
          heading: p.heading,
          speed: p.speed,
          at: iso(p.at),
        };
      }),
    );
  }),
  stockMoves: adminProcedure.input(z.object({ eventId: id.nullish() }).optional()).query(({ input }) => {
    const eventId = eventOrActive(input?.eventId);
    const rows = db
      .select({ m: stockMoves, truck: trucks, type: requestTypes, day: days, cc: commandCenters })
      .from(stockMoves)
      .innerJoin(trucks, eq(trucks.id, stockMoves.truckId))
      .innerJoin(requestTypes, eq(requestTypes.id, stockMoves.typeId))
      .innerJoin(days, eq(days.id, trucks.dayId))
      .innerJoin(commandCenters, eq(commandCenters.id, trucks.ccId))
      .where(eq(days.eventId, eventId))
      .orderBy(stockMoves.at)
      .all();
    const fields = ["id", "day", "cc", "truck", "item", "unit", "delta", "reason", "request_id", "at"] as const;
    return toCsv(
      fields,
      rows.map(({ m, truck, type, day, cc }) => ({
        id: m.id,
        day: day.label,
        cc: cc.name,
        truck: truck.name,
        item: type.label,
        unit: type.unit,
        delta: m.delta,
        reason: m.reason,
        request_id: m.requestId,
        at: iso(m.at),
      })),
    );
  }),
  /** One row per live photo; `file` is its name inside the zip download. */
  photos: adminProcedure.input(z.object({ eventId: id.nullish() }).optional()).query(({ input }) => {
    const eventId = eventOrActive(input?.eventId);
    const names = eventNames(eventId);
    const rows = eventPhotos(eventId);
    const files = photoFileNames(rows);
    const pairs = new Map(photoPairs(rows).map((p) => [p.lotId, p]));
    const fields = [
      "id", "file", "day", "cc", "lot_id", "parcel_id", "address", "kind", "taken_by", "role", "crew", "company",
      "taken_at", "lat", "lng", "width", "height", "bytes",
    ] as const;
    const crewIds = [...new Set(rows.map((p) => p.crewId).filter((x): x is number => x !== null))];
    const crewNum = new Map(crewIds.length ? db.select().from(crews).where(inArray(crews.id, crewIds)).all().map((c) => [c.id, c.number]) : []);
    return toCsv(
      fields,
      rows.map((p) => {
        const pair = pairs.get(p.lotId);
        const takerCrew = p.crewId !== null ? crewNum.get(p.crewId) : undefined;
        return {
          id: p.id,
          file: files.get(p.id) ?? "",
          day: p.dayId !== null ? (names.day.get(p.dayId) ?? "") : "",
          cc: p.ccId !== null ? (names.cc.get(p.ccId) ?? "") : "",
          lot_id: p.lotId,
          parcel_id: pair?.parcelId ?? "",
          address: pair?.address ?? "",
          kind: p.kind,
          taken_by: p.takenBy,
          role: p.role,
          crew: takerCrew !== undefined ? crewLabel({ number: takerCrew }) : (pair?.crewName ?? ""),
          company: pair?.companyName ?? "",
          taken_at: iso(p.at),
          lat: p.lat,
          lng: p.lng,
          width: p.width,
          height: p.height,
          bytes: p.bytes,
        };
      }),
    );
  }),
});
// #endregion

// #region photos
const photosRouter = router({
  /** Before and after pairs across the event, from photos taken on the day and at the CC row given. */
  list: adminProcedure
    .input(
      z
        .object({
          dayId: id.nullish(),
          ccId: id.nullish(),
          companyId: id.nullish(),
          crewId: id.nullish(),
          status: z.enum(LOT_STATUSES).nullish(),
          missingAfter: z.boolean().nullish(),
        })
        .optional(),
    )
    .query(({ input }) => {
      const eventId = requireActive().id;
      const all = photoPairs(eventPhotos(eventId, { dayId: input?.dayId, ccId: input?.ccId }));
      return { pairs: filterPairs(all, input ?? {}), total: all.length };
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
  export: exportRouter,
  photos: photosRouter,
  /** Active event with its days, for the Event screen header. */
  overview: adminProcedure.query(() => {
    const ev = activeEvent() ?? null;
    const dayRows = ev ? withDayCounts(db.select().from(days).where(eq(days.eventId, ev.id)).orderBy(days.sort).all()) : [];
    const lotCount = ev ? (db.select({ n: sql<number>`count(*)` }).from(lots).where(eq(lots.eventId, ev.id)).get()?.n ?? 0) : 0;
    const unplaced = ev
      ? (db.select({ n: sql<number>`count(*)` }).from(lots).where(and(eq(lots.eventId, ev.id), isNull(lots.ccId))).get()?.n ?? 0)
      : 0;
    return { event: ev, days: dayRows, lotCount, unplacedLots: unplaced };
  }),
  /** Every bus message, for admin screens to refetch on. Admin sees all CCs and days. */
  onEvent: adminProcedure.subscription(async function* ({ ctx, signal }) {
    const sessionId = ctx.session.id;
    for await (const item of liveFor(signal, true, () => readAdmin(sessionId), () => true)) {
      if (item.kind === "event") yield item.msg satisfies BusMessage;
    }
  }),
});
