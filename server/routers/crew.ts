import { TRPCError } from "@trpc/server";
import { and, desc, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { holdsGreen } from "../auth.ts";
import { bus } from "../bus.ts";
import { db } from "../db/index.ts";
import { crews, LOT_GRADES, LOT_STATUSES, lots, requests, trucks, type CommandCenter, type Crew, type Lot } from "../db/schema.ts";
import { cancelRequest, createRequest, crewLabel, getRequest, getType, latestPosition } from "../dispatch.ts";
import { bboxAround, haversine, type LatLng } from "../geo.ts";
import { bareParcelsFor, crewRect, lotsInCrewRect, setLot } from "../parcel-status.ts";
import { photoSummary } from "../photos.ts";
import { latestPositions, requestsWhere, requestViews, siteCcIds } from "../queries.ts";
import { crewProcedure, liveFor, readCcScope, router, sameCc } from "../trpc.ts";

export const NEARBY_LOT_M = 400;
/** A second identical request inside this window is a double tap or a retry, not a new ask. */
export const DUPLICATE_WINDOW_MS = 15_000;

const crewPoint = (crew: Crew, cc: CommandCenter): LatLng => {
  const p = latestPosition("crew", crew.id);
  return p ? { lat: p.lat, lng: p.lng } : { lat: cc.lat, lng: cc.lng };
};

export interface CrewLot extends Lot {
  distanceM: number;
  mine: boolean;
  /** Newest live before and after photo ids, for the inline thumbs. */
  photos: { before: number | null; after: number | null };
}

/**
 * SPEC 21: a crew with a rectangle sees the lots inside it and nothing else.
 * Without one: lots assigned to the crew, else lots within 400 m that are at
 * its CC or at no CC and not assigned to another crew. Nearest first. Not todo
 * lots are left out unless `withNotTodo` (the map draws them as outlines).
 */
const lotsForCrew = (crew: Crew, cc: CommandCenter, eventId: number, withNotTodo = false): CrewLot[] => {
  const at = crewPoint(crew, cc);
  const inRect = lotsInCrewRect(crew, eventId, cc);
  const mine = inRect ? [] : db.select().from(lots).where(and(eq(lots.eventId, eventId), eq(lots.crewId, crew.id))).all();
  let rows: Array<Lot & { mine: boolean }>;
  if (inRect) {
    rows = inRect.map((l) => ({ ...l, mine: l.crewId === crew.id }));
  } else if (mine.length > 0) {
    rows = mine.map((l) => ({ ...l, mine: true }));
  } else {
    const [w, s, e, n] = bboxAround(at, NEARBY_LOT_M);
    rows = db
      .select()
      .from(lots)
      .where(
        and(
          eq(lots.eventId, eventId),
          or(inArray(lots.ccId, siteCcIds(cc.id)), isNull(lots.ccId)),
          // Free, or held by a crew row from another day.
          sql`(${lots.crewId} is null or ${lots.crewId} not in (select ${crews.id} from ${crews} where ${crews.dayId} = ${crew.dayId}))`,
          sql`${lots.lng} between ${w} and ${e}`,
          sql`${lots.lat} between ${s} and ${n}`,
        ),
      )
      .all()
      .filter((l) => haversine(at, l) <= NEARBY_LOT_M)
      .map((l) => ({ ...l, mine: false }));
  }
  if (!withNotTodo) rows = rows.filter((l) => l.status !== "not_todo");
  const photos = rows.length > 0 ? photoSummary(eventId) : new Map<number, { before: number | null; after: number | null }>();
  return rows
    .map((l) => {
      const p = photos.get(l.id);
      return { ...l, distanceM: haversine(at, l), photos: { before: p?.before ?? null, after: p?.after ?? null } };
    })
    .sort((a, b) => a.distanceM - b.distanceM);
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
      if (type.eventId !== ctx.event.id || !type.active) throw new TRPCError({ code: "BAD_REQUEST", message: "Item not available" });
      const note = input.note?.trim() || null;
      if (type.key === "other" && !note) throw new TRPCError({ code: "BAD_REQUEST", message: "Item name required" });
      const now = Date.now();
      // A double tap or a retried POST on a weak signal sends the same thing twice.
      const dup = db
        .select()
        .from(requests)
        .where(
          and(
            eq(requests.crewId, ctx.crew.id),
            eq(requests.typeId, type.id),
            eq(requests.qty, input.qty),
            gte(requests.createdAt, now - DUPLICATE_WINDOW_MS),
            inArray(requests.status, ["open", "assigned", "en_route"]),
          ),
        )
        .orderBy(desc(requests.createdAt))
        .all()
        .find((r) => (r.note ?? null) === note);
      if (dup) return requestViews([dup])[0]!;
      const r = createRequest(
        {
          crewId: ctx.crew.id,
          ccId: ctx.crew.ccId,
          dayId: ctx.crew.dayId,
          typeId: input.typeId,
          qty: input.qty,
          note,
          createdBy: "crew",
          lat: input.lat ?? null,
          lng: input.lng ?? null,
        },
        now,
      );
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

  /** True when the crew has a rectangle: its lots list is then "the lots in its area" (SPEC 21). */
  hasArea: crewProcedure.query(({ ctx }) => crewRect(ctx.crew) !== null),

  /**
   * Status of a lot or a bare parcel inside the crew's rectangle (SPEC 21):
   * Todo, In progress, Done, Not todo. Do not touch is for green shirts.
   */
  setLotStatus: crewProcedure
    .input(
      z.object({
        lotId: z.number().int().nullish(),
        parcelId: z.string().min(1).max(40).nullish(),
        status: z.enum(LOT_STATUSES).optional(),
        grade: z.enum(LOT_GRADES).nullish(),
      }),
    )
    .mutation(({ ctx, input }) => {
      const patch = { lotId: input.lotId, parcelId: input.parcelId, status: input.status, grade: input.grade };
      try {
        return setLot({ role: "crew", cc: ctx.cc, day: ctx.day, event: ctx.event, crew: ctx.crew }, patch, ctx.session.displayName);
      } catch (err) {
        // A red shirt whose user also holds green at this CC may do what a green shirt may (SPEC 27).
        if (!(err instanceof TRPCError) || err.code !== "FORBIDDEN" || !holdsGreen(ctx.session.userId, ctx.cc.id)) throw err;
        return setLot({ role: "green", cc: ctx.cc, day: ctx.day, event: ctx.event, crew: null }, patch, ctx.session.displayName);
      }
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
      lots: lotsForCrew(crew, ctx.cc, ctx.event.id, true),
      /** The crew's rectangle ([lng, lat] ring) and the bare parcels inside it; the map fits to it. */
      area: crewRect(crew),
      bare: bareParcelsFor({ role: "crew", cc: ctx.cc, day: ctx.day, event: ctx.event, crew }),
      companyCrews: mates.map((m) => ({ id: m.id, number: m.number, name: crewLabel(m), position: matePos.get(m.id) ?? null })),
    };
  }),

  /** My requests and my lots, as they change. */
  onMine: crewProcedure.subscription(async function* ({ ctx, signal }) {
    const crewId = ctx.crew.id;
    const sessionId = ctx.session.id;
    const start = { ccId: ctx.cc.id, dayId: ctx.day.id };
    for await (const item of liveFor(signal, start, () => readCcScope(sessionId, null), sameCc)) {
      if (item.kind !== "event") continue;
      const { msg, scope } = item;
      if (msg.type === "request.changed" && msg.payload.request.crewId === crewId) yield msg;
      else if (msg.type === "lot.changed" && msg.payload.lot.crewId === crewId) yield msg;
      else if (msg.type === "broadcast" && msg.ccId === scope.ccId) yield msg;
    }
  }),
});
