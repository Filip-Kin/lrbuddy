import { TRPCError } from "@trpc/server";
import { and, eq, inArray, isNull, max, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../db/index.ts";
import { assignments, companies, companyDays, crewAreas, crews, days, lotPhotos, lots, type AreaPolygon, type Lot } from "../../db/schema.ts";
import { dayOfMap } from "../../dayof.ts";
import { emitLot } from "../../lots-import.ts";
import { areaAround, isWork, newestTags, outlinePoints, parcelsOnSides, workParcelsOnSides, type BlockSide } from "../../parcels.ts";
import { createCrew } from "../../setup.ts";
import { adminProcedure, router } from "../../trpc.ts";
import { areaForCrews, dayAreas, pruneAreas, splitSides, type SplitSide } from "./areas.ts";
import { blockSideRows } from "./blocks.ts";
import { areaInput, badRequest, ccOfDay, crewOfDay, dayOfEvent, eventInput, eventOrActive, id, notFound } from "./common.ts";

/** Volunteers per crew when a company's headcount becomes crews. */
export const CREW_SIZE = 10;

// #region publish
export interface PublishResult {
  added: number;
  updated: number;
  /** Lots a crew already marked done, left as they were. */
  kept: number;
  /** Open survey lots taken off the work list because the parcel's newest tag is no longer work. */
  removed: number;
  /** Crews whose area was set. */
  areas: number;
}

/**
 * Writes lots for the tagged work parcels of every assigned block side (one
 * day, or all), keyed on event and parcel so a second publish updates rather
 * than duplicates. A done lot is left alone. A side assigned to a shared area
 * goes to one of the area's crews (`splitSides`), so every crew keeps its own
 * list. Crews get an area around their parcels, padded 15 m, when they have
 * none yet or `resetAreas` is set; a shared area is padded around the parcels
 * of all its crews.
 *
 * A parcel on an assigned side whose newest tag is no longer work (tagged
 * clear, or its tag undone) leaves the work list: its open survey lot is
 * deleted, or, when it has photos, taken off its crew and marked skipped so
 * the photos stay. Lots from other sources and lots in progress or done are
 * left alone.
 */
export const publishAssignments = (eventId: number, opts: { dayId?: number | null; resetAreas?: boolean } = {}): PublishResult => {
  const rows = db
    .select()
    .from(assignments)
    .where(and(eq(assignments.eventId, eventId), opts.dayId != null ? eq(assignments.dayId, opts.dayId) : undefined))
    .orderBy(assignments.order, assignments.id)
    .all();
  const res: PublishResult = { added: 0, updated: 0, kept: 0, removed: 0, areas: 0 };
  const touched = new Map<number, Lot>();
  const crewPoints = new Map<number, Array<{ lat: number; lng: number }>>();
  const work = new Map(rows.map((a) => [a.blockSideKey, workParcelsOnSides(eventId, [a.blockSideKey])]));

  // #region who works each side
  const crewOfSide = new Map<string, number | null>();
  const areaIds = [...new Set(rows.map((a) => a.areaId).filter((x): x is number => x !== null))];
  const members = areaIds.length
    ? db.select({ id: crews.id, areaId: crews.areaId }).from(crews).where(inArray(crews.areaId, areaIds)).orderBy(crews.number).all()
    : [];
  for (const areaId of areaIds) {
    const sides: SplitSide[] = rows
      .filter((a) => a.areaId === areaId)
      .map((a) => {
        const ps = work.get(a.blockSideKey) ?? [];
        const n = Math.max(ps.length, 1);
        return {
          key: a.blockSideKey,
          center: { lat: ps.reduce((t, p) => t + p.lat, 0) / n, lng: ps.reduce((t, p) => t + p.lng, 0) / n },
          weight: ps.reduce((t, p) => t + (p.grade === "high" ? 2 : 1), 0),
        };
      });
    const split = splitSides(sides, members.filter((m) => m.areaId === areaId).map((m) => m.id));
    for (const sd of sides) crewOfSide.set(sd.key, split.get(sd.key) ?? null);
  }
  for (const a of rows) if (!crewOfSide.has(a.blockSideKey)) crewOfSide.set(a.blockSideKey, a.crewId);
  // #endregion

  db.transaction((tx) => {
    for (const a of rows) {
      const crewId = crewOfSide.get(a.blockSideKey) ?? null;
      for (const p of work.get(a.blockSideKey) ?? []) {
        if (crewId !== null) {
          const pts = crewPoints.get(crewId) ?? [];
          pts.push(...outlinePoints(p.geometry));
          crewPoints.set(crewId, pts);
        }
        const existing = tx.select().from(lots).where(and(eq(lots.eventId, eventId), eq(lots.parcelId, p.parcelId))).get();
        if (existing?.status === "done") {
          res.kept++;
          continue;
        }
        const set = { address: p.address, lat: p.lat, lng: p.lng, geometry: p.geometry, ccId: a.ccId, crewId };
        const lot = existing
          ? tx.update(lots).set(set).where(eq(lots.id, existing.id)).returning().get()
          : tx.insert(lots).values({ ...set, eventId, parcelId: p.parcelId, source: "survey", status: "open" }).returning().get();
        if (existing) res.updated++;
        else res.added++;
        touched.set(a.ccId, lot);
        if (existing?.ccId != null && existing.ccId !== a.ccId) touched.set(existing.ccId, { ...lot, ccId: existing.ccId });
      }
    }
    // #region parcels no longer work
    const sideIds = parcelsOnSides(rows.map((a) => a.blockSideKey)).map((p) => p.parcelId);
    const tags = newestTags(eventId, sideIds);
    const off = sideIds.filter((pid) => !isWork(tags.get(pid)?.grade));
    for (let i = 0; i < off.length; i += 500) {
      const stale = tx
        .select()
        .from(lots)
        .where(and(eq(lots.eventId, eventId), eq(lots.source, "survey"), eq(lots.status, "open"), inArray(lots.parcelId, off.slice(i, i + 500))))
        .all();
      for (const lot of stale) {
        // A photo lot from the survey sheet was never published (no CC, no crew); it stays as it is.
        if (lot.ccId === null && lot.crewId === null) continue;
        const photo = tx.select({ id: lotPhotos.id }).from(lotPhotos).where(eq(lotPhotos.lotId, lot.id)).limit(1).get();
        const gone = photo
          ? tx.update(lots).set({ crewId: null, status: "skipped", statusAt: Date.now(), statusByCrewId: null }).where(eq(lots.id, lot.id)).returning().get()
          : tx.delete(lots).where(eq(lots.id, lot.id)).returning().get();
        if (!gone) continue;
        res.removed++;
        if (lot.ccId !== null) touched.set(lot.ccId, lot);
      }
    }
    // #endregion
    // #region areas: one per crew, or one around every crew sharing it
    const crewRows = crewPoints.size ? tx.select().from(crews).where(inArray(crews.id, [...crewPoints.keys()])).all() : [];
    const areaPoints = new Map<number, Array<{ lat: number; lng: number }>>();
    for (const crew of crewRows) {
      const pts = crewPoints.get(crew.id) ?? [];
      let areaId = crew.areaId;
      if (areaId === null) {
        areaId = tx.insert(crewAreas).values({ eventId, dayId: crew.dayId, polygon: null }).returning().get().id;
        tx.update(crews).set({ areaId }).where(eq(crews.id, crew.id)).run();
      }
      areaPoints.set(areaId, [...(areaPoints.get(areaId) ?? []), ...pts]);
    }
    for (const [areaId, pts] of areaPoints) {
      const polygon = areaAround(pts, 15);
      if (!polygon) continue;
      const where = opts.resetAreas ? eq(crewAreas.id, areaId) : and(eq(crewAreas.id, areaId), isNull(crewAreas.polygon));
      const r = tx.update(crewAreas).set({ polygon }).where(where).returning({ id: crewAreas.id }).get();
      if (r) res.areas++;
    }
    // #endregion
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
  const areas = new Map(dayAreas(dayId).map((a) => [a.id, a]));
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
        crews: mine.map((r) => {
          const area = r.areaId !== null ? (areas.get(r.areaId) ?? null) : null;
          return {
            id: r.id,
            number: r.number,
            name: r.name,
            ccId: r.ccId,
            headcount: r.headcount,
            leadName: r.leadName,
            areaId: area?.id ?? null,
            areaLabel: area?.label ?? null,
            area: area?.polygon ?? null,
          };
        }),
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
  /**
   * Hands block sides to a company, or to one or several of its crews, on a
   * day at a CC. Several crews share one area (SPEC 19): `area` (the drawn
   * rectangle) becomes its outline, else Publish pads one around the work.
   * A side already assigned moves.
   */
  set: adminProcedure
    .input(
      z.object({
        dayId: id,
        ccId: id,
        companyId: id.nullish(),
        crewIds: z.array(id).max(50).optional(),
        area: areaInput.nullish(),
        keys: z.array(z.string().min(1).max(300)).min(1).max(2000),
        ...eventInput,
      }),
    )
    .mutation(({ input }) => {
      const eventId = eventOrActive(input.eventId);
      dayOfEvent(input.dayId, eventId);
      ccOfDay(input.ccId, input.dayId);
      let companyId = input.companyId ?? null;
      const crewIds = [...new Set(input.crewIds ?? [])];
      for (const crewId of crewIds) {
        const crew = crewOfDay(crewId, input.dayId);
        if (companyId !== null && crew.companyId !== companyId) throw badRequest("Crew is in another company");
        companyId = crew.companyId;
      }
      if (companyId === null) throw badRequest("Company needed");
      const company = db.select().from(companies).where(eq(companies.id, companyId)).get();
      if (!company || company.eventId !== eventId) throw notFound("Company");
      const top = db.select({ n: max(assignments.order) }).from(assignments).where(eq(assignments.eventId, eventId)).get();
      let order = (top?.n ?? 0) + 1;
      const known = new Set(parcelsOnSides(input.keys).map((p) => p.blockSideKey));
      for (const key of input.keys) if (!known.has(key)) throw new TRPCError({ code: "NOT_FOUND", message: "Block side not found" });
      const out = db.transaction((tx) => {
        const areaId = crewIds.length > 1 ? areaForCrews(tx, { eventId, dayId: input.dayId, crewIds, polygon: input.area ?? null }).id : null;
        const crewId = crewIds.length === 1 ? crewIds[0]! : null;
        const written = input.keys.map((key) => {
          const values = { eventId, dayId: input.dayId, ccId: input.ccId, companyId, crewId, areaId, blockSideKey: key, order: order++ };
          return tx
            .insert(assignments)
            .values(values)
            .onConflictDoUpdate({ target: [assignments.eventId, assignments.blockSideKey], set: { dayId: values.dayId, ccId: values.ccId, companyId, crewId, areaId } })
            .returning()
            .get();
        });
        return { written, areaId };
      });
      return { assigned: out.written.length, areaId: out.areaId };
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
      return created.map((c) => ({ id: c.id, number: c.number, name: c.name, headcount: c.headcount }));
    }),
  /** The day as the field left it at one CC (SPEC 19 Marks): lot counts per block side and rectangle, Do not touch flags. */
  dayOf: adminProcedure.input(z.object({ dayId: id, ccId: id, ...eventInput })).query(({ input }) => {
    const day = dayOfEvent(input.dayId, eventOrActive(input.eventId));
    const cc = ccOfDay(input.ccId, input.dayId);
    const m = dayOfMap({ cc, day });
    return {
      sides: m.sides.map((x) => ({ key: x.key, counts: x.counts })),
      areas: m.areas.map((a) => ({ id: a.id, doNotTouch: a.doNotTouch, counts: a.counts })),
    };
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
    const areas = new Map(dayAreas(input.dayId).map((a) => [a.id, a]));
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
        name: crew.name,
        ccId: crew.ccId,
        companyId: crew.companyId,
        companyName: company?.name ?? null,
        leadName: crew.leadName,
        leadPhone: crew.leadPhone,
        headcount: crew.headcount,
        areaId: crew.areaId,
        areaLabel: crew.areaId !== null ? (areas.get(crew.areaId)?.label ?? null) : null,
        area: crew.areaId !== null ? (areas.get(crew.areaId)?.polygon ?? null) : null,
      }));
  }),
  /**
   * The rectangle printed on the crew's sheet. A shared area changes for every
   * crew in it. Null takes the crew out of its area (an area nobody holds goes).
   */
  setArea: adminProcedure.input(z.object({ crewId: id, area: areaInput.nullable() })).mutation(({ input }) => {
    const crew = db.select().from(crews).where(eq(crews.id, input.crewId)).get();
    if (!crew) throw notFound("Crew");
    const polygon: AreaPolygon | null = input.area;
    return db.transaction((tx) => {
      if (polygon === null) {
        tx.update(crews).set({ areaId: null }).where(eq(crews.id, crew.id)).run();
        pruneAreas(crew.dayId, tx);
        return { id: crew.id, areaId: null, area: null };
      }
      if (crew.areaId !== null) {
        tx.update(crewAreas).set({ polygon }).where(eq(crewAreas.id, crew.areaId)).run();
        return { id: crew.id, areaId: crew.areaId, area: polygon };
      }
      const day = db.select({ eventId: days.eventId }).from(days).where(eq(days.id, crew.dayId)).get();
      if (!day) throw notFound("Day");
      const area = tx.insert(crewAreas).values({ eventId: day.eventId, dayId: crew.dayId, polygon }).returning().get();
      tx.update(crews).set({ areaId: area.id }).where(eq(crews.id, crew.id)).run();
      return { id: crew.id, areaId: area.id, area: polygon };
    });
  }),
});
