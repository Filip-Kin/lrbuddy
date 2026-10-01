import { TRPCError } from "@trpc/server";
import { eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { alleyById, alleyView, setAlleyStatus, type AlleyView } from "../alleys.ts";
import { db } from "../db/index.ts";
import { ALLEY_STATUSES, alleys, commandCenters, crews, days, trucks, type Session } from "../db/schema.ts";
import { activeEvent } from "../queries.ts";
import { authedProcedure, router } from "../trpc.ts";

const forbidden = (): TRPCError => new TRPCError({ code: "FORBIDDEN", message: "Not allowed" });

/** The CC a field session works at; null for admin (every CC) and for a session with none. */
const sessionCc = (s: Session): number | null => {
  if (s.role === "driver" && s.truckId !== null) return db.select({ ccId: trucks.ccId }).from(trucks).where(eq(trucks.id, s.truckId)).get()?.ccId ?? null;
  if (s.role === "crew" && s.crewId !== null) return db.select({ ccId: crews.ccId }).from(crews).where(eq(crews.id, s.crewId)).get()?.ccId ?? null;
  if (s.role === "green") return s.ccId;
  return null;
};

const bounds = (v: AlleyView): { w: number; s: number; e: number; n: number } => {
  const ring = v.polygon.coordinates[0] ?? [];
  const lngs = ring.map((p) => p[0] ?? 0);
  const lats = ring.map((p) => p[1] ?? 0);
  return { w: Math.min(...lngs), e: Math.max(...lngs), s: Math.min(...lats), n: Math.max(...lats) };
};

export const alleysRouter = router({
  /**
   * Alleys in a map's view (SPEC 19). Field roles see their own CC's; admin
   * sees every CC of the active event.
   */
  inView: authedProcedure
    .input(z.object({ w: z.number(), s: z.number(), e: z.number(), n: z.number() }))
    .query(({ ctx, input }): AlleyView[] => {
      const s = ctx.session;
      let rows;
      if (s.role === "admin") {
        const ev = activeEvent();
        if (!ev) return [];
        const ccIds = db
          .select({ id: commandCenters.id })
          .from(commandCenters)
          .innerJoin(days, eq(days.id, commandCenters.dayId))
          .where(eq(days.eventId, ev.id))
          .all()
          .map((c) => c.id);
        rows = ccIds.length ? db.select().from(alleys).where(inArray(alleys.ccId, ccIds)).all() : [];
      } else {
        const ccId = sessionCc(s);
        if (ccId === null) return [];
        rows = db.select().from(alleys).where(eq(alleys.ccId, ccId)).all();
      }
      return rows.map(alleyView).filter((v) => {
        const b = bounds(v);
        return b.w <= input.e && b.e >= input.w && b.s <= input.n && b.n >= input.s;
      });
    }),

  /** Todo, In progress, Done, Do not touch: greens and drivers at the alley's CC, and admin. */
  setStatus: authedProcedure.input(z.object({ id: z.number().int(), status: z.enum(ALLEY_STATUSES) })).mutation(({ ctx, input }): AlleyView => {
    const s = ctx.session;
    const alley = alleyById(input.id);
    if (!alley) throw new TRPCError({ code: "NOT_FOUND", message: "Alley not found" });
    if (s.role !== "admin") {
      if (s.role !== "green" && s.role !== "driver") throw forbidden();
      if (sessionCc(s) !== alley.ccId) throw forbidden();
    }
    if (alley.status === input.status) return alleyView(alley);
    const v = setAlleyStatus(alley.id, input.status);
    if (!v) throw new TRPCError({ code: "NOT_FOUND", message: "Alley not found" });
    return v;
  }),
});
