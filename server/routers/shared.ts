import { TRPCError } from "@trpc/server";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { bus, type BusMessage } from "../bus.ts";
import { db } from "../db/index.ts";
import {
  broadcasts,
  commandCenters,
  companies,
  crews,
  days,
  events,
  lots,
  positions,
  trucks,
  type CommandCenter,
  type Company,
  type Crew,
  type Day,
  type Event,
  type Role,
  type Truck,
} from "../db/schema.ts";
import { crewLabel, markTruckSeen, onCrewMoved, onTruckMoved } from "../dispatch.ts";
import { firebaseEnabled } from "../firebase.ts";
import { subscribe, unsubscribe, vapidPublicKey } from "../push.ts";
import { canViewLot, deletePhoto, lotPhotoList, photoScope } from "../photos.ts";
import { activeEvent, catalogFor, ccCard } from "../queries.ts";
import { parcelFacts } from "../parcels.ts";
import { authedProcedure, ccProcedure, liveFor, publicProcedure, readCcScope, router, sameCc, type ScopeChanged } from "../trpc.ts";

// #region me
export type Me =
  | { role: "anon" }
  /** Signed in through Firebase with no role yet: the access screen. */
  | { role: "none"; displayName: string | null }
  | {
      role: Role;
      displayName: string | null;
      /** True when the session belongs to a signed-in user, who leaves a role without signing out. */
      user: boolean;
      /** Scope line for the top bar, e.g. "Crew 7, Ford, CC East". */
      scope: string;
      /** The same line for a phone's bar: "Crew 7, CC East". The CC outranks the company. */
      scopeShort: string;
      /** The crew row without its join token; the token is the crew's password and nothing on screen needs it. */
      crew: (Omit<Crew, "token"> & { company: Company | null }) | null;
      truck: Truck | null;
      cc: CommandCenter | null;
      day: Day | null;
      event: Event | null;
    };

const ccScope = (ccId: number | null): { cc: CommandCenter | null; day: Day | null; event: Event | null } => {
  if (ccId === null) return { cc: null, day: null, event: null };
  const cc = db.select().from(commandCenters).where(eq(commandCenters.id, ccId)).get() ?? null;
  const day = cc ? (db.select().from(days).where(eq(days.id, cc.dayId)).get() ?? null) : null;
  const event = day ? (db.select().from(events).where(eq(events.id, day.eventId)).get() ?? null) : null;
  return { cc, day, event };
};
// #endregion

// #region position throttle
const POSITION_EMIT_MS = 5000;
const lastEmit = new Map<string, number>();

/** One broadcast per entity per 5 s; every fix is still stored. */
const shouldEmit = (key: string, now: number): boolean => {
  const prev = lastEmit.get(key);
  if (prev !== undefined && now - prev < POSITION_EMIT_MS) return false;
  lastEmit.set(key, now);
  return true;
};
// #endregion

const pushRouter = router({
  key: publicProcedure.query(() => ({ publicKey: vapidPublicKey() })),
  subscribe: authedProcedure
    .input(z.object({ endpoint: z.string().url().max(2000), keys: z.object({ p256dh: z.string().max(500), auth: z.string().max(500) }) }))
    .mutation(({ ctx, input }) => {
      subscribe(ctx.session.id, { endpoint: input.endpoint, p256dh: input.keys.p256dh, auth: input.keys.auth });
      return { ok: true };
    }),
  unsubscribe: authedProcedure.input(z.object({ endpoint: z.string().max(2000) })).mutation(({ ctx, input }) => {
    unsubscribe(ctx.session.id, input.endpoint);
    return { ok: true };
  }),
});

export const sharedRouter = router({
  me: publicProcedure.query(({ ctx }): Me => {
    const s = ctx.session;
    if (!s) return { role: "anon" };
    if (s.role === "none") return s.userId !== null ? { role: "none", displayName: s.displayName } : { role: "anon" };
    const user = s.userId !== null;
    if (s.role === "admin") {
      const override = ctx.ccOverride !== null ? ccScope(ctx.ccOverride) : null;
      return {
        role: "admin",
        displayName: s.displayName,
        user,
        scope: override?.cc ? `Admin, CC ${override.cc.name}` : "Admin",
        scopeShort: override?.cc ? `Admin, CC ${override.cc.name}` : "Admin",
        crew: null,
        truck: null,
        ...(override ?? { cc: null, day: null, event: activeEvent() ?? null }),
      };
    }
    if (s.role === "crew" && s.crewId !== null) {
      const row = db
        .select({ crew: crews, company: companies })
        .from(crews)
        .leftJoin(companies, eq(companies.id, crews.companyId))
        .where(eq(crews.id, s.crewId))
        .get();
      if (!row) return { role: "anon" };
      const scope = ccScope(row.crew.ccId);
      const parts = [crewLabel(row.crew), row.company?.name, scope.cc ? `CC ${scope.cc.name}` : null].filter(Boolean);
      const { token: _token, ...crew } = row.crew;
      const short = [crewLabel(row.crew), scope.cc ? `CC ${scope.cc.name}` : null].filter(Boolean);
      return {
        role: "crew",
        displayName: s.displayName,
        user,
        scope: parts.join(", "),
        scopeShort: short.join(", "),
        crew: { ...crew, company: row.company },
        truck: null,
        ...scope,
      };
    }
    if (s.role === "driver" && s.truckId !== null) {
      const truck = db.select().from(trucks).where(eq(trucks.id, s.truckId)).get();
      if (!truck) return { role: "anon" };
      const scope = ccScope(truck.ccId);
      const parts = [truck.name, scope.cc ? `CC ${scope.cc.name}` : null].filter(Boolean);
      return { role: "driver", displayName: s.displayName ?? truck.driverName, user, scope: parts.join(", "), scopeShort: parts.join(", "), crew: null, truck, ...scope };
    }
    if (s.role === "green") {
      const scope = ccScope(s.ccId);
      if (!scope.cc) return { role: "anon" };
      const parts = [`CC ${scope.cc.name}`, scope.day?.label].filter(Boolean);
      return { role: "green", displayName: s.displayName, user, scope: parts.join(", "), scopeShort: parts.join(", "), crew: null, truck: null, ...scope };
    }
    return { role: "anon" };
  }),

  /** Which sign-in methods this server accepts. */
  authConfig: publicProcedure.query(() => ({ firebase: firebaseEnabled() })),

  position: authedProcedure
    .input(
      z.object({
        lat: z.number().min(-90).max(90),
        lng: z.number().min(-180).max(180),
        accuracy: z.number().min(0).max(100000).nullish(),
        heading: z.number().nullish(),
        speed: z.number().nullish(),
      }),
    )
    .mutation(({ ctx, input }) => {
      const s = ctx.session;
      const now = Date.now();
      const fix = { lat: input.lat, lng: input.lng, accuracy: input.accuracy ?? null, heading: input.heading ?? null, speed: input.speed ?? null, at: now };
      if (s.role === "crew" && s.crewId !== null) {
        const crew = db.select().from(crews).where(eq(crews.id, s.crewId)).get();
        if (!crew) throw new TRPCError({ code: "UNAUTHORIZED" });
        db.insert(positions).values({ kind: "crew", refId: crew.id, ...fix }).run();
        db.update(crews).set({ lastSeenAt: now }).where(eq(crews.id, crew.id)).run();
        if (shouldEmit(`crew:${crew.id}`, now)) {
          bus.emit("crew.position", { ccId: crew.ccId, dayId: crew.dayId }, { crewId: crew.id, lat: input.lat, lng: input.lng, at: now });
        }
        onCrewMoved(crew.id, input);
        return { ok: true };
      }
      if (s.role === "driver" && s.truckId !== null) {
        const truck = db.select().from(trucks).where(eq(trucks.id, s.truckId)).get();
        if (!truck) throw new TRPCError({ code: "UNAUTHORIZED" });
        db.insert(positions).values({ kind: "truck", refId: truck.id, ...fix }).run();
        if (shouldEmit(`truck:${truck.id}`, now)) {
          bus.emit("truck.position", { ccId: truck.ccId, dayId: truck.dayId }, { truckId: truck.id, lat: input.lat, lng: input.lng, at: now });
        }
        onTruckMoved(truck.id, input);
        // After the fix is stored, so a truck back in range is costed from where it is now.
        markTruckSeen(truck, now);
        return { ok: true };
      }
      throw new TRPCError({ code: "FORBIDDEN", message: "Crew and drivers only" });
    }),

  /**
   * Everything at the session's CC. The scope is read again on every scope
   * check, so a revoked session stops at once and a moved truck or crew
   * follows its new CC (the client gets `scope.changed` and refetches).
   */
  onCc: ccProcedure.subscription(async function* ({ ctx, signal }): AsyncGenerator<BusMessage | ScopeChanged> {
    const sessionId = ctx.session.id;
    const override = ctx.ccOverride;
    const start = { ccId: ctx.cc.id, dayId: ctx.day.id };
    for await (const item of liveFor(signal, start, () => readCcScope(sessionId, override), sameCc)) {
      if (item.kind === "moved") {
        yield { type: "scope.changed", ccId: item.scope.ccId, dayId: item.scope.dayId, payload: null };
        continue;
      }
      const { msg, scope } = item;
      if (msg.ccId !== scope.ccId) continue;
      if (msg.dayId !== null && msg.dayId !== scope.dayId) continue;
      yield msg;
    }
  }),

  catalog: ccProcedure.query(({ ctx }) => catalogFor(ctx.event.id)),

  ccCard: ccProcedure.query(({ ctx }) => {
    const card = ccCard(ctx.cc.id);
    if (!card) throw new TRPCError({ code: "NOT_FOUND" });
    return card;
  }),

  /** Every live photo of a lot, newest first, for the lot sheet and the viewer. */
  /** What the city parcel layer says about a parcel, in plain words, for the lot sheet. Public assessor data. */
  parcelInfo: authedProcedure.input(z.object({ parcelId: z.string().min(1).max(40) })).query(({ input }) => parcelFacts(input.parcelId)),

  lotPhotos: authedProcedure.input(z.object({ lotId: z.number().int() })).query(({ ctx, input }) => {
    const scope = photoScope(ctx.session);
    if (!scope) throw new TRPCError({ code: "UNAUTHORIZED", message: "Sign in" });
    const lot = db.select().from(lots).where(eq(lots.id, input.lotId)).get();
    if (!lot || !canViewLot(scope, lot)) throw new TRPCError({ code: "NOT_FOUND", message: "Lot not found" });
    return lotPhotoList(scope, lot);
  }),

  deletePhoto: authedProcedure.input(z.object({ id: z.number().int() })).mutation(({ ctx, input }) => {
    const scope = photoScope(ctx.session);
    if (!scope) throw new TRPCError({ code: "UNAUTHORIZED", message: "Sign in" });
    const r = deletePhoto(scope, input.id);
    if (!r.ok) throw new TRPCError({ code: r.code, message: r.code === "NOT_FOUND" ? "Photo not found" : "Not allowed" });
    return { id: r.photo.id, lotId: r.photo.lotId };
  }),

  latestBroadcast: ccProcedure.query(({ ctx }) =>
    db.select().from(broadcasts).where(eq(broadcasts.ccId, ctx.cc.id)).orderBy(desc(broadcasts.at)).limit(1).get() ?? null,
  ),

  push: pushRouter,
});
