import { TRPCError } from "@trpc/server";
import { and, between, eq } from "drizzle-orm";
import { z } from "zod";
import { bus } from "../bus.ts";
import { db } from "../db/index.ts";
import { lots, routes, sessions, trucks, type CommandCenter, type Manoeuvre, type Route, type Truck } from "../db/schema.ts";
import {
  adjustStock,
  cancelRequest,
  deliverStop,
  getRequest,
  legEtaAt,
  markEnRoute,
  orderedStops,
  pinNext,
  restocked,
  setReturning,
  stockFor,
  truckOrigin,
  type StockRow,
} from "../dispatch.ts";
import { bboxAround, directionsUrl, haversine, type LatLng } from "../geo.ts";
import { requestViews } from "../queries.ts";
import { driverProcedure, liveFor, readCcScope, router, sameCc } from "../trpc.ts";

// #region constants
/** A lot this close to a stop names the stop's street address. */
export const NEAR_LOT_M = 150;
/** The truck counts as at its CC inside this radius. */
export const AT_CC_M = 150;
/** A stop assigned this recently shows as new. */
export const NEW_STOP_MS = 3 * 60_000;
// #endregion

// #region types
export interface StopItem {
  id: number;
  typeLabel: string;
  unit: string;
  qty: number;
  note: string | null;
  status: "assigned" | "en_route";
  priority: number;
  createdAt: number;
  assignedAt: number | null;
  createdBy: "crew" | "green";
}

export interface QueueStop {
  key: string;
  crewId: number | null;
  /** "Crew 7", else the green-entered label, else the nearest lot address, else "Pinned stop". */
  name: string;
  companyName: string | null;
  /** Address of the nearest lot within 150 m; null when there is none or it is already the name. */
  nearAddress: string | null;
  leadName: string | null;
  leadPhone: string | null;
  items: StopItem[];
  lat: number;
  lng: number;
  status: "assigned" | "en_route";
  urgent: boolean;
  /** Oldest request of the stop. */
  waitingSince: number;
  /** Newest assignment to this truck. */
  assignedAt: number | null;
  /** Seconds from the route's computation to this stop; null before the route includes it. */
  etaS: number | null;
  /** Absolute ETA in unix ms; null before the route includes it. */
  etaAt: number | null;
  /** Straight-line metres from the truck now. */
  distanceM: number;
  navigateUrl: string;
}

export interface LowItem {
  typeId: number;
  label: string;
  qty: number;
  capacity: number;
}
// #endregion

// #region helpers
/** Nearest lot address within `maxM` of a point, for naming stops a driver has to find. */
export const nearestLotAddress = (eventId: number, p: LatLng, maxM = NEAR_LOT_M): string | null => {
  const [w, s, e, n] = bboxAround(p, maxM);
  const rows = db
    .select({ address: lots.address, lat: lots.lat, lng: lots.lng })
    .from(lots)
    .where(and(eq(lots.eventId, eventId), between(lots.lat, s, n), between(lots.lng, w, e)))
    .all();
  let best: { address: string; d: number } | null = null;
  for (const r of rows) {
    if (!r.address || r.address.trim() === "") continue;
    const d = haversine(p, r);
    if (d <= maxM && (!best || d < best.d)) best = { address: r.address.trim(), d };
  }
  return best?.address ?? null;
};

const titleCase = (s: string): string =>
  /[a-z]/.test(s) ? s : s.toLowerCase().replace(/\b([a-z])/g, (c) => c.toUpperCase());

const getTruckRow = (id: number): Truck => {
  const t = db.select().from(trucks).where(eq(trucks.id, id)).get();
  if (!t) throw new TRPCError({ code: "NOT_FOUND", message: "Truck not found" });
  return t;
};

const routeOf = (truckId: number): Route | null => db.select().from(routes).where(eq(routes.truckId, truckId)).get() ?? null;
// #endregion

// #region queue
/** Everything the driver's queue, map and stock pill need, in route order. */
export const buildQueue = (truckId: number, cc: CommandCenter, eventId: number, now = Date.now()) => {
  const truck = getTruckRow(truckId);
  const stops = orderedStops(truckId, now);
  const route = routeOf(truckId);
  const origin = truckOrigin(truck, cc);
  const views = new Map(requestViews(stops.flatMap((s) => s.requests)).map((v) => [v.id, v]));

  const out: QueueStop[] = stops.map((s) => {
    const items: StopItem[] = [];
    for (const r of s.requests) {
      const v = views.get(r.id);
      if (!v || (v.status !== "assigned" && v.status !== "en_route")) continue;
      items.push({
        id: v.id,
        typeLabel: v.typeLabel,
        unit: v.unit,
        qty: v.qty,
        note: v.note,
        status: v.status,
        priority: v.priority,
        createdAt: v.createdAt,
        assignedAt: v.assignedAt,
        createdBy: v.createdBy,
      });
    }
    const first = s.requests[0] ? views.get(s.requests[0].id) : undefined;
    const leg = route?.legs.find((l) => l.key === s.key);
    const near = nearestLotAddress(eventId, s);
    const label = s.crewId === null ? (first?.label ?? null) : null;
    const name = s.crewId !== null ? (first?.crewName ?? "Crew") : (label ?? (near ? titleCase(near) : "Pinned stop"));
    const nearAddress = near && name !== titleCase(near) ? titleCase(near) : null;
    return {
      key: s.key,
      crewId: s.crewId,
      name,
      companyName: first?.companyName ?? null,
      nearAddress,
      leadName: first?.leadName ?? null,
      leadPhone: first?.leadPhone ?? null,
      items,
      lat: s.lat,
      lng: s.lng,
      status: items.some((i) => i.status === "en_route") ? "en_route" : "assigned",
      urgent: s.urgent,
      waitingSince: Math.min(...s.requests.map((r) => r.createdAt)),
      assignedAt: s.requests.reduce<number | null>((m, r) => (r.assignedAt !== null && (m === null || r.assignedAt > m) ? r.assignedAt : m), null),
      etaS: leg?.etaS ?? null,
      etaAt: leg && route ? legEtaAt(route, leg, truck, now) : null,
      distanceM: haversine(origin, s),
      navigateUrl: directionsUrl(s),
    };
  });

  const stock = stockFor(truckId);
  const low: LowItem[] = stock.filter((s) => s.low).map((s) => ({ typeId: s.typeId, label: s.label, qty: s.qty, capacity: s.capacity }));
  const ccLeg = route?.legs.find((l) => l.key === "cc");
  const distanceToCcM = haversine(origin, cc);
  const belowCapacity = stock.some((s) => s.qty < s.capacity);

  return {
    truck: { id: truck.id, name: truck.name, driverName: truck.driverName, status: truck.status },
    cc: { id: cc.id, name: cc.name, letter: cc.letter, address: cc.address, lat: cc.lat, lng: cc.lng },
    ccNavigateUrl: directionsUrl(cc),
    distanceToCcM,
    atCc: distanceToCcM <= AT_CC_M,
    ccEtaAt: ccLeg && route ? legEtaAt(route, ccLeg, truck, now) : null,
    returning: truck.status === "returning",
    belowCapacity,
    lowStock: low.length > 0,
    low,
    stops: out,
    /** Key of the stop the driver made next, while it is still on the truck. */
    pinnedKey: truck.pinnedStopKey !== null && out.some((x) => x.key === truck.pinnedStopKey) ? truck.pinnedStopKey : null,
    origin,
    route: route
      ? {
          computedAt: route.computedAt,
          engine: route.engine,
          distanceM: route.distanceM,
          durationS: route.durationS,
          endsAtCc: route.endsAtCc,
        }
      : null,
  };
};

export type DriverQueue = ReturnType<typeof buildQueue>;
// #endregion

const stopKey = z.string().regex(/^(crew|req):\d+$/);

export const driverRouter = router({
  queue: driverProcedure.query(({ ctx }) => buildQueue(ctx.truck.id, ctx.cc, ctx.event.id)),

  /**
   * Route line, per-leg manoeuvres and stops for the map. `legs` is in visit
   * order; a leg's steps lead from the stop before it (or the truck) to it.
   */
  route: driverProcedure.query(({ ctx }) => {
    const route = routeOf(ctx.truck.id);
    const queue = buildQueue(ctx.truck.id, ctx.cc, ctx.event.id);
    const legs: Array<{ key: string; steps: Manoeuvre[] }> = route?.legs.map((l) => ({ key: l.key, steps: l.steps ?? [] })) ?? [];
    return { geometry: route?.geometry ?? [], engine: route?.engine ?? null, legs, queue };
  }),

  /** Makes a stop next. The route keeps it first until it is delivered. */
  pinNext: driverProcedure.input(z.object({ stopKey })).mutation(({ ctx, input }) => {
    pinNext(ctx.truck.id, input.stopKey);
    return buildQueue(ctx.truck.id, ctx.cc, ctx.event.id);
  }),

  enRoute: driverProcedure.input(z.object({ stopKey })).mutation(({ ctx, input }) => {
    markEnRoute(ctx.truck.id, input.stopKey);
    return buildQueue(ctx.truck.id, ctx.cc, ctx.event.id);
  }),

  deliver: driverProcedure.input(z.object({ stopKey })).mutation(({ ctx, input }) => {
    const done = deliverStop(ctx.truck.id, input.stopKey);
    if (done.length === 0) throw new TRPCError({ code: "BAD_REQUEST", message: "Stop already closed" });
    return buildQueue(ctx.truck.id, ctx.cc, ctx.event.id);
  }),

  /** Driver cancel: en route items only, one reason for all of them. */
  cancel: driverProcedure
    .input(z.object({ requestIds: z.array(z.number().int()).min(1).max(50), note: z.string().trim().min(1).max(300) }))
    .mutation(({ ctx, input }) => {
      const rows = input.requestIds.map((id) => getRequest(id));
      for (const r of rows) {
        if (r.truckId !== ctx.truck.id) throw new TRPCError({ code: "FORBIDDEN", message: "Not on this truck" });
        if (r.status !== "en_route") throw new TRPCError({ code: "BAD_REQUEST", message: "Mark En route first" });
      }
      for (const r of rows) cancelRequest(r.id, "driver", input.note);
      return buildQueue(ctx.truck.id, ctx.cc, ctx.event.id);
    }),

  stock: driverProcedure.query(({ ctx }): StockRow[] => stockFor(ctx.truck.id)),

  adjustStock: driverProcedure
    .input(z.object({ typeId: z.number().int(), delta: z.number().int().min(-100).max(100) }))
    .mutation(({ ctx, input }) => adjustStock(ctx.truck.id, input.typeId, input.delta)),

  /** Restock on: the CC becomes the final stop. Off: back to work. */
  setReturning: driverProcedure.input(z.object({ returning: z.boolean() })).mutation(({ ctx, input }) => {
    setReturning(ctx.truck.id, input.returning);
    return buildQueue(ctx.truck.id, ctx.cc, ctx.event.id);
  }),

  /** Restocked: every item back to capacity, restock off. */
  restocked: driverProcedure.mutation(({ ctx }) => {
    restocked(ctx.truck.id);
    return buildQueue(ctx.truck.id, ctx.cc, ctx.event.id);
  }),

  setName: driverProcedure.input(z.object({ name: z.string().trim().min(1).max(60) })).mutation(({ ctx, input }) => {
    db.update(trucks).set({ driverName: input.name }).where(eq(trucks.id, ctx.truck.id)).run();
    db.update(sessions).set({ displayName: input.name }).where(eq(sessions.id, ctx.session.id)).run();
    return { name: input.name };
  }),

  /** Route and stock changes for my truck. */
  onRoute: driverProcedure.subscription(async function* ({ ctx, signal }) {
    const truckId = ctx.truck.id;
    const sessionId = ctx.session.id;
    const start = { ccId: ctx.cc.id, dayId: ctx.day.id };
    for await (const item of liveFor(signal, start, () => readCcScope(sessionId, null), sameCc)) {
      if (item.kind !== "event") continue;
      const { msg } = item;
      if (msg.type === "route.changed" && msg.payload.truckId === truckId) yield msg;
      else if (msg.type === "stock.changed" && msg.payload.truckId === truckId) yield msg;
    }
  }),
});
