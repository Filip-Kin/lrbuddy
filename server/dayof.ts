/**
 * Day-of actions on the green map (SPEC 19, Marks): a rectangle (crew area) or
 * one block side marked Done or Do not touch, and a rectangle handed to
 * another company's crews. Every change emits lot.changed and pushes the crews
 * involved.
 *
 * What belongs to a rectangle: the block sides assigned to it on the day at
 * the CC (to its shared area, or to one of its crews), and the lots at the CC's
 * site on those sides, plus any other lot of its crews. "Unfinished" is open or
 * in progress; done and skipped lots are left as they are.
 */
import { TRPCError } from "@trpc/server";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "./db/index.ts";
import { assignments, companies, crewAreas, crews, lots, parcels, type CommandCenter, type Day, type Lot, type LotStatus } from "./db/schema.ts";
import { emitLot, titleCase } from "./lots-import.ts";
import { blockSideLabel, parseKey } from "./parcels.ts";
import { pushToCrew } from "./push.ts";
import { crewIdsOnDay, siteCcIds } from "./queries.ts";
import { dayAreas, joinNames, pruneAreas, splitSides, type AreaView } from "./routers/plan/areas.ts";
import { sideShapes, type Ring } from "./routers/plan/blocks.ts";
import { teamNames } from "./routers/plan/common.ts";

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
  skipped: number;
}

const emptyCounts = (): Counts => ({ open: 0, inProgress: 0, done: 0, skipped: 0 });
const count = (list: readonly Lot[]): Counts => {
  const c = emptyCounts();
  for (const l of list) {
    if (l.status === "open") c.open++;
    else if (l.status === "in_progress") c.inProgress++;
    else if (l.status === "done") c.done++;
    else c.skipped++;
  }
  return c;
};

const badRequest = (message: string): TRPCError => new TRPCError({ code: "BAD_REQUEST", message });
const notHere = (what: string): TRPCError => new TRPCError({ code: "NOT_FOUND", message: `${what} not at this command center` });

// #region reading the CC's day
interface Snapshot {
  areas: AreaView[];
  /** Assigned block sides at the CC on the day, in assignment order. */
  sides: Array<{ key: string; areaId: number | null; crewId: number | null; companyId: number | null }>;
  lots: Lot[];
  sideOfParcel: Map<string, string>;
  /** "W Boston Blvd" per block side key, from the parcels' addresses. */
  streetOf: Map<string, string>;
  names: Map<number, string>;
}

const ADDRESS = /^\s*\d+[A-Z]?\s+(.+?)\s*$/i;

const snapshot = ({ cc, day }: Scope): Snapshot => {
  const names = teamNames(day.id);
  const areas = dayAreas(day.id, names).filter((a) => a.ccId === cc.id);
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
    return [{ key: x.key, label: sideName(s, x.key), ring, areaId: x.areaId, companyId: x.companyId, counts: count(lotsOnSide(s, x.key)) }];
  });
  const crewRows = db.select().from(crews).where(and(eq(crews.dayId, scope.day.id), eq(crews.ccId, scope.cc.id))).orderBy(crews.number).all();
  const here = companyRows
    .filter((c) => crewRows.some((r) => r.companyId === c.id))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((c) => ({
      id: c.id,
      name: c.name,
      crews: crewRows.filter((r) => r.companyId === c.id).map((r) => ({ id: r.id, name: s.names.get(r.id) ?? `Crew ${r.number}`, areaId: r.areaId })),
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
const mark = (list: readonly Lot[], status: "done" | "skipped"): Lot[] => {
  const ids = list.filter((l) => UNFINISHED.includes(l.status)).map((l) => l.id);
  if (ids.length === 0) return [];
  const set = status === "done" ? { status, statusAt: Date.now(), statusByCrewId: null } : { status, statusAt: Date.now(), statusByCrewId: null, note: DO_NOT_TOUCH };
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
  const written = mark(inArea, action === "done" ? "done" : "skipped");
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
  const written = mark(onSide, action === "done" ? "done" : "skipped");
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
