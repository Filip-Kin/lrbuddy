import { initTRPC, TRPCError } from "@trpc/server";
import type { FetchCreateContextFnOptions } from "@trpc/server/adapters/fetch";
import { eq } from "drizzle-orm";
import superjson from "superjson";
import { getSession, holdsGreen, isAdminSession, JOIN_COOKIE, parseCookies, sessionIdFrom } from "./auth.ts";
import { bus, type BusMessage } from "./bus.ts";
import { markTruckSeen } from "./dispatch.ts";
import { db } from "./db/index.ts";
import {
  commandCenters,
  crews,
  days,
  events,
  sessions,
  trucks,
  users,
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
  /** A scanned QR link waiting for sign-in (`lrb_join` cookie), e.g. `crew:<token>`. */
  joinLink?: string | null;
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
    joinLink: parseCookies(req.headers.get("cookie"))[JOIN_COOKIE] ?? null,
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

export const loadCcScope = (ccId: number): { cc: CommandCenter; day: Day; event: Event } => {
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

// #region live streams
/** The CC and day an open stream follows. */
export interface CcScope {
  ccId: number;
  dayId: number;
}

/** Sent on `shared.onCc` when the session's truck or crew moves to another CC. The client refetches everything. */
export type ScopeChanged = { type: "scope.changed"; ccId: number; dayId: number; payload: null };

const RECHECK_MS = 10_000;

/**
 * The CC a session follows right now, read from the database without
 * touching last-seen times. Null when the session is gone (signed out, or a
 * new code or token was issued) or its crew, truck or CC no longer exists.
 */
export const readCcScope = (sessionId: string, ccOverride: number | null): CcScope | null => {
  const s = db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
  if (!s) return null;
  let ccId: number | null = null;
  if (s.role === "crew" && s.crewId !== null) {
    ccId = db.select({ ccId: crews.ccId }).from(crews).where(eq(crews.id, s.crewId)).get()?.ccId ?? null;
  } else if (s.role === "driver" && s.truckId !== null) {
    ccId = db.select({ ccId: trucks.ccId }).from(trucks).where(eq(trucks.id, s.truckId)).get()?.ccId ?? null;
  } else if (s.role === "green") {
    ccId = s.ccId;
  } else if (isAdminSession(s)) {
    ccId = ccOverride;
  }
  if (ccId === null) return null;
  const cc = db.select({ dayId: commandCenters.dayId }).from(commandCenters).where(eq(commandCenters.id, ccId)).get();
  return cc ? { ccId, dayId: cc.dayId } : null;
};

/** True while the session exists and is still an admin session with an admin membership behind it. */
export const readAdmin = (sessionId: string): true | null => {
  const s = db.select({ role: sessions.role, userId: sessions.userId }).from(sessions).where(eq(sessions.id, sessionId)).get();
  return s && isAdminSession(s) ? true : null;
};

export const sameCc = (a: CcScope, b: CcScope): boolean => a.ccId === b.ccId && a.dayId === b.dayId;

export type LiveItem<S> = { kind: "event"; msg: BusMessage; scope: S } | { kind: "moved"; scope: S };

/**
 * Bus events for one session's open stream. Auth runs once when a stream
 * opens, so the stream reads its session again on every scope check from the
 * bus (and on the first event after 10 s without one, for writes that skipped
 * the check). A session that is gone ends the stream with UNAUTHORIZED before
 * any later event reaches it; a session whose CC changed yields `moved` and
 * from then on carries the new scope.
 */
export async function* liveFor<S>(
  signal: AbortSignal | undefined,
  initial: S,
  read: () => S | null,
  same: (a: S, b: S) => boolean,
): AsyncGenerator<LiveItem<S>> {
  let scope = initial;
  let readAt = Date.now();
  for await (const msg of bus.listen(signal)) {
    const now = Date.now();
    if (msg.type === "scope.check" || now - readAt >= RECHECK_MS) {
      readAt = now;
      const next = read();
      if (next === null) throw unauthorized();
      if (!same(scope, next)) {
        scope = next;
        yield { kind: "moved", scope };
      }
    }
    if (msg.type !== "scope.check") yield { kind: "event", msg, scope };
  }
}
// #endregion

// #region procedures
const unauthorized = (): TRPCError => new TRPCError({ code: "UNAUTHORIZED", message: "Sign in" });
const forbidden = (): TRPCError => new TRPCError({ code: "FORBIDDEN", message: "Not allowed" });

export const authedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.session) throw unauthorized();
  return next({ ctx: { ...ctx, session: ctx.session } });
});

/** A session that belongs to a Firebase user (SPEC 18), in a role or not. */
export const userProcedure = authedProcedure.use(({ ctx, next }) => {
  const userId = ctx.session.userId;
  if (userId === null) throw forbidden();
  const user = db.select().from(users).where(eq(users.id, userId)).get();
  if (!user) throw unauthorized();
  return next({ ctx: { ...ctx, user } });
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

/**
 * The CC of a driver or red shirt session, when its user holds green there
 * (SPEC 27: capabilities follow the person). Null otherwise.
 */
const greenThroughMembership = (s: Session): number | null => {
  if (s.userId === null) return null;
  let ccId: number | null = null;
  if (s.role === "driver" && s.truckId !== null) ccId = db.select({ ccId: trucks.ccId }).from(trucks).where(eq(trucks.id, s.truckId)).get()?.ccId ?? null;
  else if (s.role === "crew" && s.crewId !== null) ccId = db.select({ ccId: crews.ccId }).from(crews).where(eq(crews.id, s.crewId)).get()?.ccId ?? null;
  return ccId !== null && holdsGreen(s.userId, ccId) ? ccId : null;
};

/**
 * Green shirts at their CC; admin too, at the CC named by `?cc=`. A driver or
 * red shirt whose user holds green at the truck's or crew's CC (an approved
 * green membership there, or admin) acts as a green shirt at that CC (SPEC 27).
 */
export const greenProcedure = authedProcedure.use(({ ctx, next }) => {
  const role = ctx.session.role;
  let ccId: number | null = null;
  if (role === "green") ccId = ctx.session.ccId;
  else if (isAdminSession(ctx.session)) {
    ccId = ctx.ccOverride;
    if (ccId === null) throw new TRPCError({ code: "BAD_REQUEST", message: "No command center" });
  } else {
    ccId = greenThroughMembership(ctx.session);
    if (ccId === null) throw forbidden();
  }
  if (ccId === null) throw unauthorized();
  const scope = loadCcScope(ccId);
  return next({ ctx: { ...ctx, ...scope } });
});

/** Admin sessions whose user holds an approved admin membership (SPEC 26). */
export const adminProcedure = authedProcedure.use(async ({ ctx, type, next }) => {
  if (!isAdminSession(ctx.session)) throw forbidden();
  const result = await next({ ctx });
  // Admin writes delete sessions (new codes and tokens, deleted crews, trucks
  // and CCs) and move trucks and crews between CCs. The sites that do so also
  // call checkScopes at once; this catches any write that does it some other way.
  if (type === "mutation") bus.checkScopes();
  return result;
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
  } else if (isAdminSession(s)) {
    ccId = ctx.ccOverride;
  }
  if (ccId === null) throw new TRPCError({ code: "BAD_REQUEST", message: "No command center" });
  const scope = loadCcScope(ccId);
  return next({ ctx: { ...ctx, crew, truck, ...scope } });
});
// #endregion
