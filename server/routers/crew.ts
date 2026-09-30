import { TRPCError } from "@trpc/server";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { bus } from "../bus.ts";
import { db } from "../db/index.ts";
import { crews, LOT_STATUSES, lots, requests, trucks, type CommandCenter, type Crew, type Lot } from "../db/schema.ts";
import { cancelRequest, createRequest, getRequest, getType, latestPosition } from "../dispatch.ts";
import { bboxAround, haversine, type LatLng } from "../geo.ts";
import { emitLot } from "../lots-import.ts";
import { latestPositions, requestsWhere, requestViews } from "../queries.ts";
import { crewProcedure, router } from "../trpc.ts";

export const NEARBY_LOT_M = 400;

const crewPoint = (crew: Crew, cc: CommandCenter): LatLng => {
  const p = latestPosition("crew", crew.id);
  return p ? { lat: p.lat, lng: p.lng } : { lat: cc.lat, lng: cc.lng };
};

export interface CrewLot extends Lot {
  distanceM: number;
  mine: boolean;
}

/** Lots assigned to the crew, else lots at its CC or unassigned within 400 m. Nearest first. */
const lotsForCrew = (crew: Crew, cc: CommandCenter, eventId: number): CrewLot[] => {
  const at = crewPoint(crew, cc);
  const mine = db.select().from(lots).where(and(eq(lots.eventId, eventId), eq(lots.crewId, crew.id))).all();
  let rows: Array<Lot & { mine: boolean }>;
  if (mine.length > 0) {
    rows = mine.map((l) => ({ ...l, mine: true }));
  } else {
    const [w, s, e, n] = bboxAround(at, NEARBY_LOT_M);
    rows = db
      .select()
      .from(lots)
      .where(
        and(
          eq(lots.eventId, eventId),
          or(eq(lots.ccId, cc.id), isNull(lots.ccId)),
          sql`${lots.lng} between ${w} and ${e}`,
          sql`${lots.lat} between ${s} and ${n}`,
        ),
      )
      .all()
      .filter((l) => haversine(at, l) <= NEARBY_LOT_M)
      .map((l) => ({ ...l, mine: false }));
  }
  return rows.map((l) => ({ ...l, distanceM: haversine(at, l) })).sort((a, b) => a.distanceM - b.distanceM);
};

export const crewRouter = router({
  createRequest: crewProcedure
    .input(
      z.object({
        typeId: z.number().int(),
        qty: z.number().int().min(1).max(99),
        note: z.string().max(500).nullish(),
        lat: z.number().min(-90).max(90).nullish(),
        lng: z.number().min(-180).max(180).nullish(),
      }),
    )
    .mutation(({ ctx, input }) => {
      const type = getType(input.typeId);
      if (type.eventId !== ctx.event.id) throw new TRPCError({ code: "BAD_REQUEST", message: "Item not available" });
      const r = createRequest({
        crewId: ctx.crew.id,
        ccId: ctx.crew.ccId,
        dayId: ctx.crew.dayId,
        typeId: input.typeId,
        qty: input.qty,
        note: input.note ?? null,
        createdBy: "crew",
        lat: input.lat ?? null,
        lng: input.lng ?? null,
      });
      return requestViews([r])[0]!;
    }),

  myRequests: crewProcedure.query(({ ctx }) =>
    requestsWhere(and(eq(requests.crewId, ctx.crew.id), eq(requests.dayId, ctx.day.id))),
  ),

  cancel: crewProcedure.input(z.object({ id: z.number().int() })).mutation(({ ctx, input }) => {
    const r = getRequest(input.id);
    if (r.crewId !== ctx.crew.id) throw new TRPCError({ code: "FORBIDDEN", message: "Not this crew's request" });
    return requestViews([cancelRequest(r.id, "crew")])[0]!;
  }),

  lots: crewProcedure.query(({ ctx }) => lotsForCrew(ctx.crew, ctx.cc, ctx.event.id)),

  setLotStatus: crewProcedure
    .input(z.object({ lotId: z.number().int(), status: z.enum(LOT_STATUSES) }))
    .mutation(({ ctx, input }) => {
      const lot = db.select().from(lots).where(eq(lots.id, input.lotId)).get();
      if (!lot || lot.eventId !== ctx.event.id) throw new TRPCError({ code: "NOT_FOUND", message: "Lot not found" });
      const allowed =
        lot.crewId === ctx.crew.id ||
        lot.ccId === ctx.cc.id ||
        (lot.ccId === null && haversine(crewPoint(ctx.crew, ctx.cc), lot) <= NEARBY_LOT_M);
      if (!allowed) throw new TRPCError({ code: "FORBIDDEN", message: "Lot not at this command center" });
      const updated = db
        .update(lots)
        .set({ status: input.status, statusByCrewId: ctx.crew.id, statusAt: Date.now() })
        .where(eq(lots.id, lot.id))
        .returning()
        .get();
      emitLot(updated);
      return updated;
    }),

  /** Everything the crew map draws in one call. */
  map: crewProcedure.query(({ ctx }) => {
    const crew = ctx.crew;
    const me = latestPosition("crew", crew.id) ?? null;
    const active = db
      .select({ truckId: requests.truckId })
      .from(requests)
      .where(and(eq(requests.crewId, crew.id), eq(requests.dayId, ctx.day.id), inArray(requests.status, ["assigned", "en_route"])))
      .all();
    const truckIds = [...new Set(active.map((r) => r.truckId).filter((t): t is number => t !== null))];
    const myTrucks = truckIds.length === 0 ? [] : db.select().from(trucks).where(inArray(trucks.id, truckIds)).all();
    const truckPos = latestPositions("truck", truckIds);
    const mates =
      crew.companyId === null
        ? []
        : db
            .select()
            .from(crews)
            .where(and(eq(crews.dayId, crew.dayId), eq(crews.companyId, crew.companyId)))
            .all()
            .filter((c) => c.id !== crew.id);
    const matePos = latestPositions("crew", mates.map((m) => m.id));
    return {
      me,
      cc: ctx.cc,
      trucks: myTrucks.map((t) => ({ id: t.id, name: t.name, status: t.status, position: truckPos.get(t.id) ?? null })),
      lots: lotsForCrew(crew, ctx.cc, ctx.event.id),
      companyCrews: mates.map((m) => ({ id: m.id, number: m.number, position: matePos.get(m.id) ?? null })),
    };
  }),

  /** My requests and my lots, as they change. */
  onMine: crewProcedure.subscription(async function* ({ ctx, signal }) {
    const crewId = ctx.crew.id;
    for await (const msg of bus.listen(signal)) {
      if (msg.type === "request.changed" && msg.payload.request.crewId === crewId) yield msg;
      else if (msg.type === "lot.changed" && msg.payload.lot.crewId === crewId) yield msg;
      else if (msg.type === "broadcast" && msg.ccId === ctx.cc.id) yield msg;
    }
  }),
});
