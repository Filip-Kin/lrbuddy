import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { bus } from "./bus.ts";
import { config } from "./config.ts";
import { db } from "./db/index.ts";
import {
  commandCenters,
  companies,
  crews,
  positions,
  requests,
  requestTypes,
  routes,
  stockMoves,
  trucks,
  truckStock,
  type Canceller,
  type CommandCenter,
  type Position,
  type PositionKind,
  type Request,
  type RequestType,
  type Route,
  type RouteLeg,
  type Truck,
  type TruckStock,
} from "./db/schema.ts";
import { detour, haversine, type LatLng } from "./geo.ts";
import { trip, type TripResult } from "./osrm.ts";
import { pushToCrew, pushToTruck } from "./push.ts";

// #region constants
export const SEEN_WINDOW_MS = 15 * 60_000;
export const URGENT_AGE_MS = 10 * 60_000;
export const CREW_FRESH_MS = 20 * 60_000;
export const MOVE_RECOMPUTE_M = 250;
export const LOW_STOCK_RATIO = 0.25;
export const ROUTE_DEBOUNCE_MS = 3000;
export const ACTIVE_STATUSES = ["assigned", "en_route"] as const;
export const OPEN_STATUSES = ["open", "assigned", "en_route"] as const;
// #endregion

// #region lookups
const notFound = (what: string): TRPCError => new TRPCError({ code: "NOT_FOUND", message: `${what} not found` });

export const getRequest = (id: number): Request => {
  const r = db.select().from(requests).where(eq(requests.id, id)).get();
  if (!r) throw notFound("Request");
  return r;
};

export const getTruck = (id: number): Truck => {
  const t = db.select().from(trucks).where(eq(trucks.id, id)).get();
  if (!t) throw notFound("Truck");
  return t;
};

export const getCc = (id: number): CommandCenter => {
  const c = db.select().from(commandCenters).where(eq(commandCenters.id, id)).get();
  if (!c) throw notFound("Command center");
  return c;
};

export const getType = (id: number): RequestType => {
  const t = db.select().from(requestTypes).where(eq(requestTypes.id, id)).get();
  if (!t) throw notFound("Request type");
  return t;
};

export const latestPosition = (kind: PositionKind, refId: number): Position | undefined =>
  db
    .select()
    .from(positions)
    .where(and(eq(positions.kind, kind), eq(positions.refId, refId)))
    .orderBy(desc(positions.at))
    .limit(1)
    .get();

export const isOpen = (r: Pick<Request, "status">): boolean =>
  r.status === "open" || r.status === "assigned" || r.status === "en_route";

export const crewLabel = (c: { number: number }): string => `Crew ${c.number}`;
export const itemText = (typeLabel: string, qty: number): string => `${typeLabel} x${qty}`;
// #endregion

// #region positions
/** Where a truck starts: its last position, else its CC. */
export const truckOrigin = (truck: Truck, cc: CommandCenter): LatLng => {
  const p = latestPosition("truck", truck.id);
  return p ? { lat: p.lat, lng: p.lng } : { lat: cc.lat, lng: cc.lng };
};

/**
 * Where to meet a crew for a request. A position from the last 20 minutes
 * wins; after that the newer of the stale position and the request's own
 * position; after that the CC.
 */
export const crewStopPosition = (
  crewId: number,
  req: Pick<Request, "lat" | "lng" | "createdAt"> | null,
  cc: CommandCenter,
  now: number,
): LatLng => {
  const p = latestPosition("crew", crewId);
  if (p && now - p.at <= CREW_FRESH_MS) return { lat: p.lat, lng: p.lng };
  const reqPos = req && req.lat !== null && req.lng !== null ? { lat: req.lat, lng: req.lng, at: req.createdAt } : null;
  if (p && reqPos) return p.at >= reqPos.at ? { lat: p.lat, lng: p.lng } : { lat: reqPos.lat, lng: reqPos.lng };
  if (p) return { lat: p.lat, lng: p.lng };
  if (reqPos) return { lat: reqPos.lat, lng: reqPos.lng };
  return { lat: cc.lat, lng: cc.lng };
};
// #endregion

// #region stops
export interface Stop {
  /** `crew:<id>` or `req:<id>` for a crewless request. */
  key: string;
  crewId: number | null;
  requests: Request[];
  lat: number;
  lng: number;
  /** Holds a priority 3 request older than 10 minutes. */
  urgent: boolean;
}

export const stopKeyOf = (r: Pick<Request, "id" | "crewId">): string =>
  r.crewId !== null ? `crew:${r.crewId}` : `req:${r.id}`;

/** Assigned and en route requests of a truck, grouped into stops. Unordered. */
export const stopsForTruck = (truckId: number, now: number): Stop[] => {
  const truck = getTruck(truckId);
  const cc = getCc(truck.ccId);
  const rows = db
    .select({ r: requests, priority: requestTypes.priority })
    .from(requests)
    .innerJoin(requestTypes, eq(requestTypes.id, requests.typeId))
    .where(and(eq(requests.truckId, truckId), inArray(requests.status, [...ACTIVE_STATUSES])))
    .orderBy(requests.createdAt)
    .all();
  const byKey = new Map<string, Stop>();
  for (const { r, priority } of rows) {
    const key = stopKeyOf(r);
    let stop = byKey.get(key);
    if (!stop) {
      const pos =
        r.crewId !== null
          ? crewStopPosition(r.crewId, newestWithPosition(rows.map((x) => x.r), r.crewId) ?? r, cc, now)
          : r.lat !== null && r.lng !== null
            ? { lat: r.lat, lng: r.lng }
            : { lat: cc.lat, lng: cc.lng };
      stop = { key, crewId: r.crewId, requests: [], lat: pos.lat, lng: pos.lng, urgent: false };
      byKey.set(key, stop);
    }
    stop.requests.push(r);
    if (priority >= 3 && now - r.createdAt > URGENT_AGE_MS) stop.urgent = true;
  }
  return [...byKey.values()];
};

const newestWithPosition = (rows: readonly Request[], crewId: number): Request | undefined => {
  let best: Request | undefined;
  for (const r of rows) {
    if (r.crewId !== crewId || r.lat === null || r.lng === null) continue;
    if (!best || r.createdAt > best.createdAt) best = r;
  }
  return best;
};

/** A truck's stops in its current route order; stops the route has not seen yet go last. */
export const orderedStops = (truckId: number, now: number): Stop[] => {
  const stops = stopsForTruck(truckId, now);
  const route = db.select().from(routes).where(eq(routes.truckId, truckId)).get();
  if (!route) return stops;
  const rank = new Map<string, number>();
  route.legs.forEach((l, i) => rank.set(l.key, i));
  return [...stops].sort((a, b) => (rank.get(a.key) ?? 1e9) - (rank.get(b.key) ?? 1e9));
};
// #endregion

// #region assignment
/** Trucks at the CC on the day, not offline, seen in the last 15 minutes. */
export const candidateTrucks = (ccId: number, dayId: number, now: number): Truck[] =>
  db
    .select()
    .from(trucks)
    .where(and(eq(trucks.ccId, ccId), eq(trucks.dayId, dayId), isNotNull(trucks.lastSeenAt)))
    .all()
    .filter((t) => t.status !== "offline" && t.lastSeenAt !== null && now - t.lastSeenAt <= SEEN_WINDOW_MS);

/**
 * Cheapest place to add `x` to a path that starts at `origin` and visits
 * `stops` in order. Returns the haversine detour in metres.
 */
export const insertionCost = (origin: LatLng, stops: readonly LatLng[], x: LatLng): number => {
  const path = [origin, ...stops];
  let best = Infinity;
  for (let i = 0; i < path.length; i++) {
    const cost = detour(path[i]!, x, path[i + 1] ?? null);
    if (cost < best) best = cost;
  }
  return best;
};

/** Picks the truck with the smallest insertion detour; ties go to fewer stops. */
export const chooseTruck = (req: Request, now: number): { truck: Truck; cost: number } | null => {
  const cc = getCc(req.ccId);
  const cands = candidateTrucks(req.ccId, req.dayId, now);
  if (cands.length === 0) return null;
  const point: LatLng =
    req.lat !== null && req.lng !== null
      ? { lat: req.lat, lng: req.lng }
      : req.crewId !== null
        ? crewStopPosition(req.crewId, null, cc, now)
        : { lat: cc.lat, lng: cc.lng };
  const key = stopKeyOf(req);
  let best: { truck: Truck; cost: number; stops: number } | null = null;
  for (const t of cands) {
    const stops = orderedStops(t.id, now);
    // Joining a stop the truck already has costs nothing.
    const cost = stops.some((s) => s.key === key) ? 0 : insertionCost(truckOrigin(t, cc), stops, point);
    if (!best || cost < best.cost || (cost === best.cost && stops.length < best.stops)) {
      best = { truck: t, cost, stops: stops.length };
    }
  }
  return best ? { truck: best.truck, cost: best.cost } : null;
};

const emitRequest = (r: Request): void => {
  bus.emit("request.changed", { ccId: r.ccId, dayId: r.dayId }, { request: r });
};

const stopName = (r: Request): string => {
  if (r.crewId === null) return r.label ?? "Pinned stop";
  const row = db
    .select({ number: crews.number, company: companies.name })
    .from(crews)
    .leftJoin(companies, eq(companies.id, crews.companyId))
    .where(eq(crews.id, r.crewId))
    .get();
  if (!row) return "Crew";
  return row.company ? `${crewLabel(row)} ${row.company}` : crewLabel(row);
};

const notifyNewStop = (r: Request, truckId: number): void => {
  const type = getType(r.typeId);
  pushToTruck(truckId, {
    title: "New stop",
    body: `${itemText(type.label, r.qty)}, ${stopName(r)}`,
    url: "/",
    tag: `stop-${stopKeyOf(r)}`,
  });
};

/**
 * Runs SPEC 7 assignment for an open request. Leaves it open when no truck is
 * a candidate.
 */
export const assignOnCreate = (requestId: number, now = Date.now()): Request => {
  const req = getRequest(requestId);
  if (req.status !== "open") return req;
  const pick = chooseTruck(req, now);
  if (!pick) return req;
  const updated = db
    .update(requests)
    .set({ status: "assigned", truckId: pick.truck.id, assignedAt: now })
    .where(eq(requests.id, req.id))
    .returning()
    .get();
  emitRequest(updated);
  notifyNewStop(updated, pick.truck.id);
  scheduleRoute(pick.truck.id);
  return updated;
};

export interface NewRequest {
  crewId: number | null;
  ccId: number;
  dayId: number;
  typeId: number;
  qty: number;
  note?: string | null;
  label?: string | null;
  createdBy: "crew" | "green";
  lat?: number | null;
  lng?: number | null;
}

/** Inserts a request, emits it, then assigns it. */
export const createRequest = (input: NewRequest, now = Date.now()): Request => {
  const type = getType(input.typeId);
  if (!type.active) throw new TRPCError({ code: "BAD_REQUEST", message: "Item not available" });
  if (input.crewId === null && (input.lat == null || input.lng == null)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Stop needs a map position" });
  }
  let lat = input.lat ?? null;
  let lng = input.lng ?? null;
  if (input.crewId !== null && (lat === null || lng === null)) {
    const p = latestPosition("crew", input.crewId);
    if (p) {
      lat = p.lat;
      lng = p.lng;
    }
  }
  const row = db
    .insert(requests)
    .values({
      crewId: input.crewId,
      ccId: input.ccId,
      dayId: input.dayId,
      typeId: input.typeId,
      qty: Math.max(1, Math.round(input.qty)),
      note: input.note?.trim() || null,
      label: input.label?.trim() || null,
      createdBy: input.createdBy,
      status: "open",
      createdAt: now,
      lat,
      lng,
    })
    .returning()
    .get();
  emitRequest(row);
  return assignOnCreate(row.id, now);
};

/** Tries every open request at a CC again, oldest first. */
export const sweepOpen = (ccId: number, dayId: number, now = Date.now()): Request[] => {
  const open = db
    .select()
    .from(requests)
    .where(and(eq(requests.ccId, ccId), eq(requests.dayId, dayId), eq(requests.status, "open")))
    .orderBy(requests.createdAt)
    .all();
  return open.map((r) => assignOnCreate(r.id, now)).filter((r) => r.status === "assigned");
};

/**
 * Records that the truck's driver app is open. A truck coming back from more
 * than 15 minutes unseen picks up whatever sat open at its CC while it was
 * away. Every driver call goes through here, so the first call after a gap
 * runs the sweep, whether it is a queue load or a GPS fix.
 */
export const markTruckSeen = (truck: Truck, now = Date.now()): void => {
  const wasStale = truck.lastSeenAt === null || now - truck.lastSeenAt > SEEN_WINDOW_MS;
  db.update(trucks).set({ lastSeenAt: now }).where(eq(trucks.id, truck.id)).run();
  truck.lastSeenAt = now;
  if (wasStale && truck.status !== "offline") sweepOpen(truck.ccId, truck.dayId, now);
};

/** Green Assign: moves a non-terminal request onto a truck at the same CC and day. */
export const reassign = (requestId: number, truckId: number, now = Date.now()): Request => {
  const req = getRequest(requestId);
  if (!isOpen(req)) throw new TRPCError({ code: "BAD_REQUEST", message: "Request already closed" });
  const truck = getTruck(truckId);
  if (truck.ccId !== req.ccId || truck.dayId !== req.dayId) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Truck not at this command center" });
  }
  if (req.truckId === truckId && req.status !== "open") return req;
  const prev = req.truckId;
  const updated = db
    .update(requests)
    .set({ status: "assigned", truckId, assignedAt: now, enRouteAt: null })
    .where(eq(requests.id, req.id))
    .returning()
    .get();
  emitRequest(updated);
  notifyNewStop(updated, truckId);
  if (prev !== null && prev !== truckId) scheduleRoute(prev);
  scheduleRoute(truckId);
  return updated;
};
// #endregion

// #region transitions
const requestsOfStop = (truckId: number, stopKey: string): Request[] => {
  const [kind, idRaw] = stopKey.split(":");
  const id = Number(idRaw);
  if (!Number.isInteger(id) || (kind !== "crew" && kind !== "req")) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Unknown stop" });
  }
  const base = and(eq(requests.truckId, truckId), inArray(requests.status, [...ACTIVE_STATUSES]));
  return db
    .select()
    .from(requests)
    .where(and(base, kind === "crew" ? eq(requests.crewId, id) : eq(requests.id, id)))
    .all();
};

/** Driver En route: every request of the stop becomes en_route and the crew hears about it. */
export const markEnRoute = (truckId: number, stopKey: string, now = Date.now()): Request[] => {
  const rows = requestsOfStop(truckId, stopKey).filter((r) => r.status === "assigned");
  const truck = getTruck(truckId);
  const out: Request[] = [];
  for (const r of rows) {
    const u = db.update(requests).set({ status: "en_route", enRouteAt: now }).where(eq(requests.id, r.id)).returning().get();
    emitRequest(u);
    out.push(u);
  }
  const first = out[0];
  if (first && first.crewId !== null) {
    const summary = out.map((r) => itemText(getType(r.typeId).label, r.qty)).join(", ");
    pushToCrew(first.crewId, { title: "On the way", body: `${summary}, ${truck.name}`, url: "/requests", tag: `req-${first.id}` });
  }
  if (out.length > 0) scheduleRoute(truckId);
  return out;
};

export interface StockRow extends TruckStock {
  key: string;
  label: string;
  unit: RequestType["unit"];
  sort: number;
  low: boolean;
}

export const isLow = (s: Pick<TruckStock, "qty" | "capacity">): boolean =>
  s.capacity > 0 && s.qty < s.capacity * LOW_STOCK_RATIO;

/** Tracked stock of a truck in catalog order, with low flags. */
export const stockFor = (truckId: number): StockRow[] =>
  db
    .select({ s: truckStock, t: requestTypes })
    .from(truckStock)
    .innerJoin(requestTypes, eq(requestTypes.id, truckStock.typeId))
    .where(and(eq(truckStock.truckId, truckId), eq(requestTypes.tracksStock, true)))
    .orderBy(requestTypes.sort)
    .all()
    .map(({ s, t }) => ({ ...s, key: t.key, label: t.label, unit: t.unit, sort: t.sort, low: isLow(s) }));

export const hasLowStock = (truckId: number): boolean => stockFor(truckId).some((s) => s.low);

export const emitStock = (truckId: number): void => {
  const truck = getTruck(truckId);
  const stock = db.select().from(truckStock).where(eq(truckStock.truckId, truckId)).all();
  bus.emit("stock.changed", { ccId: truck.ccId, dayId: truck.dayId }, { truckId, stock });
};

/**
 * Marks requests delivered. Stock comes off the truck that carried each one,
 * floored at 0, with a stock_moves row per tracked item. Pushes each crew.
 */
export const deliverRequests = (requestIds: readonly number[], now = Date.now()): Request[] => {
  const touchedTrucks = new Set<number>();
  const delivered = db.transaction((tx) => {
    const out: Request[] = [];
    for (const id of requestIds) {
      const r = tx.select().from(requests).where(eq(requests.id, id)).get();
      if (!r || !isOpen(r)) continue;
      const u = tx.update(requests).set({ status: "delivered", deliveredAt: now }).where(eq(requests.id, id)).returning().get();
      out.push(u);
      if (r.truckId === null) continue;
      touchedTrucks.add(r.truckId);
      const type = tx.select().from(requestTypes).where(eq(requestTypes.id, r.typeId)).get();
      if (!type?.tracksStock) continue;
      const s = tx
        .select()
        .from(truckStock)
        .where(and(eq(truckStock.truckId, r.truckId), eq(truckStock.typeId, r.typeId)))
        .get();
      const before = s?.qty ?? 0;
      const after = Math.max(0, before - r.qty);
      if (s) {
        tx.update(truckStock)
          .set({ qty: after })
          .where(and(eq(truckStock.truckId, r.truckId), eq(truckStock.typeId, r.typeId)))
          .run();
      }
      tx.insert(stockMoves)
        .values({ truckId: r.truckId, typeId: r.typeId, delta: after - before, reason: "delivery", requestId: r.id, at: now })
        .run();
    }
    return out;
  });
  for (const r of delivered) emitRequest(r);
  const byCrew = new Map<number, Request[]>();
  for (const r of delivered) {
    if (r.crewId === null) continue;
    const list = byCrew.get(r.crewId) ?? [];
    list.push(r);
    byCrew.set(r.crewId, list);
  }
  for (const [crewId, list] of byCrew) {
    const body = list.map((r) => itemText(getType(r.typeId).label, r.qty)).join(", ");
    pushToCrew(crewId, { title: "Delivered", body, url: "/requests", tag: `req-${list[0]!.id}` });
  }
  for (const t of touchedTrucks) {
    emitStock(t);
    scheduleRoute(t);
  }
  return delivered;
};

/** Driver Delivered: delivers every request of the stop. */
export const deliverStop = (truckId: number, stopKey: string, now = Date.now()): Request[] =>
  deliverRequests(
    requestsOfStop(truckId, stopKey).map((r) => r.id),
    now,
  );

/**
 * Cancels a request under the SPEC 7 rules: crew while open or assigned,
 * green any non-terminal, driver only en route and with a reason.
 */
export const cancelRequest = (requestId: number, by: Canceller, note: string | null = null, now = Date.now()): Request => {
  const req = getRequest(requestId);
  if (!isOpen(req)) throw new TRPCError({ code: "BAD_REQUEST", message: "Request already closed" });
  if (by === "crew" && req.status === "en_route") {
    throw new TRPCError({ code: "FORBIDDEN", message: "Truck already on the way" });
  }
  if (by === "driver") {
    if (req.status !== "en_route") throw new TRPCError({ code: "FORBIDDEN", message: "Only en route stops" });
    if (!note || note.trim() === "") throw new TRPCError({ code: "BAD_REQUEST", message: "Reason required" });
  }
  const u = db
    .update(requests)
    .set({ status: "cancelled", cancelledAt: now, cancelledBy: by, cancelNote: note?.trim() || null })
    .where(eq(requests.id, requestId))
    .returning()
    .get();
  emitRequest(u);
  if (by === "driver" && u.crewId !== null) {
    pushToCrew(u.crewId, {
      title: "Cancelled",
      body: `${itemText(getType(u.typeId).label, u.qty)}, ${note?.trim() ?? ""}`.replace(/, $/, ""),
      url: "/requests",
      tag: `req-${u.id}`,
    });
  }
  if (req.truckId !== null) scheduleRoute(req.truckId);
  return u;
};

const settleStatus = (truckId: number, now: number): Truck => {
  const truck = getTruck(truckId);
  if (truck.status === "returning" || truck.status === "offline") return truck;
  const next = stopsForTruck(truckId, now).length > 0 ? "delivering" : "idle";
  if (next === truck.status) return truck;
  return db.update(trucks).set({ status: next }).where(eq(trucks.id, truckId)).returning().get();
};

/** Restock: pins the CC as the final stop. Turning it off puts the truck back to work. */
export const setReturning = (truckId: number, returning: boolean, now = Date.now()): Truck => {
  const truck = getTruck(truckId);
  if (returning) {
    db.update(trucks).set({ status: "returning" }).where(eq(trucks.id, truckId)).run();
  } else if (truck.status === "returning") {
    db.update(trucks).set({ status: "idle" }).where(eq(trucks.id, truckId)).run();
    settleStatus(truckId, now);
  }
  scheduleRoute(truckId);
  return getTruck(truckId);
};

/** Restocked: every item back to capacity, one restock move per item that changed. */
export const restocked = (truckId: number, now = Date.now()): StockRow[] => {
  getTruck(truckId);
  db.transaction((tx) => {
    const rows = tx.select().from(truckStock).where(eq(truckStock.truckId, truckId)).all();
    for (const s of rows) {
      const delta = s.capacity - s.qty;
      if (delta === 0) continue;
      tx.update(truckStock)
        .set({ qty: s.capacity })
        .where(and(eq(truckStock.truckId, truckId), eq(truckStock.typeId, s.typeId)))
        .run();
      tx.insert(stockMoves).values({ truckId, typeId: s.typeId, delta, reason: "restock", requestId: null, at: now }).run();
    }
  });
  emitStock(truckId);
  setReturning(truckId, false, now);
  return stockFor(truckId);
};

/** Driver plus and minus on the stock page. Clamped to 0 and capacity. */
export const adjustStock = (truckId: number, typeId: number, delta: number, now = Date.now()): StockRow[] => {
  const s = db
    .select()
    .from(truckStock)
    .where(and(eq(truckStock.truckId, truckId), eq(truckStock.typeId, typeId)))
    .get();
  if (!s) throw notFound("Stock item");
  const after = Math.min(Math.max(0, s.qty + Math.round(delta)), Math.max(s.capacity, s.qty));
  const applied = after - s.qty;
  if (applied !== 0) {
    db.update(truckStock).set({ qty: after }).where(and(eq(truckStock.truckId, truckId), eq(truckStock.typeId, typeId))).run();
    db.insert(stockMoves).values({ truckId, typeId, delta: applied, reason: "adjust", requestId: null, at: now }).run();
    emitStock(truckId);
  }
  return stockFor(truckId);
};
// #endregion

// #region routing
const toPoint = (s: LatLng): LatLng => ({ lat: s.lat, lng: s.lng });

/**
 * Computes and saves a truck's route now (SPEC 7). Urgent stops go first as
 * their own trip; the rest follow from the last urgent stop.
 */
export const computeRouteNow = async (truckId: number, now = Date.now()): Promise<Route | null> => {
  const truckRow = db.select().from(trucks).where(eq(trucks.id, truckId)).get();
  if (!truckRow) return null;
  const truck = settleStatus(truckId, now);
  const cc = getCc(truck.ccId);
  const origin = truckOrigin(truck, cc);
  const stops = stopsForTruck(truckId, now);
  const destination = truck.status === "returning" ? { lat: cc.lat, lng: cc.lng } : null;
  const opts = { osrmUrl: config.osrmUrl };

  const urgent = stops.filter((s) => s.urgent);
  const rest = stops.filter((s) => !s.urgent);

  const segments: Array<{ stops: Stop[]; result: TripResult }> = [];
  if (urgent.length > 0 && rest.length > 0) {
    const first = await trip(origin, urgent.map(toPoint), null, opts);
    const lastUrgent = urgent[first.order[first.order.length - 1]!]!;
    const second = await trip(toPoint(lastUrgent), rest.map(toPoint), destination, opts);
    segments.push({ stops: urgent, result: first }, { stops: rest, result: second });
  } else {
    const all = urgent.length > 0 ? urgent : rest;
    segments.push({ stops: all, result: await trip(origin, all.map(toPoint), destination, opts) });
  }

  const legs: RouteLeg[] = [];
  const geometry: Array<[number, number]> = [];
  let etaS = 0;
  let distM = 0;
  for (const seg of segments) {
    seg.result.order.forEach((stopIdx, i) => {
      const s = seg.stops[stopIdx]!;
      const leg = seg.result.legs[i];
      etaS += leg?.durationS ?? 0;
      distM += leg?.distanceM ?? 0;
      legs.push({ key: s.key, crewId: s.crewId, requestIds: s.requests.map((r) => r.id), lat: s.lat, lng: s.lng, etaS, distanceM: distM });
    });
    for (const pt of seg.result.geometry) {
      const last = geometry[geometry.length - 1];
      if (!last || last[0] !== pt[0] || last[1] !== pt[1]) geometry.push(pt);
    }
  }
  const lastSeg = segments[segments.length - 1]!;
  if (destination) {
    const leg = lastSeg.result.legs[lastSeg.result.order.length];
    etaS += leg?.durationS ?? 0;
    distM += leg?.distanceM ?? 0;
    legs.push({ key: "cc", crewId: null, requestIds: [], lat: cc.lat, lng: cc.lng, etaS, distanceM: distM });
  }
  const engine = segments.every((s) => s.result.engine === "osrm") ? "osrm" : "fallback";

  const values = {
    truckId,
    computedAt: now,
    stopOrder: legs.flatMap((l) => l.requestIds),
    geometry,
    legs,
    distanceM: distM,
    durationS: etaS,
    endsAtCc: destination !== null,
    engine,
    originLat: origin.lat,
    originLng: origin.lng,
  } as const;
  // The truck may have been deleted while OSRM was answering.
  if (!db.select({ id: trucks.id }).from(trucks).where(eq(trucks.id, truckId)).get()) return null;
  const route = db
    .insert(routes)
    .values(values)
    .onConflictDoUpdate({ target: routes.truckId, set: values })
    .returning()
    .get();
  bus.emit("route.changed", { ccId: truck.ccId, dayId: truck.dayId }, { truckId, route });
  return route;
};

/** How old a live truck's route may get before it is recomputed from where the truck is now. */
export const ROUTE_REFRESH_MS = 60_000;
/** Shortest ETA shown for a stop not yet reached. */
export const MIN_ETA_MS = 60_000;

/**
 * When the truck reaches a leg's stop. The route's ETA counts from when it was
 * computed; a live truck's route is recomputed every minute, so the count
 * stays close. A stop not yet reached never reads as due: the ETA is at least
 * a minute out. A truck unseen for 15 minutes has no ETA, since nothing says
 * where it is.
 */
export const legEtaAt = (
  route: Pick<Route, "computedAt">,
  leg: Pick<RouteLeg, "etaS">,
  truck: Pick<Truck, "lastSeenAt" | "status">,
  now: number,
): number | null => {
  if (truck.status === "offline" || truck.lastSeenAt === null || now - truck.lastSeenAt > SEEN_WINDOW_MS) return null;
  return Math.max(route.computedAt + leg.etaS * 1000, now + MIN_ETA_MS);
};

/** Recomputes the routes of live trucks with stops once they are a minute old. */
export const refreshLiveRoutes = (now = Date.now()): number => {
  const rows = db
    .select({ truckId: routes.truckId, computedAt: routes.computedAt, legs: routes.legs, lastSeenAt: trucks.lastSeenAt, status: trucks.status })
    .from(routes)
    .innerJoin(trucks, eq(trucks.id, routes.truckId))
    .all();
  let n = 0;
  for (const r of rows) {
    if (r.legs.length === 0 || now - r.computedAt < ROUTE_REFRESH_MS) continue;
    if (r.status === "offline" || r.lastSeenAt === null || now - r.lastSeenAt > SEEN_WINDOW_MS) continue;
    if (timers.has(r.truckId)) continue;
    scheduleRoute(r.truckId);
    n++;
  }
  return n;
};

/** Runs `refreshLiveRoutes` every 20 s. Server only; tests call it directly. */
export const startRouteRefresh = (): (() => void) => {
  const t = setInterval(() => {
    try {
      refreshLiveRoutes();
    } catch (err) {
      console.error("[dispatch] route refresh failed", err instanceof Error ? err.message : String(err));
    }
  }, 20_000);
  return () => clearInterval(t);
};

const timers = new Map<number, ReturnType<typeof setTimeout>>();

/** Debounced route computation, 3 s per truck. */
export const scheduleRoute = (truckId: number): void => {
  const existing = timers.get(truckId);
  if (existing) clearTimeout(existing);
  const t = setTimeout(() => {
    timers.delete(truckId);
    computeRouteNow(truckId).catch((err: unknown) => {
      console.error("[dispatch] route failed", truckId, err instanceof Error ? err.message : String(err));
    });
  }, ROUTE_DEBOUNCE_MS);
  // Never hold a script or a test run open for a pending recompute.
  if (typeof t === "object" && t !== null && "unref" in t) t.unref();
  timers.set(truckId, t);
};

/** Alias kept for the SPEC name. */
export const recomputeRoute = scheduleRoute;

/** Drops every pending recompute. For tests and shutdown. */
export const cancelScheduledRoutes = (): void => {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
};

/** Recomputes when the truck has moved more than 250 m since the last route. */
export const onTruckMoved = (truckId: number, pos: LatLng): void => {
  const route = db.select().from(routes).where(eq(routes.truckId, truckId)).get();
  if (!route) {
    scheduleRoute(truckId);
    return;
  }
  if (haversine({ lat: route.originLat, lng: route.originLng }, pos) > MOVE_RECOMPUTE_M) scheduleRoute(truckId);
};

/** A crew stop moves with the crew; recompute the trucks carrying its requests when it moves far. */
export const onCrewMoved = (crewId: number, pos: LatLng): void => {
  const rows = db
    .select({ truckId: requests.truckId })
    .from(requests)
    .where(and(eq(requests.crewId, crewId), inArray(requests.status, [...ACTIVE_STATUSES])))
    .all();
  const truckIds = new Set(rows.map((r) => r.truckId).filter((t): t is number => t !== null));
  for (const truckId of truckIds) {
    const route = db.select().from(routes).where(eq(routes.truckId, truckId)).get();
    const leg = route?.legs.find((l) => l.key === `crew:${crewId}`);
    if (!leg || haversine(leg, pos) > MOVE_RECOMPUTE_M) scheduleRoute(truckId);
  }
};
// #endregion
