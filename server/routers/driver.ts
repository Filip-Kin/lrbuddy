import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { bus } from "../bus.ts";
import { db } from "../db/index.ts";
import { routes, sessions, trucks, type Truck } from "../db/schema.ts";
import {
  adjustStock,
  cancelRequest,
  deliverStop,
  getRequest,
  hasLowStock,
  markEnRoute,
  orderedStops,
  restocked,
  setReturning,
  stockFor,
  truckOrigin,
} from "../dispatch.ts";
import { directionsUrl, haversine } from "../geo.ts";
import { requestViews, type RequestView } from "../queries.ts";
import { driverProcedure, router } from "../trpc.ts";
import type { CommandCenter } from "../db/schema.ts";

export interface QueueStop {
  key: string;
  crewId: number | null;
  /** "Crew 7", or the green-entered label for a crewless stop. */
  name: string;
  companyName: string | null;
  leadName: string | null;
  leadPhone: string | null;
  items: RequestView[];
  notes: string[];
  lat: number;
  lng: number;
  status: "assigned" | "en_route";
  urgent: boolean;
  etaS: number | null;
  etaAt: number | null;
  /** Straight-line metres from the truck now. */
  distanceM: number;
  navigateUrl: string;
}

const buildQueue = (truck: Truck, cc: CommandCenter) => {
  const now = Date.now();
  const stops = orderedStops(truck.id, now);
  const route = db.select().from(routes).where(eq(routes.truckId, truck.id)).get() ?? null;
  const origin = truckOrigin(truck, cc);
  const views = new Map(requestViews(stops.flatMap((s) => s.requests)).map((v) => [v.id, v]));
  const out: QueueStop[] = stops.map((s) => {
    const items = s.requests.map((r) => views.get(r.id)!).filter(Boolean);
    const first = items[0];
    const leg = route?.legs.find((l) => l.key === s.key);
    return {
      key: s.key,
      crewId: s.crewId,
      name: s.crewId !== null ? (first?.crewName ?? "Crew") : (first?.label ?? "Pinned stop"),
      companyName: first?.companyName ?? null,
      leadName: first?.leadName ?? null,
      leadPhone: first?.leadPhone ?? null,
      items,
      notes: items.map((i) => i.note).filter((n): n is string => !!n),
      lat: s.lat,
      lng: s.lng,
      status: items.some((i) => i.status === "en_route") ? "en_route" : "assigned",
      urgent: s.urgent,
      etaS: leg?.etaS ?? null,
      etaAt: leg && route ? route.computedAt + leg.etaS * 1000 : null,
      distanceM: haversine(origin, s),
      navigateUrl: directionsUrl(s),
    };
  });
  const fresh = getTruckRow(truck.id);
  return {
    truck: fresh,
    cc,
    ccNavigateUrl: directionsUrl(cc),
    distanceToCcM: haversine(origin, cc),
    returning: fresh.status === "returning",
    lowStock: hasLowStock(truck.id),
    stops: out,
    routeComputedAt: route?.computedAt ?? null,
    engine: route?.engine ?? null,
  };
};

const getTruckRow = (id: number): Truck => {
  const t = db.select().from(trucks).where(eq(trucks.id, id)).get();
  if (!t) throw new TRPCError({ code: "NOT_FOUND", message: "Truck not found" });
  return t;
};

const stopKey = z.string().regex(/^(crew|req):\d+$/);

export const driverRouter = router({
  queue: driverProcedure.query(({ ctx }) => buildQueue(ctx.truck, ctx.cc)),

  route: driverProcedure.query(({ ctx }) => {
    const route = db.select().from(routes).where(eq(routes.truckId, ctx.truck.id)).get() ?? null;
    return { route, origin: truckOrigin(ctx.truck, ctx.cc), cc: ctx.cc, stops: buildQueue(ctx.truck, ctx.cc).stops };
  }),

  enRoute: driverProcedure.input(z.object({ stopKey })).mutation(({ ctx, input }) => {
    markEnRoute(ctx.truck.id, input.stopKey);
    return buildQueue(ctx.truck, ctx.cc);
  }),

  deliver: driverProcedure.input(z.object({ stopKey })).mutation(({ ctx, input }) => {
    const done = deliverStop(ctx.truck.id, input.stopKey);
    if (done.length === 0) throw new TRPCError({ code: "BAD_REQUEST", message: "Stop already closed" });
    return buildQueue(ctx.truck, ctx.cc);
  }),

  cancel: driverProcedure
    .input(z.object({ requestId: z.number().int(), note: z.string().trim().min(1).max(300) }))
    .mutation(({ ctx, input }) => {
      const r = getRequest(input.requestId);
      if (r.truckId !== ctx.truck.id) throw new TRPCError({ code: "FORBIDDEN", message: "Not on this truck" });
      cancelRequest(r.id, "driver", input.note);
      return buildQueue(ctx.truck, ctx.cc);
    }),

  stock: driverProcedure.query(({ ctx }) => stockFor(ctx.truck.id)),

  adjustStock: driverProcedure
    .input(z.object({ typeId: z.number().int(), delta: z.number().int().min(-100).max(100) }))
    .mutation(({ ctx, input }) => adjustStock(ctx.truck.id, input.typeId, input.delta)),

  setReturning: driverProcedure.input(z.object({ returning: z.boolean() })).mutation(({ ctx, input }) => {
    setReturning(ctx.truck.id, input.returning);
    return buildQueue(ctx.truck, ctx.cc);
  }),

  restocked: driverProcedure.mutation(({ ctx }) => {
    restocked(ctx.truck.id);
    return buildQueue(ctx.truck, ctx.cc);
  }),

  setName: driverProcedure.input(z.object({ name: z.string().trim().min(1).max(60) })).mutation(({ ctx, input }) => {
    db.update(trucks).set({ driverName: input.name }).where(eq(trucks.id, ctx.truck.id)).run();
    db.update(sessions).set({ displayName: input.name }).where(eq(sessions.id, ctx.session.id)).run();
    return { name: input.name };
  }),

  /** Route and stock changes for my truck. */
  onRoute: driverProcedure.subscription(async function* ({ ctx, signal }) {
    const truckId = ctx.truck.id;
    for await (const msg of bus.listen(signal)) {
      if (msg.type === "route.changed" && msg.payload.truckId === truckId) yield msg;
      else if (msg.type === "stock.changed" && msg.payload.truckId === truckId) yield msg;
    }
  }),
});
