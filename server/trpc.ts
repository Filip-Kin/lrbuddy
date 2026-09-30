import { initTRPC, TRPCError } from "@trpc/server";
import type { FetchCreateContextFnOptions } from "@trpc/server/adapters/fetch";
import { eq } from "drizzle-orm";
import superjson from "superjson";
import { getSession, sessionIdFrom } from "./auth.ts";
import { markTruckSeen } from "./dispatch.ts";
import { db } from "./db/index.ts";
import {
  commandCenters,
  crews,
  days,
  events,
  trucks,
  type CommandCenter,
  type Crew,
  type Day,
  type Event,
  type Session,
  type Truck,
} from "./db/schema.ts";

export interface Context {
  session: Session | null;
  ip: string;
  /** CC an admin asked for with `?cc=` (header `x-lrb-cc` or SSE connection param `cc`). */
  ccOverride: number | null;
}

const parseCc = (v: string | null | undefined): number | null => {
  if (!v) return null;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

export const createContextFor =
  (ip: string) =>
  ({ req, info }: FetchCreateContextFnOptions): Context => ({
    session: getSession(sessionIdFrom(req)),
    ip,
    ccOverride: parseCc(req.headers.get("x-lrb-cc")) ?? parseCc(info.connectionParams?.cc),
  });

const t = initTRPC.context<Context>().create({
  transformer: superjson,
  // Stack traces stay on the server; error responses carry the message and code only.
  isDev: false,
  // Keeps SSE streams alive through proxies; the client reconnects if pings stop.
  sse: {
    ping: { enabled: true, intervalMs: 15_000 },
    client: { reconnectAfterInactivityMs: 40_000 },
  },
});

export const router = t.router;
export const middleware = t.middleware;
export const publicProcedure = t.procedure;

// #region scope helpers
const TOUCH_MS = 30_000;

const loadCcScope = (ccId: number): { cc: CommandCenter; day: Day; event: Event } => {
  const cc = db.select().from(commandCenters).where(eq(commandCenters.id, ccId)).get();
  if (!cc) throw new TRPCError({ code: "NOT_FOUND", message: "Command center not found" });
  const day = db.select().from(days).where(eq(days.id, cc.dayId)).get();
  if (!day) throw new TRPCError({ code: "NOT_FOUND", message: "Day not found" });
  const event = db.select().from(events).where(eq(events.id, day.eventId)).get();
  if (!event) throw new TRPCError({ code: "NOT_FOUND", message: "Event not found" });
  return { cc, day, event };
};

export const touchCrew = (crew: Crew, now = Date.now()): void => {
  if (crew.lastSeenAt === null || now - crew.lastSeenAt > TOUCH_MS) {
    db.update(crews).set({ lastSeenAt: now }).where(eq(crews.id, crew.id)).run();
    crew.lastSeenAt = now;
  }
};

export const touchTruck = (truck: Truck, now = Date.now()): void => {
  if (truck.lastSeenAt === null || now - truck.lastSeenAt > TOUCH_MS) markTruckSeen(truck, now);
};
// #endregion

// #region procedures
const unauthorized = (): TRPCError => new TRPCError({ code: "UNAUTHORIZED", message: "Sign in" });
const forbidden = (): TRPCError => new TRPCError({ code: "FORBIDDEN", message: "Not allowed" });

export const authedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.session) throw unauthorized();
  return next({ ctx: { ...ctx, session: ctx.session } });
});

export const crewProcedure = authedProcedure.use(({ ctx, next }) => {
  if (ctx.session.role !== "crew" || ctx.session.crewId === null) throw forbidden();
  const crew = db.select().from(crews).where(eq(crews.id, ctx.session.crewId)).get();
  if (!crew) throw unauthorized();
  touchCrew(crew);
  const scope = loadCcScope(crew.ccId);
  return next({ ctx: { ...ctx, crew, ...scope } });
});

export const driverProcedure = authedProcedure.use(({ ctx, next }) => {
  if (ctx.session.role !== "driver" || ctx.session.truckId === null) throw forbidden();
  const truck = db.select().from(trucks).where(eq(trucks.id, ctx.session.truckId)).get();
  if (!truck) throw unauthorized();
  touchTruck(truck);
  const scope = loadCcScope(truck.ccId);
  return next({ ctx: { ...ctx, truck, ...scope } });
});

/** Green shirts at their CC; admin too, at the CC named by `?cc=`. */
export const greenProcedure = authedProcedure.use(({ ctx, next }) => {
  const role = ctx.session.role;
  let ccId: number | null = null;
  if (role === "green") ccId = ctx.session.ccId;
  else if (role === "admin") {
    ccId = ctx.ccOverride;
    if (ccId === null) throw new TRPCError({ code: "BAD_REQUEST", message: "No command center" });
  } else throw forbidden();
  if (ccId === null) throw unauthorized();
  const scope = loadCcScope(ccId);
  return next({ ctx: { ...ctx, ...scope } });
});

export const adminProcedure = authedProcedure.use(({ ctx, next }) => {
  if (ctx.session.role !== "admin") throw forbidden();
  return next({ ctx });
});

/**
 * Any signed-in role with a CC in scope: crew and driver through their crew or
 * truck, green through the session, admin through `?cc=`.
 */
export const ccProcedure = authedProcedure.use(({ ctx, next }) => {
  const s = ctx.session;
  let ccId: number | null = null;
  let crew: Crew | null = null;
  let truck: Truck | null = null;
  if (s.role === "crew" && s.crewId !== null) {
    crew = db.select().from(crews).where(eq(crews.id, s.crewId)).get() ?? null;
    if (!crew) throw unauthorized();
    touchCrew(crew);
    ccId = crew.ccId;
  } else if (s.role === "driver" && s.truckId !== null) {
    truck = db.select().from(trucks).where(eq(trucks.id, s.truckId)).get() ?? null;
    if (!truck) throw unauthorized();
    touchTruck(truck);
    ccId = truck.ccId;
  } else if (s.role === "green") {
    ccId = s.ccId;
  } else if (s.role === "admin") {
    ccId = ctx.ccOverride;
  }
  if (ccId === null) throw new TRPCError({ code: "BAD_REQUEST", message: "No command center" });
  const scope = loadCcScope(ccId);
  return next({ ctx: { ...ctx, crew, truck, ...scope } });
});
// #endregion
