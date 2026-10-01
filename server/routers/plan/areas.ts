import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { crewAreas, crews, type AreaPolygon, type CrewArea } from "../../db/schema.ts";
import type { LatLng } from "../../geo.ts";
import { teamNames } from "./common.ts";

// #region labels
/** "GM 2", "GM 9 & GM 10", "GM 9, GM 10 & GM 11": the way the printed sheet names a shared area. */
export const joinNames = (names: readonly string[]): string => {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} & ${names[names.length - 1]}`;
};

export interface AreaView {
  id: number;
  dayId: number;
  polygon: AreaPolygon | null;
  /** The override, else the crews' names joined in crew number order. */
  label: string;
  /** Member crews in crew number order. */
  crewIds: number[];
  /** CC and company of the first member; a shared area is one company at one CC. */
  ccId: number | null;
  companyId: number | null;
  /** The sharpie X: drawn hatched on maps and sheets (SPEC 19 Marks). */
  doNotTouch: boolean;
}

/** Every area of a day that has at least one crew, with its label. */
export const dayAreas = (dayId: number, names: Map<number, string> = teamNames(dayId)): AreaView[] => {
  const members = db
    .select({ id: crews.id, areaId: crews.areaId, ccId: crews.ccId, companyId: crews.companyId })
    .from(crews)
    .where(and(eq(crews.dayId, dayId), sql`${crews.areaId} is not null`))
    .orderBy(crews.number)
    .all();
  if (members.length === 0) return [];
  const rows = db.select().from(crewAreas).where(inArray(crewAreas.id, [...new Set(members.map((m) => m.areaId ?? 0))])).orderBy(crewAreas.id).all();
  return rows.map((a) => {
    const mine = members.filter((m) => m.areaId === a.id);
    return {
      id: a.id,
      dayId: a.dayId,
      polygon: a.polygon,
      label: a.label?.trim() || joinNames(mine.map((m) => names.get(m.id) ?? "")),
      crewIds: mine.map((m) => m.id),
      ccId: mine[0]?.ccId ?? null,
      companyId: mine[0]?.companyId ?? null,
      doNotTouch: a.doNotTouch === true,
    };
  });
};

/** Area labels by area id for a day. */
export const areaLabels = (dayId: number, names?: Map<number, string>): Map<number, string> => new Map(dayAreas(dayId, names).map((a) => [a.id, a.label]));
// #endregion

// #region writes
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Writer = typeof db | Tx;

/** Deletes areas of the day that no crew holds any more. Assignments pointing at one fall back to the company. */
export const pruneAreas = (dayId: number, w: Writer = db): number => {
  const held = w
    .select({ id: crews.areaId })
    .from(crews)
    .where(and(eq(crews.dayId, dayId), sql`${crews.areaId} is not null`))
    .all()
    .map((r) => r.id ?? 0);
  const where = held.length ? and(eq(crewAreas.dayId, dayId), notInArray(crewAreas.id, held)) : eq(crewAreas.dayId, dayId);
  return w.delete(crewAreas).where(where).returning({ id: crewAreas.id }).all().length;
};

/** A new area for the crews, which leave whatever area they held; emptied areas go. */
export const createSharedArea = (w: Writer, input: { eventId: number; dayId: number; crewIds: readonly number[]; polygon: AreaPolygon | null }): CrewArea => {
  const area = w.insert(crewAreas).values({ eventId: input.eventId, dayId: input.dayId, polygon: input.polygon }).returning().get();
  if (input.crewIds.length) w.update(crews).set({ areaId: area.id }).where(inArray(crews.id, [...input.crewIds])).run();
  pruneAreas(input.dayId, w);
  return area;
};

/**
 * The area the crews already share when it is exactly theirs, else a new one.
 * A given polygon replaces the reused area's rectangle.
 */
export const areaForCrews = (w: Writer, input: { eventId: number; dayId: number; crewIds: readonly number[]; polygon: AreaPolygon | null }): CrewArea => {
  const rows = w.select({ id: crews.id, areaId: crews.areaId }).from(crews).where(inArray(crews.id, [...input.crewIds])).all();
  const first = rows[0]?.areaId ?? null;
  if (first !== null && rows.length === input.crewIds.length && rows.every((r) => r.areaId === first)) {
    const holders = w.select({ n: sql<number>`count(*)` }).from(crews).where(eq(crews.areaId, first)).get()?.n ?? 0;
    if (holders === rows.length) {
      const area = w.select().from(crewAreas).where(eq(crewAreas.id, first)).get();
      if (area) {
        if (input.polygon) return w.update(crewAreas).set({ polygon: input.polygon }).where(eq(crewAreas.id, area.id)).returning().get();
        return area;
      }
    }
  }
  return createSharedArea(w, input);
};
// #endregion

// #region split
export interface SplitSide {
  key: string;
  center: LatLng;
  /** Work in tenths of a crew: low counts 1, high counts 2 (SPEC 16 capacity, 10 low or 5 high). */
  weight: number;
}

/**
 * Hands the sides of a shared area to its crews, whole sides only: sides are
 * ordered along the area's long axis (the main direction the side centres
 * spread in) and cut into runs of about equal work, one run per crew in
 * order, so each crew gets neighbouring block sides and its own list.
 */
export const splitSides = (sides: readonly SplitSide[], crewIds: readonly number[]): Map<string, number> => {
  const out = new Map<string, number>();
  if (crewIds.length === 0 || sides.length === 0) return out;
  if (crewIds.length === 1) {
    for (const s of sides) out.set(s.key, crewIds[0]!);
    return out;
  }
  // Principal axis of the centres in local metres.
  const lat0 = sides.reduce((n, s) => n + s.center.lat, 0) / sides.length;
  const lng0 = sides.reduce((n, s) => n + s.center.lng, 0) / sides.length;
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const pts = sides.map((s) => ({ s, x: (s.center.lng - lng0) * kx, y: (s.center.lat - lat0) * 111320 }));
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const p of pts) {
    sxx += p.x * p.x;
    syy += p.y * p.y;
    sxy += p.x * p.y;
  }
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const ux = Math.cos(theta);
  const uy = Math.sin(theta);
  const ordered = pts
    .map((p) => ({ ...p, t: p.x * ux + p.y * uy }))
    .sort((a, b) => a.t - b.t || a.s.key.localeCompare(b.s.key));
  const total = ordered.reduce((n, p) => n + Math.max(p.s.weight, 0), 0);
  const k = crewIds.length;
  let crew = 0;
  let run = 0;
  ordered.forEach((p, i) => {
    const left = ordered.length - i;
    // Every crew still waiting needs at least one side when there are enough to go round.
    const mustMove = crew < k - 1 && left <= k - 1 - crew && run > 0;
    const w = Math.max(p.s.weight, 0);
    const target = (total * (crew + 1)) / k;
    // Move on when this side lands the run further past its share than stopping short would leave it.
    const done = ordered.slice(0, i).reduce((n, q) => n + Math.max(q.s.weight, 0), 0);
    const overshoot = done + w - target;
    const shortfall = target - done;
    if (crew < k - 1 && run > 0 && (mustMove || (overshoot > 0 && overshoot > shortfall))) {
      crew++;
      run = 0;
    }
    out.set(p.s.key, crewIds[crew]!);
    run++;
  });
  return out;
};
// #endregion
