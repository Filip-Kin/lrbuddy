import { TRPCError } from "@trpc/server";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../db/index.ts";
import { commandCenters, companies, crews, days, type CommandCenter, type Crew, type Day } from "../../db/schema.ts";
import { activeEvent } from "../../queries.ts";

// #region inputs
export const id = z.number().int();
export const bboxInput = z.tuple([z.number(), z.number(), z.number(), z.number()]);
/** A closed GeoJSON ring in WGS84: [lng, lat] pairs, first equal to last. */
export const areaInput = z.object({
  type: z.literal("Polygon"),
  coordinates: z.array(z.array(z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)])).min(4).max(64)).length(1),
});
export const eventInput = { eventId: id.nullish() };
// #endregion

// #region scope
export const notFound = (what: string): TRPCError => new TRPCError({ code: "NOT_FOUND", message: `${what} not found` });
export const badRequest = (message: string): TRPCError => new TRPCError({ code: "BAD_REQUEST", message });

/** The event a portal call works on: the one asked for, else the active one. */
export const eventOrActive = (eventId: number | null | undefined): number => {
  if (eventId != null) return eventId;
  const ev = activeEvent();
  if (!ev) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "No active event" });
  return ev.id;
};

export const dayOfEvent = (dayId: number, eventId: number): Day => {
  const day = db.select().from(days).where(eq(days.id, dayId)).get();
  if (!day || day.eventId !== eventId) throw notFound("Day");
  return day;
};

export const ccOfDay = (ccId: number, dayId: number): CommandCenter => {
  const cc = db.select().from(commandCenters).where(eq(commandCenters.id, ccId)).get();
  if (!cc || cc.dayId !== dayId) throw notFound("Command center");
  return cc;
};
// #endregion

// #region crew names
/**
 * Portal names for a day's crews: company name plus the crew's place among
 * that company's crews by number, "Ford 1", "Ford 2". Crews without a company
 * keep "Crew 7".
 */
export const teamNames = (dayId: number): Map<number, string> => {
  const rows = db
    .select({ id: crews.id, number: crews.number, company: companies.name })
    .from(crews)
    .leftJoin(companies, eq(companies.id, crews.companyId))
    .where(eq(crews.dayId, dayId))
    .orderBy(crews.number)
    .all();
  const seen = new Map<string, number>();
  const out = new Map<number, string>();
  for (const r of rows) {
    if (!r.company) {
      out.set(r.id, `Crew ${r.number}`);
      continue;
    }
    const n = (seen.get(r.company) ?? 0) + 1;
    seen.set(r.company, n);
    out.set(r.id, `${r.company} ${n}`);
  }
  return out;
};

export const crewsByIds = (ids: readonly number[]): Map<number, Crew> =>
  new Map(ids.length === 0 ? [] : db.select().from(crews).where(inArray(crews.id, [...new Set(ids)])).all().map((c) => [c.id, c]));

export const crewOfDay = (crewId: number, dayId: number): Crew => {
  const crew = db.select().from(crews).where(and(eq(crews.id, crewId), eq(crews.dayId, dayId))).get();
  if (!crew) throw notFound("Crew");
  return crew;
};
// #endregion
