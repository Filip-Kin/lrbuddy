import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The db module opens $DATA_DIR at import, so the env must be set before any
// module that touches it loads. Everything below is imported dynamically.
const dir = mkdtempSync(join(tmpdir(), "lrbuddy-test-"));
process.env.DATA_DIR = dir;
process.env.SESSION_SECRET = "test-secret";
process.env.ADMIN_PASSWORD = "test-admin";
process.env.OSRM_URL = "off";
process.env.VAPID_PUBLIC_KEY = "";
process.env.VAPID_PRIVATE_KEY = "";

const { db } = await import("./db/index.ts");
const s = await import("./db/schema.ts");
const d = await import("./dispatch.ts");
const setup = await import("./setup.ts");
const { bus } = await import("./bus.ts");
const { fallbackTrip } = await import("./osrm.ts");
const { eq, and } = await import("drizzle-orm");

afterAll(() => {
  d.cancelScheduledRoutes();
  rmSync(dir, { recursive: true, force: true });
});

// #region fixture
const MIN = 60_000;
const CC = { lat: 42.3786, lng: -82.9911 };
/** Roughly 1.1 km north per 0.01 degree. */
const north = (km: number) => ({ lat: CC.lat + km / 111.2, lng: CC.lng });

interface World {
  eventId: number;
  dayId: number;
  ccId: number;
  typeId: (key: string) => number;
}

const fresh = (): World => {
  d.cancelScheduledRoutes();
  // Cascades clear everything else.
  db.delete(s.events).run();
  db.delete(s.positions).run();
  const ev = setup.createEvent({ name: "Test", year: 2026, startDate: "2026-09-28", dayCount: 1, active: true });
  const day = db.select().from(s.days).where(eq(s.days.eventId, ev.id)).get()!;
  const cc = setup.createCc({ dayId: day.id, name: "East", ...CC });
  const types = db.select().from(s.requestTypes).where(eq(s.requestTypes.eventId, ev.id)).all();
  return {
    eventId: ev.id,
    dayId: day.id,
    ccId: cc.id,
    typeId: (key) => types.find((t) => t.key === key)!.id,
  };
};

const addTruck = (w: World, name: string, pos: { lat: number; lng: number } | null, seenAgoMs: number | null, now: number) => {
  const t = setup.createTruck({ dayId: w.dayId, ccId: w.ccId, name });
  if (seenAgoMs !== null) db.update(s.trucks).set({ lastSeenAt: now - seenAgoMs }).where(eq(s.trucks.id, t.id)).run();
  if (pos) db.insert(s.positions).values({ kind: "truck", refId: t.id, ...pos, at: now - (seenAgoMs ?? 0) }).run();
  return t;
};

const addCrew = (w: World, pos: { lat: number; lng: number } | null, now: number) => {
  const c = setup.createCrew({ dayId: w.dayId, ccId: w.ccId, companyId: null });
  if (pos) db.insert(s.positions).values({ kind: "crew", refId: c.id, ...pos, at: now - MIN }).run();
  return c;
};

const request = (w: World, crewId: number | null, key: string, qty: number, now: number, pos?: { lat: number; lng: number }) =>
  d.createRequest(
    { crewId, ccId: w.ccId, dayId: w.dayId, typeId: w.typeId(key), qty, createdBy: crewId === null ? "green" : "crew", lat: pos?.lat, lng: pos?.lng },
    now,
  );

const stockOf = (truckId: number, typeId: number) =>
  db.select().from(s.truckStock).where(and(eq(s.truckStock.truckId, truckId), eq(s.truckStock.typeId, typeId))).get()!;
// #endregion

let w: World;
beforeEach(() => {
  w = fresh();
});

describe("assignment on create", () => {
  test("insertion cost picks the nearer truck", () => {
    const now = Date.now();
    const near = addTruck(w, "Near", north(1), MIN, now);
    addTruck(w, "Far", north(-3), MIN, now);
    const crew = addCrew(w, north(1.2), now);
    const r = request(w, crew.id, "water", 2, now);
    expect(r.status).toBe("assigned");
    expect(r.truckId).toBe(near.id);
    expect(r.assignedAt).toBe(now);
  });

  test("a truck not seen for 16 minutes loses to one that has reported", () => {
    const now = Date.now();
    addTruck(w, "Stale", north(1), 16 * MIN, now);
    const seen = addTruck(w, "Seen", north(-3), 2 * MIN, now);
    const crew = addCrew(w, north(1), now);
    const r = request(w, crew.id, "snacks", 1, now);
    expect(r.truckId).toBe(seen.id);
  });

  test("when no truck has reported, the request still goes to a non-offline truck", () => {
    const now = Date.now();
    const stale = addTruck(w, "Stale", north(1), 16 * MIN, now);
    const off = addTruck(w, "Off", north(1), MIN, now);
    db.update(s.trucks).set({ status: "offline" }).where(eq(s.trucks.id, off.id)).run();
    const crew = addCrew(w, north(1), now);
    const r = request(w, crew.id, "water", 1, now);
    expect(r.status).toBe("assigned");
    expect(r.truckId).toBe(stale.id);
  });

  test("a CC with only offline trucks leaves the request open", () => {
    const now = Date.now();
    const off = addTruck(w, "Off", north(1), MIN, now);
    db.update(s.trucks).set({ status: "offline" }).where(eq(s.trucks.id, off.id)).run();
    const crew = addCrew(w, north(1), now);
    const r = request(w, crew.id, "water", 1, now);
    expect(r.status).toBe("open");
    expect(r.truckId).toBeNull();
  });

  test("equal cost goes to the truck with fewer stops", () => {
    const now = Date.now();
    // Both trucks sit at the CC and the busy one's only stop is also at the CC,
    // so adding a crew 2 km north costs exactly 2 km on either truck.
    const busy = addTruck(w, "Busy", CC, MIN, now);
    const idle = addTruck(w, "Idle", CC, MIN, now);
    const other = addCrew(w, CC, now);
    const r0 = d.createRequest({ crewId: other.id, ccId: w.ccId, dayId: w.dayId, typeId: w.typeId("water"), qty: 1, createdBy: "crew" }, now);
    d.reassign(r0.id, busy.id, now);
    const crew = addCrew(w, north(2), now);
    const pick = d.chooseTruck({ ...r0, id: -1, crewId: crew.id, lat: null, lng: null }, now);
    const r = request(w, crew.id, "water", 1, now);
    expect(Math.round(pick!.cost)).toBe(Math.round(d.insertionCost(CC, [], north(2))));
    expect(r.truckId).toBe(idle.id);
  });

  test("a second request from the same crew joins the truck already coming", () => {
    const now = Date.now();
    const a = addTruck(w, "A", north(1), MIN, now);
    const b = addTruck(w, "B", north(3), MIN, now);
    const crew = addCrew(w, north(2.9), now);
    // Force the first one onto A even though B is closer.
    const first = request(w, crew.id, "water", 1, now);
    d.reassign(first.id, a.id, now);
    const second = request(w, crew.id, "snacks", 1, now);
    expect(second.truckId).toBe(a.id);
    expect(b.id).not.toBe(a.id);
  });

  test("insertionCost is the best detour across every gap", () => {
    const o = { lat: 0, lng: 0 };
    const stops = [{ lat: 0, lng: 0.02 }];
    const between = { lat: 0, lng: 0.01 };
    expect(d.insertionCost(o, stops, between)).toBeLessThan(1);
    const after = { lat: 0, lng: 0.03 };
    expect(Math.round(d.insertionCost(o, stops, after))).toBe(Math.round(1112));
  });

  test("assignment emits request.changed", () => {
    const now = Date.now();
    addTruck(w, "A", north(1), MIN, now);
    const crew = addCrew(w, north(1), now);
    const seen: string[] = [];
    const off = bus.subscribe((m) => {
      if (m.type === "request.changed") seen.push(m.payload.request.status);
    });
    request(w, crew.id, "water", 1, now);
    off();
    expect(seen).toEqual(["open", "assigned"]);
  });
});

describe("routes", () => {
  test("urgent stops go first", async () => {
    const now = Date.now();
    const t = addTruck(w, "A", CC, MIN, now);
    const near = addCrew(w, north(0.5), now);
    const far = addCrew(w, north(4), now);
    request(w, near.id, "snacks", 1, now);
    // Water is priority 3; eleven minutes old makes it urgent.
    request(w, far.id, "water", 2, now - 11 * MIN);
    const route = await d.computeRouteNow(t.id, now);
    expect(route!.legs.map((l) => l.key)).toEqual([`crew:${far.id}`, `crew:${near.id}`]);
    expect(route!.engine).toBe("fallback");
  });

  test("a young urgent request does not jump the queue", async () => {
    const now = Date.now();
    const t = addTruck(w, "A", CC, MIN, now);
    const near = addCrew(w, north(0.5), now);
    const far = addCrew(w, north(4), now);
    request(w, near.id, "snacks", 1, now);
    request(w, far.id, "water", 2, now - 5 * MIN);
    const route = await d.computeRouteNow(t.id, now);
    expect(route!.legs.map((l) => l.key)).toEqual([`crew:${near.id}`, `crew:${far.id}`]);
  });

  test("fallback ordering is nearest neighbour", () => {
    const origin = { lat: 0, lng: 0 };
    const stops = [
      { lat: 0, lng: 0.05 },
      { lat: 0, lng: 0.01 },
      { lat: 0, lng: 0.03 },
    ];
    const r = fallbackTrip(origin, stops, null);
    expect(r.order).toEqual([1, 2, 0]);
    expect(r.engine).toBe("fallback");
    expect(r.legs).toHaveLength(3);
    // 25 km/h
    expect(r.durationS).toBeCloseTo(r.distanceM / (25000 / 3600), 5);
  });

  test("fallback is used for the saved route and ETAs are cumulative", async () => {
    const now = Date.now();
    const t = addTruck(w, "A", CC, MIN, now);
    const c1 = addCrew(w, north(1), now);
    const c2 = addCrew(w, north(2), now);
    request(w, c2.id, "water", 1, now);
    request(w, c1.id, "water", 1, now);
    const route = await d.computeRouteNow(t.id, now);
    expect(route!.legs.map((l) => l.key)).toEqual([`crew:${c1.id}`, `crew:${c2.id}`]);
    expect(route!.legs[1]!.etaS).toBeGreaterThan(route!.legs[0]!.etaS);
    expect(route!.durationS).toBeCloseTo(route!.legs[1]!.etaS, 5);
  });

  test("a route computed 10 min ago never gives an ETA at or before now while the stop is open", async () => {
    const now = Date.now();
    const t = addTruck(w, "A", CC, 0, now);
    const c = addCrew(w, north(1), now);
    const r = request(w, c.id, "water", 1, now - 10 * MIN);
    await d.computeRouteNow(t.id, now - 10 * MIN);
    db.update(s.routes).set({ legs: [{ key: `crew:${c.id}`, crewId: c.id, requestIds: [r.id], lat: 0, lng: 0, etaS: 120, distanceM: 600 }] }).where(eq(s.routes.truckId, t.id)).run();
    const { requestViews } = await import("./queries.ts");
    const view = requestViews([d.getRequest(r.id)], now)[0]!;
    expect(view.etaAt).not.toBeNull();
    expect(view.etaAt!).toBeGreaterThan(now);
  });

  test("a truck unseen for 16 minutes has no ETA", async () => {
    const now = Date.now();
    const t = addTruck(w, "A", CC, 0, now);
    const c = addCrew(w, north(1), now);
    const r = request(w, c.id, "water", 1, now);
    await d.computeRouteNow(t.id, now);
    db.update(s.trucks).set({ lastSeenAt: now - 16 * MIN }).where(eq(s.trucks.id, t.id)).run();
    const { requestViews } = await import("./queries.ts");
    expect(requestViews([d.getRequest(r.id)], now)[0]!.etaAt).toBeNull();
  });

  test("a live truck's route is recomputed once it is a minute old", async () => {
    const now = Date.now();
    const live = addTruck(w, "A", CC, 0, now);
    const gone = addTruck(w, "B", CC, 20 * MIN, now);
    const c = addCrew(w, north(1), now);
    const r = request(w, c.id, "water", 1, now);
    d.reassign(r.id, live.id, now);
    const c2 = addCrew(w, north(2), now);
    const r2 = request(w, c2.id, "water", 1, now);
    d.reassign(r2.id, gone.id, now);
    await d.computeRouteNow(live.id, now - 2 * MIN);
    await d.computeRouteNow(gone.id, now - 2 * MIN);
    d.cancelScheduledRoutes();
    expect(d.refreshLiveRoutes(now)).toBe(1);
    d.cancelScheduledRoutes();
  });

  test("several requests from one crew are one stop", async () => {
    const now = Date.now();
    const t = addTruck(w, "A", CC, MIN, now);
    const c = addCrew(w, north(1), now);
    const a = request(w, c.id, "water", 1, now);
    const b = request(w, c.id, "snacks", 1, now);
    const route = await d.computeRouteNow(t.id, now);
    expect(route!.legs).toHaveLength(1);
    expect(route!.legs[0]!.requestIds.sort()).toEqual([a.id, b.id].sort());
  });

  test("a crewless stop sits at its own position", async () => {
    const now = Date.now();
    const t = addTruck(w, "A", CC, MIN, now);
    const at = north(1.5);
    const r = request(w, null, "trash_bags", 2, now, at);
    expect(r.truckId).toBe(t.id);
    const route = await d.computeRouteNow(t.id, now);
    expect(route!.legs[0]!.key).toBe(`req:${r.id}`);
    expect(route!.legs[0]!.lat).toBeCloseTo(at.lat, 6);
  });

  test("returning pins the CC as the final stop", async () => {
    const now = Date.now();
    const t = addTruck(w, "A", north(2), MIN, now);
    const c = addCrew(w, north(1), now);
    request(w, c.id, "water", 1, now);
    d.setReturning(t.id, true, now);
    const route = await d.computeRouteNow(t.id, now);
    expect(route!.endsAtCc).toBe(true);
    expect(route!.legs[route!.legs.length - 1]!.key).toBe("cc");
    expect(d.getTruck(t.id).status).toBe("returning");
  });

  test("a stale crew position loses to a newer request position", () => {
    const now = Date.now();
    const cc = d.getCc(w.ccId);
    const c = setup.createCrew({ dayId: w.dayId, ccId: w.ccId, companyId: null });
    db.insert(s.positions).values({ kind: "crew", refId: c.id, ...north(3), at: now - 40 * MIN }).run();
    const p = d.crewStopPosition(c.id, { ...north(1), createdAt: now - 5 * MIN }, cc, now);
    expect(p.lat).toBeCloseTo(north(1).lat, 6);
    const none = d.crewStopPosition(setup.createCrew({ dayId: w.dayId, ccId: w.ccId, companyId: null }).id, null, cc, now);
    expect(none).toEqual(CC);
  });
});

describe("state machine and stock", () => {
  test("delivering floors stock at 0 and writes a stock move", () => {
    const now = Date.now();
    const t = addTruck(w, "A", CC, MIN, now);
    const water = w.typeId("water");
    db.update(s.truckStock).set({ qty: 1 }).where(and(eq(s.truckStock.truckId, t.id), eq(s.truckStock.typeId, water))).run();
    const c = addCrew(w, north(1), now);
    const r = request(w, c.id, "water", 3, now);
    const stockEvents: number[] = [];
    const off = bus.subscribe((m) => {
      if (m.type === "stock.changed") stockEvents.push(m.payload.truckId);
    });
    const done = d.deliverStop(t.id, `crew:${c.id}`, now);
    off();
    expect(done.map((x) => x.status)).toEqual(["delivered"]);
    expect(stockOf(t.id, water).qty).toBe(0);
    const moves = db.select().from(s.stockMoves).where(eq(s.stockMoves.requestId, r.id)).all();
    expect(moves).toHaveLength(1);
    expect(moves[0]!.delta).toBe(-1);
    expect(moves[0]!.reason).toBe("delivery");
    expect(stockEvents).toEqual([t.id]);
  });

  test("delivering a stop delivers every request of the crew and decrements each", () => {
    const now = Date.now();
    const t = addTruck(w, "A", CC, MIN, now);
    const c = addCrew(w, north(1), now);
    request(w, c.id, "water", 2, now);
    request(w, c.id, "snacks", 3, now);
    const beforeWater = stockOf(t.id, w.typeId("water")).qty;
    const beforeSnacks = stockOf(t.id, w.typeId("snacks")).qty;
    const done = d.deliverStop(t.id, `crew:${c.id}`, now);
    expect(done).toHaveLength(2);
    expect(stockOf(t.id, w.typeId("water")).qty).toBe(beforeWater - 2);
    expect(stockOf(t.id, w.typeId("snacks")).qty).toBe(beforeSnacks - 3);
  });

  test("untracked types leave stock alone", () => {
    const now = Date.now();
    const t = addTruck(w, "A", CC, MIN, now);
    const c = addCrew(w, north(1), now);
    const r = request(w, c.id, "other", 1, now);
    d.deliverRequests([r.id], now);
    expect(db.select().from(s.stockMoves).where(eq(s.stockMoves.truckId, t.id)).all()).toHaveLength(0);
  });

  test("en route then delivered", () => {
    const now = Date.now();
    const t = addTruck(w, "A", CC, MIN, now);
    const c = addCrew(w, north(1), now);
    const r = request(w, c.id, "water", 1, now);
    const moved = d.markEnRoute(t.id, `crew:${c.id}`, now + 1000);
    expect(moved[0]!.status).toBe("en_route");
    expect(moved[0]!.enRouteAt).toBe(now + 1000);
    d.deliverStop(t.id, `crew:${c.id}`, now + 2000);
    expect(d.getRequest(r.id).status).toBe("delivered");
    expect(d.getRequest(r.id).deliveredAt).toBe(now + 2000);
  });

  test("crew cancels open or assigned, never en route", () => {
    const now = Date.now();
    const t = addTruck(w, "A", CC, MIN, now);
    const c = addCrew(w, north(1), now);
    const a = request(w, c.id, "water", 1, now);
    expect(d.cancelRequest(a.id, "crew", null, now).status).toBe("cancelled");
    const b = request(w, c.id, "water", 1, now);
    d.markEnRoute(t.id, `crew:${c.id}`, now);
    expect(() => d.cancelRequest(b.id, "crew", null, now)).toThrow();
    expect(d.cancelRequest(b.id, "green", null, now).cancelledBy).toBe("green");
    expect(() => d.cancelRequest(b.id, "green", null, now)).toThrow();
  });

  test("driver cancels only en route and only with a reason", () => {
    const now = Date.now();
    const t = addTruck(w, "A", CC, MIN, now);
    const c = addCrew(w, north(1), now);
    const r = request(w, c.id, "water", 1, now);
    expect(() => d.cancelRequest(r.id, "driver", "Road closed", now)).toThrow();
    d.markEnRoute(t.id, `crew:${c.id}`, now);
    expect(() => d.cancelRequest(r.id, "driver", "  ", now)).toThrow();
    const done = d.cancelRequest(r.id, "driver", "Road closed", now);
    expect(done.status).toBe("cancelled");
    expect(done.cancelNote).toBe("Road closed");
  });

  test("green reassign moves a request between trucks", () => {
    const now = Date.now();
    const a = addTruck(w, "A", north(1), MIN, now);
    const b = addTruck(w, "B", north(-1), MIN, now);
    const c = addCrew(w, north(1), now);
    const r = request(w, c.id, "water", 1, now);
    expect(r.truckId).toBe(a.id);
    d.markEnRoute(a.id, `crew:${c.id}`, now);
    const moved = d.reassign(r.id, b.id, now + 5);
    expect(moved.truckId).toBe(b.id);
    expect(moved.status).toBe("assigned");
    expect(moved.enRouteAt).toBeNull();
  });

  test("open requests are swept onto a truck that comes back from offline", () => {
    const now = Date.now();
    const t = addTruck(w, "A", CC, 30 * MIN, now);
    db.update(s.trucks).set({ status: "offline" }).where(eq(s.trucks.id, t.id)).run();
    const c = addCrew(w, north(1), now);
    const r = request(w, c.id, "water", 1, now);
    expect(r.status).toBe("open");
    db.update(s.trucks).set({ status: "idle", lastSeenAt: now }).where(eq(s.trucks.id, t.id)).run();
    const swept = d.sweepOpen(w.ccId, w.dayId, now);
    expect(swept.map((x) => x.truckId)).toEqual([t.id]);
  });

  test("low stock flags under 25 percent and restock refills to capacity", () => {
    const now = Date.now();
    const t = addTruck(w, "A", CC, MIN, now);
    const water = w.typeId("water");
    const cap = stockOf(t.id, water).capacity;
    expect(d.hasLowStock(t.id)).toBe(false);
    d.adjustStock(t.id, water, -cap, now);
    expect(stockOf(t.id, water).qty).toBe(0);
    expect(d.hasLowStock(t.id)).toBe(true);
    d.setReturning(t.id, true, now);
    const after = d.restocked(t.id, now);
    expect(after.find((x) => x.typeId === water)!.qty).toBe(cap);
    expect(d.hasLowStock(t.id)).toBe(false);
    expect(d.getTruck(t.id).status).not.toBe("returning");
    const restock = db.select().from(s.stockMoves).where(and(eq(s.stockMoves.truckId, t.id), eq(s.stockMoves.reason, "restock"))).all();
    expect(restock.map((m) => m.delta)).toEqual([cap]);
  });

  test("adjust clamps to zero and capacity", () => {
    const now = Date.now();
    const t = addTruck(w, "A", CC, MIN, now);
    const snacks = w.typeId("snacks");
    const cap = stockOf(t.id, snacks).capacity;
    d.adjustStock(t.id, snacks, 50, now);
    expect(stockOf(t.id, snacks).qty).toBe(cap);
    d.adjustStock(t.id, snacks, -100, now);
    expect(stockOf(t.id, snacks).qty).toBe(0);
  });
});
