import { eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../db/index.ts";
import { assignments, commandCenters, companies, days, type Assignment } from "../../db/schema.ts";
import { blockSides, crewsNeeded, SURVEY_RULES, type BlockSide } from "../../parcels.ts";
import { adminProcedure, router } from "../../trpc.ts";
import { eventInput, eventOrActive } from "./common.ts";
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
  for (const d of dayRows) for (const [k, v] of teamNames(d.id)) names.set(k, v);
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
      crewName: r.crewId !== null ? (names.get(r.crewId) ?? null) : null,
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
});
