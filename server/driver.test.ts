import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The db module opens $DATA_DIR at import, so the env is set first and every
// module that touches it is imported dynamically.
const dir = mkdtempSync(join(tmpdir(), "lrbuddy-driver-test-"));
process.env.DATA_DIR = dir;
process.env.SESSION_SECRET ??= "test-secret";
process.env.ADMIN_PASSWORD ??= "test-admin";
process.env.OSRM_URL = "off";
process.env.VAPID_PUBLIC_KEY = "";
process.env.VAPID_PRIVATE_KEY = "";

const { db } = await import("./db/index.ts");
const s = await import("./db/schema.ts");
const d = await import("./dispatch.ts");
const setup = await import("./setup.ts");
const { createSession } = await import("./auth.ts");
const { driverRouter } = await import("./routers/driver.ts");
const { eq, and } = await import("drizzle-orm");
const { bus } = await import("./bus.ts");

afterAll(() => {
  d.cancelScheduledRoutes();
  rmSync(dir, { recursive: true, force: true });
});

// #region fixture
const MIN = 60_000;
const CC = { lat: 42.3786, lng: -82.9911 };
const north = (km: number) => ({ lat: CC.lat + km / 111.2, lng: CC.lng });

interface World {
  eventId: number;
  dayId: number;
  ccId: number;
  typeId: (key: string) => number;
}

const fresh = (): World => {
  d.cancelScheduledRoutes();
  db.delete(s.events).run();
  db.delete(s.positions).run();
  const ev = setup.createEvent({ name: "Driver test", year: 2026, startDate: "2026-09-28", dayCount: 1, active: true });
  const day = db.select().from(s.days).where(eq(s.days.eventId, ev.id)).get()!;
  const cc = setup.createCc({ dayId: day.id, name: "East", ...CC, address: "Anchor Detroit" });
  const types = db.select().from(s.requestTypes).where(eq(s.requestTypes.eventId, ev.id)).all();
  return { eventId: ev.id, dayId: day.id, ccId: cc.id, typeId: (key) => types.find((t) => t.key === key)!.id };
};

const addTruck = (w: World, name: string, pos: { lat: number; lng: number }, now: number) => {
  const t = setup.createTruck({ dayId: w.dayId, ccId: w.ccId, name });
  db.update(s.trucks).set({ lastSeenAt: now - MIN }).where(eq(s.trucks.id, t.id)).run();
  db.insert(s.positions).values({ kind: "truck", refId: t.id, ...pos, at: now - MIN }).run();
  return t;
};

const addCrew = (w: World, pos: { lat: number; lng: number }, now: number) => {
  const c = setup.createCrew({ dayId: w.dayId, ccId: w.ccId, companyId: null });
  db.insert(s.positions).values({ kind: "crew", refId: c.id, ...pos, at: now - MIN }).run();
  return c;
};

const request = (w: World, crewId: number | null, key: string, qty: number, now: number, extra: { lat?: number; lng?: number; label?: string } = {}) =>
  d.createRequest(
    { crewId, ccId: w.ccId, dayId: w.dayId, typeId: w.typeId(key), qty, createdBy: crewId === null ? "green" : "crew", ...extra },
    now,
  );

/** A tRPC caller signed in as the truck's driver. */
const driverOf = (truckId: number, ccId: number) => {
  const session = createSession({ role: "driver", truckId, ccId, displayName: "Dana" });
  return driverRouter.createCaller({ session, ip: "test", ccOverride: null });
};

const stockOf = (truckId: number, typeId: number) =>
  db.select().from(s.truckStock).where(and(eq(s.truckStock.truckId, truckId), eq(s.truckStock.typeId, typeId))).get()!;
// #endregion

let w: World;
beforeEach(() => {
  w = fresh();
});

describe("driver queue", () => {
  test("two requests from one crew are one stop; crewless stops use the label", async () => {
    const now = Date.now();
    const t = addTruck(w, "Truck 1", CC, now);
    const crew = addCrew(w, north(1), now);
    request(w, crew.id, "water", 2, now);
    request(w, crew.id, "snacks", 1, now);
    request(w, null, "water", 4, now, { ...north(0.5), label: "Corner of Harding and Warren" });
    const q = await driverOf(t.id, w.ccId).queue();
    expect(q.stops).toHaveLength(2);
    const crewStop = q.stops.find((x) => x.crewId === crew.id)!;
    expect(crewStop.name).toBe(`Crew ${crew.number}`);
    expect(crewStop.items.map((i) => `${i.typeLabel} x${i.qty}`).sort()).toEqual(["Snacks x1", "Water x2"]);
    const pin = q.stops.find((x) => x.crewId === null)!;
    expect(pin.name).toBe("Corner of Harding and Warren");
    expect(pin.navigateUrl).toContain("google.com/maps/dir/");
  });

  test("a crewless stop with no label takes the nearest lot address", async () => {
    const now = Date.now();
    const t = addTruck(w, "Truck 1", CC, now);
    const at = north(0.5);
    db.insert(s.lots).values({ eventId: w.eventId, address: "5178 HARDING", lat: at.lat + 0.0002, lng: at.lng, source: "manual" }).run();
    db.insert(s.lots).values({ eventId: w.eventId, address: "9999 Far Away", lat: at.lat + 0.01, lng: at.lng, source: "manual" }).run();
    request(w, null, "water", 1, now, at);
    const q = await driverOf(t.id, w.ccId).queue();
    expect(q.stops[0]!.name).toBe("5178 Harding");
    expect(q.stops[0]!.nearAddress).toBeNull();
  });

  test("the queue follows the computed route and a new nearer stop moves ahead", async () => {
    const now = Date.now();
    const t = addTruck(w, "Truck 1", CC, now);
    const far = addCrew(w, north(3), now);
    request(w, far.id, "water", 1, now);
    await d.computeRouteNow(t.id, now);
    const near = addCrew(w, north(1), now);
    request(w, near.id, "snacks", 1, now);
    const caller = driverOf(t.id, w.ccId);
    // Before the recompute the new stop waits at the end.
    expect((await caller.queue()).stops.map((x) => x.crewId)).toEqual([far.id, near.id]);
    await d.computeRouteNow(t.id, now);
    const q = await caller.queue();
    expect(q.stops.map((x) => x.crewId)).toEqual([near.id, far.id]);
    expect(q.stops[0]!.etaAt).not.toBeNull();
  });
});

describe("driver actions", () => {
  test("En route then Delivered closes the stop and takes stock off the truck", async () => {
    const now = Date.now();
    const t = addTruck(w, "Truck 1", CC, now);
    const crew = addCrew(w, north(1), now);
    const r = request(w, crew.id, "water", 2, now);
    const before = stockOf(t.id, w.typeId("water")).qty;
    const caller = driverOf(t.id, w.ccId);
    const key = `crew:${crew.id}`;
    const q1 = await caller.enRoute({ stopKey: key });
    expect(q1.stops[0]!.status).toBe("en_route");
    const q2 = await caller.deliver({ stopKey: key });
    expect(q2.stops).toHaveLength(0);
    expect(d.getRequest(r.id).status).toBe("delivered");
    expect(stockOf(t.id, w.typeId("water")).qty).toBe(before - 2);
    await expect(caller.deliver({ stopKey: key })).rejects.toThrow("Stop already closed");
  });

  test("cancel needs En route first and records the reason", async () => {
    const now = Date.now();
    const t = addTruck(w, "Truck 1", CC, now);
    const crew = addCrew(w, north(1), now);
    const r = request(w, crew.id, "snacks", 1, now);
    const caller = driverOf(t.id, w.ccId);
    await expect(caller.cancel({ requestIds: [r.id], note: "Road blocked" })).rejects.toThrow("Mark En route first");
    await caller.enRoute({ stopKey: `crew:${crew.id}` });
    await caller.cancel({ requestIds: [r.id], note: "Road blocked" });
    const after = d.getRequest(r.id);
    expect(after.status).toBe("cancelled");
    expect(after.cancelledBy).toBe("driver");
    expect(after.cancelNote).toBe("Road blocked");
  });

  test("a driver cannot cancel another truck's request", async () => {
    const now = Date.now();
    const mine = addTruck(w, "Mine", CC, now);
    const other = addTruck(w, "Other", north(2), now);
    const crew = addCrew(w, north(2), now);
    const r = request(w, crew.id, "water", 1, now);
    expect(r.truckId).toBe(other.id);
    await driverOf(other.id, w.ccId).enRoute({ stopKey: `crew:${crew.id}` });
    await expect(driverOf(mine.id, w.ccId).cancel({ requestIds: [r.id], note: "No" })).rejects.toThrow("Not on this truck");
  });

  test("Restock pins the CC last; Restocked fills every item and ends the return", async () => {
    const now = Date.now();
    const t = addTruck(w, "Truck 1", CC, now);
    const water = w.typeId("water");
    const cap = stockOf(t.id, water).capacity;
    const caller = driverOf(t.id, w.ccId);
    await caller.adjustStock({ typeId: water, delta: -(cap - 1) });
    const low = await caller.queue();
    expect(low.lowStock).toBe(true);
    expect(low.low.map((l) => l.typeId)).toContain(water);

    const crew = addCrew(w, north(1), now);
    request(w, crew.id, "snacks", 1, now);
    const ret = await caller.setReturning({ returning: true });
    expect(ret.returning).toBe(true);
    const route = await d.computeRouteNow(t.id, now);
    expect(route!.legs.at(-1)!.key).toBe("cc");
    expect((await caller.queue()).ccEtaAt).not.toBeNull();

    const done = await caller.restocked();
    expect(done.returning).toBe(false);
    expect(done.lowStock).toBe(false);
    expect(stockOf(t.id, water).qty).toBe(cap);
  });

  test("stock plus and minus stay between 0 and capacity", async () => {
    const now = Date.now();
    const t = addTruck(w, "Truck 1", CC, now);
    const snacks = w.typeId("snacks");
    const caller = driverOf(t.id, w.ccId);
    const cap = stockOf(t.id, snacks).capacity;
    await caller.adjustStock({ typeId: snacks, delta: 5 });
    expect(stockOf(t.id, snacks).qty).toBe(cap);
    await caller.adjustStock({ typeId: snacks, delta: -100 });
    expect(stockOf(t.id, snacks).qty).toBe(0);
  });

  test("setName renames the truck's driver", async () => {
    const now = Date.now();
    const t = addTruck(w, "Truck 1", CC, now);
    await driverOf(t.id, w.ccId).setName({ name: "Pat" });
    expect(db.select().from(s.trucks).where(eq(s.trucks.id, t.id)).get()!.driverName).toBe("Pat");
  });
});

describe("driver lots", () => {
  const addLot = (eventId: number, ccId: number | null, address: string) =>
    db.insert(s.lots).values({ eventId, ccId, address, lat: CC.lat + 0.001, lng: CC.lng, source: "manual" }).returning().get();

  const listen = () => {
    const got: number[] = [];
    const off = bus.subscribe((m) => {
      if (m.type === "lot.changed") got.push(m.payload.lot.id);
    });
    return { got, off };
  };

  test("a lot at the truck's CC: shown on the map, Done saved with no crew, lot.changed emitted", async () => {
    const now = Date.now();
    const t = addTruck(w, "Truck 1", CC, now);
    const other = setup.createCc({ dayId: w.dayId, name: "West", lat: CC.lat, lng: CC.lng + 0.02, address: "West" });
    const here = addLot(w.eventId, w.ccId, "100 Here St");
    const there = addLot(w.eventId, other.id, "200 There St");
    const caller = driverOf(t.id, w.ccId);

    const map = await caller.lots();
    expect(map.lots.map((l) => l.id)).toEqual([here.id]);
    expect(map.lots.map((l) => l.id)).not.toContain(there.id);

    const l = listen();
    const saved = await caller.setLotStatus({ lotId: here.id, status: "done" });
    l.off();
    expect(saved.status).toBe("done");
    expect(saved.statusByCrewId).toBeNull();
    expect(l.got).toContain(here.id);
    expect((await caller.lots()).lots[0]!.status).toBe("done");

    await caller.setLotStatus({ lotId: here.id, status: "open" });
    expect(db.select().from(s.lots).where(eq(s.lots.id, here.id)).get()!.status).toBe("open");
  });

  test("lots at another CC, at no CC, or in another event are refused", async () => {
    const now = Date.now();
    const t = addTruck(w, "Truck 1", CC, now);
    const other = setup.createCc({ dayId: w.dayId, name: "West", lat: CC.lat, lng: CC.lng + 0.02, address: "West" });
    const caller = driverOf(t.id, w.ccId);
    const there = addLot(w.eventId, other.id, "200 There St");
    const loose = addLot(w.eventId, null, "300 Loose St");
    const ev2 = setup.createEvent({ name: "Other", year: 2026, startDate: "2026-10-05", dayCount: 1, active: false });
    const foreign = addLot(ev2.id, null, "400 Other Event St");

    await expect(caller.setLotStatus({ lotId: there.id, status: "done" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller.setLotStatus({ lotId: loose.id, status: "done" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller.setLotStatus({ lotId: foreign.id, status: "done" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    for (const id of [there.id, loose.id, foreign.id]) expect(db.select().from(s.lots).where(eq(s.lots.id, id)).get()!.status).toBe("open");
  });

  test("a lot placed at the same site on another day counts as the truck's CC", async () => {
    const now = Date.now();
    const ev = setup.createEvent({ name: "Two days", year: 2026, startDate: "2026-10-01", dayCount: 2, active: true });
    const [d1, d2] = db.select().from(s.days).where(eq(s.days.eventId, ev.id)).orderBy(s.days.date).all();
    const cc1 = setup.createCc({ dayId: d1!.id, name: "North", ...CC, address: "North" });
    const cc2 = setup.createCc({ dayId: d2!.id, name: "north", ...CC, address: "North" });
    const t = setup.createTruck({ dayId: d2!.id, ccId: cc2.id, name: "Truck N" });
    db.update(s.trucks).set({ lastSeenAt: now }).where(eq(s.trucks.id, t.id)).run();
    const lot = addLot(ev.id, cc1.id, "500 Site St");
    const saved = await driverOf(t.id, cc2.id).setLotStatus({ lotId: lot.id, status: "in_progress" });
    expect(saved.status).toBe("in_progress");
  });

  test("crews at the CC come with their lead and position", async () => {
    const now = Date.now();
    const t = addTruck(w, "Truck 1", CC, now);
    const c = addCrew(w, north(0.2), now);
    db.update(s.crews).set({ leadName: "Lee", leadPhone: "3135550100" }).where(eq(s.crews.id, c.id)).run();
    const list = await driverOf(t.id, w.ccId).crews();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: c.id, name: `Crew ${c.number}`, leadName: "Lee", leadPhone: "3135550100" });
    expect(list[0]!.position).not.toBeNull();
  });
});
