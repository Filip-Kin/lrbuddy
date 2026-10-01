import { eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../db/index.ts";
import { assignments, commandCenters, companies, days, parcels, type Assignment } from "../../db/schema.ts";
import { blockSides, crewsNeeded, outlinePoints, SURVEY_RULES, type BlockSide } from "../../parcels.ts";
import { adminProcedure, router } from "../../trpc.ts";
import { eventInput, eventOrActive } from "./common.ts";
import { areaLabels } from "./areas.ts";
import { teamNames } from "./common.ts";

export interface AssignmentInfo {
  id: number;
  dayId: number;
  dayLabel: string;
  ccId: number;
  ccName: string;
  companyId: number | null;
  companyName: string | null;
  crewId: number | null;
  /** Shared area the side went to; Publish splits its sides between the area's crews. */
  areaId: number | null;
  /** The crew's name, or the shared area's label ("GM 9 & GM 10"). */
  crewName: string | null;
  order: number;
}

/** Assignment rows of the event keyed by block side, with day, CC, company and crew names. */
export const assignmentInfo = (eventId: number): Map<string, AssignmentInfo> => {
  const rows: Assignment[] = db.select().from(assignments).where(eq(assignments.eventId, eventId)).all();
  const out = new Map<string, AssignmentInfo>();
  if (rows.length === 0) return out;
  const dayRows = db.select().from(days).where(inArray(days.id, [...new Set(rows.map((r) => r.dayId))])).all();
  const ccRows = db.select().from(commandCenters).where(inArray(commandCenters.id, [...new Set(rows.map((r) => r.ccId))])).all();
  const companyIds = [...new Set(rows.map((r) => r.companyId).filter((x): x is number => x !== null))];
  const companyRows = companyIds.length ? db.select().from(companies).where(inArray(companies.id, companyIds)).all() : [];
  const names = new Map<number, string>();
  const labels = new Map<number, string>();
  for (const d of dayRows) {
    const dayNames = teamNames(d.id);
    for (const [k, v] of dayNames) names.set(k, v);
    for (const [k, v] of areaLabels(d.id, dayNames)) labels.set(k, v);
  }
  for (const r of rows) {
    out.set(r.blockSideKey, {
      id: r.id,
      dayId: r.dayId,
      dayLabel: dayRows.find((d) => d.id === r.dayId)?.label ?? "",
      ccId: r.ccId,
      ccName: ccRows.find((c) => c.id === r.ccId)?.name ?? "",
      companyId: r.companyId,
      companyName: companyRows.find((c) => c.id === r.companyId)?.name ?? null,
      crewId: r.crewId,
      areaId: r.areaId,
      crewName: r.areaId !== null ? (labels.get(r.areaId) ?? null) : r.crewId !== null ? (names.get(r.crewId) ?? null) : null,
      order: r.order,
    });
  }
  return out;
};

export type BlockSideRow = BlockSide & { assignment: AssignmentInfo | null };

export const blockSideRows = (eventId: number): BlockSideRow[] => {
  const info = assignmentInfo(eventId);
  return blockSides(eventId).map((b) => ({ ...b, assignment: info.get(b.key) ?? null }));
};

// #region shapes
/** Closed ring of [lng, lat] pairs, the GeoJSON order. */
export type Ring = Array<[number, number]>;

/**
 * Convex hull of the points (Andrew's monotone chain), as a closed ring.
 * Degrees are treated as flat; over one block the skew is far under a metre.
 */
export const convexHull = (pts: ReadonlyArray<readonly [number, number]>): Ring => {
  const list = [...new Map(pts.map((p) => [`${p[0]},${p[1]}`, [p[0], p[1]] as [number, number]])).values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (list.length < 3) return list.length === 0 ? [] : [...list, list[0]!];
  const cross = (o: [number, number], a: [number, number], b: [number, number]): number => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Ring = [];
  for (const p of list) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Ring = [];
  for (let i = list.length - 1; i >= 0; i--) {
    const p = list[i]!;
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) upper.pop();
    upper.push(p);
  }
  const hull = [...lower.slice(0, -1), ...upper.slice(0, -1)];
  return [...hull, hull[0]!];
};

/** One outline per block side the event's survey touched: the hull of its parcels' outlines. */
export const blockSideShapes = (eventId: number): Array<{ key: string; ring: Ring }> => {
  const keys = blockSides(eventId).map((b) => b.key);
  const pts = new Map<string, Array<[number, number]>>();
  for (let i = 0; i < keys.length; i += 500) {
    const rows = db
      .select({ key: parcels.blockSideKey, geometry: parcels.geometry })
      .from(parcels)
      .where(inArray(parcels.blockSideKey, keys.slice(i, i + 500)))
      .all();
    for (const r of rows) {
      if (!r.key || !r.geometry) continue;
      const list = pts.get(r.key) ?? [];
      for (const p of outlinePoints(r.geometry)) list.push([Math.round(p.lng * 1e6) / 1e6, Math.round(p.lat * 1e6) / 1e6]);
      pts.set(r.key, list);
    }
  }
  const out: Array<{ key: string; ring: Ring }> = [];
  for (const [key, list] of pts) {
    const ring = convexHull(list);
    if (ring.length >= 4) out.push({ key, ring });
  }
  return out;
};
// #endregion

const capacityInput = z
  .object({
    perCrewParcels: z.number().int().min(1).max(100).optional(),
    perCrewHigh: z.number().int().min(1).max(100).optional(),
    ...eventInput,
  })
  .optional();

export const blocksRouter = router({
  /** Every block side the survey touched, most work first, with its assignment. */
  list: adminProcedure.input(z.object({ ...eventInput }).optional()).query(({ input }) => blockSideRows(eventOrActive(input?.eventId))),
  /** The Blocks totals bar. Crews needed uses the per-crew capacity, default 10 parcels or 5 high. */
  totals: adminProcedure.input(capacityInput).query(({ input }) => {
    const rows = blockSideRows(eventOrActive(input?.eventId));
    const perCrewParcels = input?.perCrewParcels ?? SURVEY_RULES.perCrewParcels;
    const perCrewHigh = input?.perCrewHigh ?? SURVEY_RULES.perCrewHigh;
    let high = 0;
    let low = 0;
    let assignedWork = 0;
    let assignedSides = 0;
    for (const r of rows) {
      high += r.high;
      low += r.low;
      if (r.assignment) {
        assignedSides++;
        assignedWork += r.workCount;
      }
    }
    return {
      workParcels: high + low,
      high,
      low,
      sides: rows.length,
      sidesDark: rows.filter((r) => r.workCount >= SURVEY_RULES.darkAt).length,
      assignedSides,
      assignedWork,
      perCrewParcels,
      perCrewHigh,
      crewsNeeded: crewsNeeded(high, low, perCrewParcels, perCrewHigh),
    };
  }),
  /** Map outlines for the block sides in `list`, keyed the same way. */
  shapes: adminProcedure.input(z.object({ ...eventInput }).optional()).query(({ input }) => blockSideShapes(eventOrActive(input?.eventId))),
});
