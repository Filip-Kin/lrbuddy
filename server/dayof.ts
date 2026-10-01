/**
 * Day-of actions on the green map (SPEC 19, Marks): a rectangle (crew area) or
 * one block side marked Done or Do not touch, and a rectangle handed to
 * another company's crews. Every change emits lot.changed and pushes the crews
 * involved.
 *
 * What belongs to a rectangle: the block sides assigned to it on the day at
 * the CC (to its shared area, or to one of its crews), and the lots at the CC's
 * site on those sides, plus any other lot of its crews. "Unfinished" is open or
 * in progress; done, do not touch and not todo lots are left as they are.
 */
import { TRPCError } from "@trpc/server";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "./db/index.ts";
import { inRing } from "./geo.ts";
import { assignments, companies, crewAreas, crews, lots, parcels, type AreaPolygon, type CommandCenter, type Day, type Lot, type LotStatus } from "./db/schema.ts";
import { emitLot, titleCase } from "./lots-import.ts";
import { blockSideLabel, parseKey } from "./parcels.ts";
import { scheduleOneway } from "./oneway.ts";
import { pushToCrew } from "./push.ts";
import { crewIdsOnDay, siteCcIds } from "./queries.ts";
import { areaForCrews, dayAreas, joinNames, pruneAreas, splitSides, type AreaView } from "./routers/plan/areas.ts";
import { sideShapes, type Ring } from "./routers/plan/blocks.ts";

export const DO_NOT_TOUCH = "Do not touch";
const UNFINISHED: readonly LotStatus[] = ["open", "in_progress"];

export interface Scope {
  cc: CommandCenter;
  day: Day;
}

export interface Counts {
  open: number;
  inProgress: number;
  done: number;
  doNotTouch: number;
}

/** Counts of the work lots; Not todo lots are not work and are not counted. */
const emptyCounts = (): Counts => ({ open: 0, inProgress: 0, done: 0, doNotTouch: 0 });
const count = (list: readonly Lot[]): Counts => {
  const c = emptyCounts();
  for (const l of list) {
    if (l.status === "open") c.open++;
    else if (l.status === "in_progress") c.inProgress++;
    else if (l.status === "done") c.done++;
    else if (l.status === "do_not_touch") c.doNotTouch++;
  }
  return c;
};

const badRequest = (message: string): TRPCError => new TRPCError({ code: "BAD_REQUEST", message });
const notHere = (what: string): TRPCError => new TRPCError({ code: "NOT_FOUND", message: `${what} not at this command center` });

// #region reading the CC's day
interface Snapshot {
  areas: AreaView[];
  /** Assigned block sides at the CC on the day, in assignment order. */
  sides: Array<{ key: string; areaId: number | null; crewId: number | null; companyId: number | null; doNotTouch: boolean }>;
  lots: Lot[];
  sideOfParcel: Map<string, string>;
  /** "W Boston Blvd" per block side key, from the parcels' addresses. */
  streetOf: Map<string, string>;
  names: Map<number, string>;
}

const ADDRESS = /^\s*\d+[A-Z]?\s+(.+?)\s*$/i;

const snapshot = ({ cc, day }: Scope): Snapshot => {
  const names = new Map(db.select({ id: crews.id, name: crews.name }).from(crews).where(eq(crews.dayId, day.id)).all().map((c) => [c.id, c.name]));
  const areas = dayAreas(day.id).filter((a) => a.ccId === cc.id);
  const crewArea = new Map<number, number>();
  for (const a of areas) for (const c of a.crewIds) crewArea.set(c, a.id);
  const rows = db
    .select()
    .from(assignments)
    .where(and(eq(assignments.dayId, day.id), eq(assignments.ccId, cc.id)))
    .orderBy(assignments.order, assignments.id)
    .all();
  const sides = rows.map((r) => ({
    key: r.blockSideKey,
    areaId: r.areaId ?? (r.crewId !== null ? (crewArea.get(r.crewId) ?? null) : null),
    crewId: r.crewId,
    companyId: r.companyId,
    doNotTouch: r.doNotTouch === true,
  }));
  const today = crewIdsOnDay(day.id);
  const lotRows = db
    .select()
    .from(lots)
    .where(inArray(lots.ccId, siteCcIds(cc.id)))
    .all()
    .map((l) => (l.crewId !== null && !today.has(l.crewId) ? { ...l, crewId: null } : l));
  const keys = sides.map((s) => s.key);
  const sideOfParcel = new Map<string, string>();
  const streetVotes = new Map<string, Map<string, number>>();
  for (let i = 0; i < keys.length; i += 500) {
    const ps = db
      .select({ parcelId: parcels.parcelId, key: parcels.blockSideKey, address: parcels.address })
      .from(parcels)
      .where(inArray(parcels.blockSideKey, keys.slice(i, i + 500)))
      .all();
    for (const p of ps) {
      if (!p.key) continue;
      sideOfParcel.set(p.parcelId, p.key);
      const street = p.address ? ADDRESS.exec(p.address)?.[1] : undefined;
      if (!street) continue;
      const votes = streetVotes.get(p.key) ?? new Map<string, number>();
      const name = titleCase(street);
      votes.set(name, (votes.get(name) ?? 0) + 1);
      streetVotes.set(p.key, votes);
    }
  }
  // The street as most of the side's addresses spell it ("W Boston Blvd").
  const streetOf = new Map<string, string>();
  for (const [key, votes] of streetVotes) streetOf.set(key, [...votes.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)[0]![0]);
  for (const k of keys) if (!streetOf.has(k)) streetOf.set(k, titleCase(parseKey(k).street.toLowerCase()));
  return { areas, sides, lots: lotRows, sideOfParcel, streetOf, names };
};

const lotsOnSide = (s: Snapshot, key: string): Lot[] => s.lots.filter((l) => l.parcelId !== null && s.sideOfParcel.get(l.parcelId) === key);

const lotsOfArea = (s: Snapshot, area: AreaView): Lot[] => {
  const keys = new Set(s.sides.filter((x) => x.areaId === area.id).map((x) => x.key));
  const crewSet = new Set(area.crewIds);
  return s.lots.filter((l) => (l.parcelId !== null && keys.has(s.sideOfParcel.get(l.parcelId) ?? "")) || (l.crewId !== null && crewSet.has(l.crewId)));
};

/** "W Boston Blvd & Rochester St": the streets of the area's sides, in assignment order. */
const areaStreets = (s: Snapshot, areaId: number): string =>
  joinNames([...new Set(s.sides.filter((x) => x.areaId === areaId).map((x) => s.streetOf.get(x.key) ?? ""))].filter(Boolean));

/** "Glynn Ct, Dexter Ave to Wildemere St, odd". */
const sideName = (s: Snapshot, key: string): string => {
  const street = s.streetOf.get(key);
  const label = blockSideLabel(key);
  if (!street) return label;
  const rest = label.split(", ").slice(1).join(", ");
  return rest ? `${street}, ${rest}` : street;
};
// #endregion

// #region the green map
export interface DayOfArea {
  id: number;
  label: string;
  ring: Ring;
  streets: string;
  companyId: number | null;
  companyName: string | null;
  crewIds: number[];
  doNotTouch: boolean;
  counts: Counts;
}

export interface DayOfSide {
  key: string;
  label: string;
  ring: Ring;
  areaId: number | null;
  companyId: number | null;
  /** Marked Do not touch as a whole by a green (the band); one Do not touch lot never sets it. */
  doNotTouch: boolean;
  counts: Counts;
}

/** The CC's rectangles with their lot counts. */
const areaViews = (scope: Scope, s: Snapshot): DayOfArea[] => {
  const companyRows = db.select().from(companies).where(eq(companies.eventId, scope.day.eventId)).all();
  const companyName = (id: number | null): string | null => companyRows.find((c) => c.id === id)?.name ?? null;
  return s.areas.flatMap((a) => {
    const ring = (a.polygon?.coordinates[0] ?? []).map((p): [number, number] => [p[0] ?? 0, p[1] ?? 0]);
    if (ring.length < 4) return [];
    return [
      {
        id: a.id,
        label: a.label,
        ring,
        streets: areaStreets(s, a.id),
        companyId: a.companyId,
        companyName: companyName(a.companyId),
        crewIds: a.crewIds,
        doNotTouch: a.doNotTouch,
        counts: count(lotsOfArea(s, a)),
      },
    ];
  });
};

/** The CC's rectangles on its day with lot counts, without block sides (the driver map). */
export const dayOfAreas = (scope: Scope): DayOfArea[] => areaViews(scope, snapshot(scope));

/** Rectangles and block sides at the CC for the green map, with lot counts, and the companies a rectangle can go to. */
export const dayOfMap = (scope: Scope) => {
  const s = snapshot(scope);
  const companyRows = db.select().from(companies).where(eq(companies.eventId, scope.day.eventId)).all();
  const areas = areaViews(scope, s);
  const shapes = new Map(sideShapes(s.sides.map((x) => x.key)).map((x) => [x.key, x.ring]));
  const sides: DayOfSide[] = s.sides.flatMap((x) => {
    const ring = shapes.get(x.key);
    if (!ring) return [];
    return [{ key: x.key, label: sideName(s, x.key), ring, areaId: x.areaId, companyId: x.companyId, doNotTouch: x.doNotTouch, counts: count(lotsOnSide(s, x.key)) }];
  });
  const crewRows = db.select().from(crews).where(and(eq(crews.dayId, scope.day.id), eq(crews.ccId, scope.cc.id))).orderBy(crews.number).all();
  const here = companyRows
    .filter((c) => crewRows.some((r) => r.companyId === c.id))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((c) => ({
      id: c.id,
      name: c.name,
      crews: crewRows.filter((r) => r.companyId === c.id).map((r) => ({ id: r.id, name: r.name, areaId: r.areaId })),
    }));
  return { areas, sides, companies: here };
};
// #endregion

// #region writes
const areaOf = (s: Snapshot, areaId: number): AreaView => {
  const a = s.areas.find((x) => x.id === areaId);
  if (!a) throw notHere("Area");
  return a;
};

const sideOf = (s: Snapshot, key: string): Snapshot["sides"][number] => {
  const x = s.sides.find((y) => y.key === key);
  if (!x) throw notHere("Block side");
  return x;
};

/** Sets the status of the unfinished lots; returns the rows written. */
const mark = (list: readonly Lot[], status: "done" | "do_not_touch"): Lot[] => {
  const ids = list.filter((l) => UNFINISHED.includes(l.status)).map((l) => l.id);
  if (ids.length === 0) return [];
  const set = { status, statusAt: Date.now(), statusByCrewId: null };
  const out: Lot[] = [];
  db.transaction((tx) => {
    for (let i = 0; i < ids.length; i += 500) out.push(...tx.update(lots).set(set).where(inArray(lots.id, ids.slice(i, i + 500))).returning().all());
  });
  return out;
};

const notify = (crewIds: Iterable<number>, cc: CommandCenter, body: string, tag: string): void => {
  for (const id of new Set(crewIds)) pushToCrew(id, { title: `CC ${cc.name}`, body, url: "/lots", tag });
};

/** lot.changed for each written lot; with none written, one lot of the place still goes out so open screens refetch. */
const emitAll = (written: readonly Lot[], place: readonly Lot[]): void => {
  if (written.length > 0) for (const l of written) emitLot(l);
  else if (place[0]) emitLot(place[0]);
};

const crewsOf = (list: readonly Lot[]): number[] => list.map((l) => l.crewId).filter((x): x is number => x !== null);

export interface MarkResult {
  /** Lots whose status changed. */
  changed: number;
}

export const markArea = (scope: Scope, areaId: number, action: "done" | "doNotTouch"): MarkResult => {
  const s = snapshot(scope);
  const area = areaOf(s, areaId);
  const inArea = lotsOfArea(s, area);
  const written = mark(inArea, action === "done" ? "done" : "do_not_touch");
  if (action === "doNotTouch") db.update(crewAreas).set({ doNotTouch: true }).where(eq(crewAreas.id, area.id)).run();
  emitAll(written, inArea);
  const what = areaStreets(s, area.id) || area.label;
  notify([...area.crewIds, ...crewsOf(written)], scope.cc, `${action === "done" ? "Done" : DO_NOT_TOUCH}: ${what}`, `area-${area.id}`);
  return { changed: written.length };
};

export const markSide = (scope: Scope, key: string, action: "done" | "doNotTouch"): MarkResult => {
  const s = snapshot(scope);
  const side = sideOf(s, key);
  const onSide = lotsOnSide(s, side.key);
  const written = mark(onSide, action === "done" ? "done" : "do_not_touch");
  // The band on the map: set by Do not touch on the side, cleared by Done on it.
  db.update(assignments)
    .set({ doNotTouch: action === "doNotTouch" ? true : null })
    .where(and(eq(assignments.dayId, scope.day.id), eq(assignments.ccId, scope.cc.id), eq(assignments.blockSideKey, side.key)))
    .run();
  emitAll(written, onSide);
  const area = side.areaId !== null ? s.areas.find((a) => a.id === side.areaId) : undefined;
  notify([...(area?.crewIds ?? []), ...(side.crewId !== null ? [side.crewId] : []), ...crewsOf(written)], scope.cc, `${action === "done" ? "Done" : DO_NOT_TOUCH}: ${sideName(s, side.key)}`, `side-${side.key}`);
  return { changed: written.length };
};

export interface ReassignResult {
  /** Lots moved to the new crews. */
  moved: number;
  label: string;
}

/**
 * Hands a rectangle to one or more crews of a company at this CC. The crews
 * join the area (leaving any area they held, which goes when nobody holds it),
 * its old crews leave it, its block sides go to the company and crews, and its
 * lots that are not done go to the new crews: one crew takes them all, several
 * split them by block side the way Publish does. Done lots keep their crew.
 */
export const reassignArea = (scope: Scope, input: { areaId: number; companyId: number; crewIds: readonly number[] }): ReassignResult => {
  const s = snapshot(scope);
  const area = areaOf(s, input.areaId);
  const targets = [...new Set(input.crewIds)];
  if (targets.length === 0) throw badRequest("Crew needed");
  const rows = db.select().from(crews).where(inArray(crews.id, targets)).orderBy(crews.number).all();
  if (rows.length !== targets.length || rows.some((r) => r.dayId !== scope.day.id || r.ccId !== scope.cc.id)) throw notHere("Crew");
  if (rows.some((r) => r.companyId !== input.companyId)) throw badRequest("Crew is in another company");
  const ordered = rows.map((r) => r.id);
  if (ordered.length === area.crewIds.length && ordered.every((id) => area.crewIds.includes(id))) throw badRequest("Already with these crews");

  const areaSides = s.sides.filter((x) => x.areaId === area.id);
  const areaLots = lotsOfArea(s, area).filter((l) => l.status !== "done");
  // Which new crew takes each side: one crew all, several by Publish's split.
  const crewOfSide =
    ordered.length === 1
      ? new Map(areaSides.map((x) => [x.key, ordered[0]!]))
      : splitSides(
          areaSides.map((x) => {
            const on = areaLots.filter((l) => l.parcelId !== null && s.sideOfParcel.get(l.parcelId) === x.key);
            const n = Math.max(on.length, 1);
            return {
              key: x.key,
              center: { lat: on.reduce((t, l) => t + l.lat, 0) / n, lng: on.reduce((t, l) => t + l.lng, 0) / n },
              weight: on.length,
            };
          }),
          ordered,
        );
  const moved: Lot[] = [];
  db.transaction((tx) => {
    tx.update(crews).set({ areaId: null }).where(and(inArray(crews.id, area.crewIds), eq(crews.dayId, scope.day.id))).run();
    tx.update(crews).set({ areaId: area.id }).where(inArray(crews.id, ordered)).run();
    for (const x of areaSides) {
      tx.update(assignments)
        .set({ companyId: input.companyId, crewId: ordered.length === 1 ? ordered[0]! : null, areaId: ordered.length === 1 ? null : area.id })
        .where(and(eq(assignments.dayId, scope.day.id), eq(assignments.ccId, scope.cc.id), eq(assignments.blockSideKey, x.key)))
        .run();
    }
    for (const l of areaLots) {
      const key = l.parcelId !== null ? s.sideOfParcel.get(l.parcelId) : undefined;
      const crewId = (key !== undefined ? crewOfSide.get(key) : undefined) ?? ordered[0]!;
      if (l.crewId === crewId) continue;
      const row = tx.update(lots).set({ crewId }).where(eq(lots.id, l.id)).returning().get();
      if (row) moved.push(row);
    }
    // The area keeps its outline and its Do not touch flag; an area a new crew left goes when nobody holds it.
    pruneAreas(scope.day.id, tx);
  });
  emitAll(moved, lotsOfArea(s, area));
  const company = db.select().from(companies).where(eq(companies.id, input.companyId)).get();
  const what = areaStreets(s, area.id) || area.label;
  notify([...area.crewIds, ...ordered], scope.cc, `Reassigned: ${what} to ${company?.name ?? "another company"}`, `area-${area.id}`);
  return { moved: moved.length, label: joinNames(ordered.map((id) => s.names.get(id) ?? "")) };
};
// #endregion

// #region areas drawn on the green map (SPEC 21)
/** A drawn rectangle: a closed ring of four corners, [lng, lat]. */
const ringOfPolygon = (polygon: AreaPolygon): Array<[number, number]> => (polygon.coordinates[0] ?? []).map((p): [number, number] => [p[0] ?? 0, p[1] ?? 0]);

/** Crews of this CC on its day, in crew number order; throws when any is elsewhere. */
const crewsHere = (scope: Scope, ids: readonly number[]): number[] => {
  const unique = [...new Set(ids)];
  if (unique.length === 0) throw badRequest("Crew needed");
  const rows = db.select().from(crews).where(inArray(crews.id, unique)).orderBy(crews.number).all();
  if (rows.length !== unique.length || rows.some((r) => r.dayId !== scope.day.id || r.ccId !== scope.cc.id)) throw notHere("Crew");
  return rows.map((r) => r.id);
};

/** lot.changed for the written lots, else for one lot at the CC's site so open screens (and admin Assignments) refetch. */
const emitOrPoke = (written: readonly Lot[], scope: Scope): void => {
  if (written.length > 0) {
    for (const l of written) emitLot(l);
    return;
  }
  const any = db.select().from(lots).where(inArray(lots.ccId, siteCcIds(scope.cc.id))).limit(1).get();
  if (any) emitLot(any);
};

export interface AssignAreaResult {
  areaId: number;
  /** Todo lots inside that went to the crews. */
  moved: number;
  label: string;
}

/**
 * Draw area, then Assign (SPEC 21): the crews take the rectangle as their
 * area (the same crews keep one area, the Assignments rule), and every Todo
 * lot at this CC with its centre inside goes to them. Several crews split the
 * lots by block side the way Publish does. Lots in progress, done, do not
 * touch or not todo keep their crew.
 */
export const assignDrawnArea = (scope: Scope, input: { polygon: AreaPolygon; crewIds: readonly number[] }): AssignAreaResult => {
  const ordered = crewsHere(scope, input.crewIds);
  const ring = ringOfPolygon(input.polygon);
  const site = siteCcIds(scope.cc.id);
  const inside = db
    .select()
    .from(lots)
    .where(and(eq(lots.eventId, scope.day.eventId), eq(lots.status, "open")))
    .all()
    .filter((l) => (l.ccId === null || site.includes(l.ccId)) && inRing(l, ring));
  const keyOf = new Map<number, string>();
  const pids = inside.map((l) => l.parcelId).filter((p): p is string => p !== null);
  for (let i = 0; i < pids.length; i += 500) {
    for (const p of db.select({ parcelId: parcels.parcelId, key: parcels.blockSideKey }).from(parcels).where(inArray(parcels.parcelId, pids.slice(i, i + 500))).all()) {
      const lot = inside.find((l) => l.parcelId === p.parcelId);
      if (lot) keyOf.set(lot.id, p.key ?? `lot:${lot.id}`);
    }
  }
  for (const l of inside) if (!keyOf.has(l.id)) keyOf.set(l.id, `lot:${l.id}`);
  const groups = new Map<string, Lot[]>();
  for (const l of inside) groups.set(keyOf.get(l.id)!, [...(groups.get(keyOf.get(l.id)!) ?? []), l]);
  const split = splitSides(
    [...groups.entries()].map(([key, list]) => ({
      key,
      center: { lat: list.reduce((t, l) => t + l.lat, 0) / list.length, lng: list.reduce((t, l) => t + l.lng, 0) / list.length },
      weight: list.reduce((t, l) => t + (l.grade === "high" ? 2 : 1), 0),
    })),
    ordered,
  );
  const moved: Lot[] = [];
  const areaId = db.transaction((tx) => {
    const area = areaForCrews(tx, { eventId: scope.day.eventId, dayId: scope.day.id, crewIds: ordered, polygon: input.polygon });
    for (const l of inside) {
      const crewId = split.get(keyOf.get(l.id)!) ?? ordered[0]!;
      if (l.crewId === crewId && l.ccId !== null) continue;
      const row = tx.update(lots).set({ crewId, ccId: l.ccId ?? scope.cc.id }).where(eq(lots.id, l.id)).returning().get();
      if (row) moved.push(row);
    }
    pruneAreas(scope.day.id, tx);
    return area.id;
  });
  emitOrPoke(moved, scope);
  // The CC's day area changed: one-way streets and alleys are fetched for it again (SPEC 20).
  scheduleOneway(scope.cc.id);
  const names = db.select({ id: crews.id, name: crews.name }).from(crews).where(inArray(crews.id, ordered)).all();
  const label = joinNames(ordered.map((id) => names.find((n) => n.id === id)?.name ?? ""));
  notify(ordered, scope.cc, `New area: ${moved.length === 1 ? "1 lot" : `${moved.length} lots`}`, `area-${areaId}`);
  return { areaId, moved: moved.length, label };
};

/** Edit corners: a new outline for a rectangle at this CC. Lots keep their crews. */
export const moveArea = (scope: Scope, input: { areaId: number; polygon: AreaPolygon }): { areaId: number } => {
  const s = snapshot(scope);
  const area = areaOf(s, input.areaId);
  db.update(crewAreas).set({ polygon: input.polygon }).where(eq(crewAreas.id, area.id)).run();
  emitOrPoke([], scope);
  scheduleOneway(scope.cc.id);
  return { areaId: area.id };
};

/**
 * Delete area: the rectangle goes and its crews have none; its lots stay at
 * the CC with no crew, except done lots, which keep the crew that did them.
 */
export const deleteArea = (scope: Scope, areaId: number): { unassigned: number } => {
  const s = snapshot(scope);
  const area = areaOf(s, areaId);
  const loose = lotsOfArea(s, area).filter((l) => l.status !== "done" && l.crewId !== null);
  const written: Lot[] = [];
  db.transaction((tx) => {
    for (let i = 0; i < loose.length; i += 500) {
      written.push(...tx.update(lots).set({ crewId: null }).where(inArray(lots.id, loose.slice(i, i + 500).map((l) => l.id))).returning().all());
    }
    tx.update(crews).set({ areaId: null }).where(eq(crews.areaId, area.id)).run();
    tx.delete(crewAreas).where(eq(crewAreas.id, area.id)).run();
  });
  emitOrPoke(written, scope);
  notify(area.crewIds, scope.cc, `Area removed: ${area.label}`, `area-${area.id}`);
  return { unassigned: written.length };
};
// #endregion
