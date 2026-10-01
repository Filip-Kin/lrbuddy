import { TRPCError } from "@trpc/server";
import { and, eq, inArray, isNull, max, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../db/index.ts";
import { assignments, companies, companyDays, crews, lots, type AreaPolygon, type Lot } from "../../db/schema.ts";
import { emitLot } from "../../lots-import.ts";
import { areaAround, outlinePoints, parcelsOnSides, workParcelsOnSides, type BlockSide } from "../../parcels.ts";
import { createCrew } from "../../setup.ts";
import { adminProcedure, router } from "../../trpc.ts";
import { blockSideRows } from "./blocks.ts";
import { areaInput, badRequest, ccOfDay, crewOfDay, dayOfEvent, eventInput, eventOrActive, id, notFound, teamNames } from "./common.ts";

/** Volunteers per crew when a company's headcount becomes crews. */
export const CREW_SIZE = 10;

// #region publish
export interface PublishResult {
  added: number;
  updated: number;
  /** Lots a crew already marked done, left as they were. */
  kept: number;
  /** Crews whose area was set. */
  areas: number;
}

/**
 * Writes lots for the tagged work parcels of every assigned block side (one
 * day, or all), keyed on event and parcel so a second publish updates rather
 * than duplicates. A done lot is left alone. Crews get an area around their
 * parcels, padded 15 m, when they have none yet or `resetAreas` is set.
 */
export const publishAssignments = (eventId: number, opts: { dayId?: number | null; resetAreas?: boolean } = {}): PublishResult => {
  const rows = db
    .select()
    .from(assignments)
    .where(and(eq(assignments.eventId, eventId), opts.dayId != null ? eq(assignments.dayId, opts.dayId) : undefined))
    .orderBy(assignments.order, assignments.id)
    .all();
  const res: PublishResult = { added: 0, updated: 0, kept: 0, areas: 0 };
  const touched = new Map<number, Lot>();
  const crewPoints = new Map<number, Array<{ lat: number; lng: number }>>();
  db.transaction((tx) => {
    for (const a of rows) {
      for (const p of workParcelsOnSides(eventId, [a.blockSideKey])) {
        if (a.crewId !== null) {
          const pts = crewPoints.get(a.crewId) ?? [];
          pts.push(...outlinePoints(p.geometry));
          crewPoints.set(a.crewId, pts);
        }
        const existing = tx.select().from(lots).where(and(eq(lots.eventId, eventId), eq(lots.parcelId, p.parcelId))).get();
        if (existing?.status === "done") {
          res.kept++;
          continue;
        }
        const set = { address: p.address, lat: p.lat, lng: p.lng, geometry: p.geometry, ccId: a.ccId, crewId: a.crewId };
        const lot = existing
          ? tx.update(lots).set(set).where(eq(lots.id, existing.id)).returning().get()
          : tx.insert(lots).values({ ...set, eventId, parcelId: p.parcelId, source: "survey", status: "open" }).returning().get();
        if (existing) res.updated++;
        else res.added++;
        touched.set(a.ccId, lot);
        if (existing?.ccId != null && existing.ccId !== a.ccId) touched.set(existing.ccId, { ...lot, ccId: existing.ccId });
      }
    }
    for (const [crewId, pts] of crewPoints) {
      const area = areaAround(pts, 15);
      if (!area) continue;
      const where = opts.resetAreas ? eq(crews.id, crewId) : and(eq(crews.id, crewId), isNull(crews.area));
      const r = tx.update(crews).set({ area }).where(where).returning({ id: crews.id }).get();
      if (r) res.areas++;
    }
  });
  // One lot.changed per CC is enough for that CC's screens to refetch.
  for (const lot of touched.values()) emitLot(lot);
  return res;
};
// #endregion

// #region companies of a day
const companiesOfDay = (eventId: number, dayId: number, ccId: number | null) => {
  const all = db.select().from(companies).where(eq(companies.eventId, eventId)).orderBy(sql`lower(${companies.name})`).all();
  const attending = db.select().from(companyDays).where(eq(companyDays.dayId, dayId)).all();
  const crewRows = db.select().from(crews).where(eq(crews.dayId, dayId)).orderBy(crews.number).all();
  const names = teamNames(dayId);
  const sides = new Map<string, BlockSide>(blockSideRows(eventId).map((b) => [b.key, b]));
  const asg = db.select().from(assignments).where(and(eq(assignments.eventId, eventId), eq(assignments.dayId, dayId))).all();
  return all
    .map((c) => {
      const att = attending.find((a) => a.companyId === c.id) ?? null;
      const mine = crewRows.filter((r) => r.companyId === c.id);
      const headcount = att?.headcount ?? mine.reduce((n, r) => n + (r.headcount ?? 0), 0);
      let high = 0;
      let low = 0;
      let sideCount = 0;
      for (const a of asg) {
        if (a.companyId !== c.id) continue;
        const b = sides.get(a.blockSideKey);
        sideCount++;
        high += b?.high ?? 0;
        low += b?.low ?? 0;
      }
      return {
        companyId: c.id,
        name: c.name,
        attending: att !== null || mine.length > 0,
        ccId: att?.ccId ?? mine[0]?.ccId ?? null,
        /** The CC on the company's day row itself; editing the headcount keeps it. */
        attendCcId: att?.ccId ?? null,
        headcount,
        /** Crews the headcount makes, one per 10. */
        crewCapacity: Math.ceil(headcount / CREW_SIZE),
        crews: mine.map((r) => ({ id: r.id, number: r.number, name: names.get(r.id) ?? `Crew ${r.number}`, ccId: r.ccId, headcount: r.headcount, leadName: r.leadName, area: r.area })),
        assigned: { sides: sideCount, high, low, work: high + low },
      };
    })
    .filter((c) => c.attending && (ccId === null || c.ccId === null || c.ccId === ccId));
};
// #endregion

export const assignmentsRouter = router({
  /** Assignments of the event (or one day and CC) with block side counts and names. */
  list: adminProcedure.input(z.object({ dayId: id.nullish(), ccId: id.nullish(), ...eventInput }).optional()).query(({ input }) => {
    const eventId = eventOrActive(input?.eventId);
    return blockSideRows(eventId)
      .filter((b) => b.assignment && (input?.dayId == null || b.assignment.dayId === input.dayId) && (input?.ccId == null || b.assignment.ccId === input.ccId))
      .sort((a, b) => (a.assignment?.order ?? 0) - (b.assignment?.order ?? 0));
  }),
  /** Companies attending a day with promised headcount, crews and assigned work. */
  companies: adminProcedure.input(z.object({ dayId: id, ccId: id.nullish(), ...eventInput })).query(({ input }) => {
    const eventId = eventOrActive(input.eventId);
    dayOfEvent(input.dayId, eventId);
    return companiesOfDay(eventId, input.dayId, input.ccId ?? null);
  }),
  /** A company's promised headcount for a day; 0 with no crews takes it off the day. */
  setHeadcount: adminProcedure
    .input(z.object({ companyId: id, dayId: id, ccId: id.nullish(), headcount: z.number().int().min(0).max(5000), ...eventInput }))
    .mutation(({ input }) => {
      const eventId = eventOrActive(input.eventId);
      dayOfEvent(input.dayId, eventId);
      if (input.ccId != null) ccOfDay(input.ccId, input.dayId);
      const company = db.select().from(companies).where(eq(companies.id, input.companyId)).get();
      if (!company || company.eventId !== eventId) throw notFound("Company");
      return db
        .insert(companyDays)
        .values({ companyId: input.companyId, dayId: input.dayId, ccId: input.ccId ?? null, headcount: input.headcount })
        .onConflictDoUpdate({ target: [companyDays.companyId, companyDays.dayId], set: { headcount: input.headcount, ccId: input.ccId ?? null } })
        .returning()
        .get();
    }),
  /** Hands block sides to a company (and a crew) on a day at a CC. A side already assigned moves. */
  set: adminProcedure
    .input(z.object({ dayId: id, ccId: id, companyId: id.nullish(), crewId: id.nullish(), keys: z.array(z.string().min(1).max(300)).min(1).max(2000), ...eventInput }))
    .mutation(({ input }) => {
      const eventId = eventOrActive(input.eventId);
      dayOfEvent(input.dayId, eventId);
      ccOfDay(input.ccId, input.dayId);
      let companyId = input.companyId ?? null;
      if (input.crewId != null) {
        const crew = crewOfDay(input.crewId, input.dayId);
        if (companyId !== null && crew.companyId !== companyId) throw badRequest("Crew is in another company");
        companyId = crew.companyId;
      }
      if (companyId === null) throw badRequest("Company needed");
      const company = db.select().from(companies).where(eq(companies.id, companyId)).get();
      if (!company || company.eventId !== eventId) throw notFound("Company");
      const top = db.select({ n: max(assignments.order) }).from(assignments).where(eq(assignments.eventId, eventId)).get();
      let order = (top?.n ?? 0) + 1;
      const known = new Set(parcelsOnSides(input.keys).map((p) => p.blockSideKey));
      const out = db.transaction((tx) =>
        input.keys.map((key) => {
          if (!known.has(key)) throw new TRPCError({ code: "NOT_FOUND", message: "Block side not found" });
          const values = { eventId, dayId: input.dayId, ccId: input.ccId, companyId, crewId: input.crewId ?? null, blockSideKey: key, order: order++ };
          return tx
            .insert(assignments)
            .values(values)
            .onConflictDoUpdate({ target: [assignments.eventId, assignments.blockSideKey], set: { dayId: values.dayId, ccId: values.ccId, companyId, crewId: values.crewId } })
            .returning()
            .get();
        }),
      );
      return { assigned: out.length };
    }),
  /** Takes block sides off their assignment. Published lots stay. */
  clear: adminProcedure.input(z.object({ keys: z.array(z.string().min(1).max(300)).min(1).max(2000), ...eventInput })).mutation(({ input }) => {
    const r = db
      .delete(assignments)
      .where(and(eq(assignments.eventId, eventOrActive(input.eventId)), inArray(assignments.blockSideKey, input.keys)))
      .returning({ id: assignments.id })
      .all();
    return { cleared: r.length };
  }),
  /**
   * Crew rows for a company from its headcount, one per 10, when it has none
   * on the day. Headcount comes from the input, else the day's promised count.
   */
  buildCrews: adminProcedure
    .input(z.object({ dayId: id, ccId: id, companyId: id, headcount: z.number().int().min(1).max(5000).optional(), ...eventInput }))
    .mutation(({ input }) => {
      const eventId = eventOrActive(input.eventId);
      dayOfEvent(input.dayId, eventId);
      ccOfDay(input.ccId, input.dayId);
      const company = db.select().from(companies).where(eq(companies.id, input.companyId)).get();
      if (!company || company.eventId !== eventId) throw notFound("Company");
      const existing = db.select({ id: crews.id }).from(crews).where(and(eq(crews.dayId, input.dayId), eq(crews.companyId, input.companyId))).all();
      if (existing.length > 0) throw new TRPCError({ code: "CONFLICT", message: "Crews already built" });
      const promised = db.select().from(companyDays).where(and(eq(companyDays.companyId, input.companyId), eq(companyDays.dayId, input.dayId))).get();
      const headcount = input.headcount ?? promised?.headcount ?? 0;
      if (headcount <= 0) throw badRequest("Headcount needed");
      const count = Math.ceil(headcount / CREW_SIZE);
      const created = db.transaction(() =>
        Array.from({ length: count }, (_v, i) => {
          const size = Math.floor(headcount / count) + (i < headcount % count ? 1 : 0);
          return createCrew({ dayId: input.dayId, ccId: input.ccId, companyId: input.companyId, headcount: size });
        }),
      );
      if (!promised) db.insert(companyDays).values({ companyId: input.companyId, dayId: input.dayId, ccId: input.ccId, headcount }).run();
      const names = teamNames(input.dayId);
      return created.map((c) => ({ id: c.id, number: c.number, name: names.get(c.id) ?? `Crew ${c.number}`, headcount: c.headcount }));
    }),
  /** Writes lots from the assigned block sides; see publishAssignments. */
  publish: adminProcedure
    .input(z.object({ dayId: id.nullish(), resetAreas: z.boolean().optional(), ...eventInput }).optional())
    .mutation(({ input }) => {
      const eventId = eventOrActive(input?.eventId);
      if (input?.dayId != null) dayOfEvent(input.dayId, eventId);
      return publishAssignments(eventId, { dayId: input?.dayId ?? null, resetAreas: input?.resetAreas ?? false });
    }),
});

export const crewsRouter = router({
  /** A day's crews with portal names and areas. */
  list: adminProcedure.input(z.object({ dayId: id, ...eventInput })).query(({ input }) => {
    dayOfEvent(input.dayId, eventOrActive(input.eventId));
    const names = teamNames(input.dayId);
    return db
      .select({ crew: crews, company: companies })
      .from(crews)
      .leftJoin(companies, eq(companies.id, crews.companyId))
      .where(eq(crews.dayId, input.dayId))
      .orderBy(crews.number)
      .all()
      .map(({ crew, company }) => ({
        id: crew.id,
        number: crew.number,
        name: names.get(crew.id) ?? `Crew ${crew.number}`,
        ccId: crew.ccId,
        companyId: crew.companyId,
        companyName: company?.name ?? null,
        leadName: crew.leadName,
        leadPhone: crew.leadPhone,
        headcount: crew.headcount,
        area: crew.area,
      }));
  }),
  /** The rectangle printed on the crew's sheet; null clears it. */
  setArea: adminProcedure.input(z.object({ crewId: id, area: areaInput.nullable() })).mutation(({ input }) => {
    const area: AreaPolygon | null = input.area;
    const r = db.update(crews).set({ area }).where(eq(crews.id, input.crewId)).returning({ id: crews.id, area: crews.area }).get();
    if (!r) throw notFound("Crew");
    return r;
  }),
});
