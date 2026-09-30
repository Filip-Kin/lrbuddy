import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Same setup as dispatch.test.ts: env first, then everything that opens the db.
const dir = mkdtempSync(join(tmpdir(), "lrbuddy-crew-test-"));
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
const { createSession } = await import("./auth.ts");
const { crewRouter, DUPLICATE_WINDOW_MS } = await import("./routers/crew.ts");
const { eq } = await import("drizzle-orm");

afterAll(() => {
  d.cancelScheduledRoutes();
  rmSync(dir, { recursive: true, force: true });
});

// #region fixture
const MIN = 60_000;
const EAST = { lat: 42.3786, lng: -82.9911 };
const WEST = { lat: 42.3701, lng: -83.0209 };
/** Roughly 111 m north per 0.001 degree. */
const north = (m: number, from = EAST) => ({ lat: from.lat + m / 111_200, lng: from.lng });

const world = () => {
  d.cancelScheduledRoutes();
  db.delete(s.events).run();
  db.delete(s.positions).run();
  const ev = setup.createEvent({ name: "Test", year: 2026, startDate: "2026-09-28", dayCount: 1, active: true });
  const day = db.select().from(s.days).where(eq(s.days.eventId, ev.id)).get()!;
  const east = setup.createCc({ dayId: day.id, name: "East", ...EAST });
  const west = setup.createCc({ dayId: day.id, name: "West", ...WEST });
  const types = db.select().from(s.requestTypes).where(eq(s.requestTypes.eventId, ev.id)).all();
  const now = Date.now();
  const truck = setup.createTruck({ dayId: day.id, ccId: east.id, name: "Truck 1" });
  db.update(s.trucks).set({ lastSeenAt: now }).where(eq(s.trucks.id, truck.id)).run();
  db.insert(s.positions).values({ kind: "truck", refId: truck.id, ...EAST, at: now }).run();
  const crew = setup.createCrew({ dayId: day.id, ccId: east.id, companyId: null });
  const other = setup.createCrew({ dayId: day.id, ccId: east.id, companyId: null });
  db.insert(s.positions).values({ kind: "crew", refId: crew.id, ...north(200), at: now - MIN }).run();
  return {
    eventId: ev.id,
    dayId: day.id,
    east,
    west,
    truck,
    crew,
    other,
    typeId: (key: string) => types.find((t) => t.key === key)!.id,
  };
};

type World = ReturnType<typeof world>;

const callerFor = (crewId: number, ccId: number) => {
  const session = createSession({ role: "crew", crewId, ccId, displayName: "Sam" });
  return crewRouter.createCaller({ session, ip: "test", ccOverride: null });
};

const addLot = (w: World, at: { lat: number; lng: number }, extra: Partial<typeof s.lots.$inferInsert> = {}) =>
  db
    .insert(s.lots)
    .values({ eventId: w.eventId, lat: at.lat, lng: at.lng, source: "manual", address: `${Math.round(at.lat * 1e5)} Test St`, ...extra })
    .returning()
    .get();

const codeOf = async (p: Promise<unknown>): Promise<string | null> => {
  try {
    await p;
    return null;
  } catch (e) {
    return (e as { code?: string }).code ?? "unknown";
  }
};
// #endregion

let w: World;
beforeEach(() => {
  w = world();
});

describe("crew requests", () => {
  test("a request is assigned to the fresh truck and shows in myRequests with truck name", async () => {
    const api = callerFor(w.crew.id, w.east.id);
    const r = await api.createRequest({ typeId: w.typeId("water"), qty: 2, note: " by the fence " });
    expect(r.status).toBe("assigned");
    expect(r.truckName).toBe("Truck 1");
    expect(r.note).toBe("by the fence");
    const mine = await api.myRequests();
    expect(mine.map((m) => m.id)).toEqual([r.id]);
    expect(mine[0]!.crewName).toBe(`Crew ${w.crew.number}`);
  });

  test("the same request twice inside the window is one request", async () => {
    const api = callerFor(w.crew.id, w.east.id);
    const a = await api.createRequest({ typeId: w.typeId("snacks"), qty: 1 });
    const b = await api.createRequest({ typeId: w.typeId("snacks"), qty: 1 });
    expect(b.id).toBe(a.id);
    const c = await api.createRequest({ typeId: w.typeId("snacks"), qty: 2 });
    expect(c.id).not.toBe(a.id);
    db.update(s.requests).set({ createdAt: Date.now() - DUPLICATE_WINDOW_MS - 1000 }).where(eq(s.requests.id, a.id)).run();
    const e = await api.createRequest({ typeId: w.typeId("snacks"), qty: 1 });
    expect(e.id).not.toBe(a.id);
  });

  test("Other needs an item name; an inactive type is refused", async () => {
    const api = callerFor(w.crew.id, w.east.id);
    expect(await codeOf(api.createRequest({ typeId: w.typeId("other"), qty: 1, note: "   " }))).toBe("BAD_REQUEST");
    const ok = await api.createRequest({ typeId: w.typeId("other"), qty: 1, note: "Rake" });
    expect(ok.note).toBe("Rake");
    db.update(s.requestTypes).set({ active: false }).where(eq(s.requestTypes.id, w.typeId("loppers"))).run();
    expect(await codeOf(api.createRequest({ typeId: w.typeId("loppers"), qty: 1 }))).toBe("BAD_REQUEST");
  });

  test("crew cancels while assigned, not once en route, never another crew's", async () => {
    const api = callerFor(w.crew.id, w.east.id);
    const a = await api.createRequest({ typeId: w.typeId("water"), qty: 1 });
    const cancelled = await api.cancel({ id: a.id });
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.cancelledBy).toBe("crew");

    const b = await api.createRequest({ typeId: w.typeId("snacks"), qty: 1 });
    d.markEnRoute(w.truck.id, `crew:${w.crew.id}`);
    expect(await codeOf(api.cancel({ id: b.id }))).toBe("FORBIDDEN");

    const theirs = await callerFor(w.other.id, w.east.id).createRequest({ typeId: w.typeId("water"), qty: 1 });
    expect(await codeOf(api.cancel({ id: theirs.id }))).toBe("FORBIDDEN");
    expect((await api.myRequests()).some((r) => r.id === theirs.id)).toBe(false);
  });
});

describe("crew lots", () => {
  test("assigned lots only, nearest first, when the crew has any", async () => {
    const far = addLot(w, north(900), { crewId: w.crew.id, ccId: w.east.id });
    const near = addLot(w, north(250), { crewId: w.crew.id, ccId: w.east.id });
    addLot(w, north(210), { ccId: w.east.id });
    const lots = await callerFor(w.crew.id, w.east.id).lots();
    expect(lots.map((l) => l.id)).toEqual([near.id, far.id]);
    expect(lots.every((l) => l.mine)).toBe(true);
  });

  test("with none assigned: lots within 400 m, never another crew's", async () => {
    const free = addLot(w, north(300), { ccId: w.east.id });
    const noCc = addLot(w, north(150));
    addLot(w, north(250), { ccId: w.east.id, crewId: w.other.id });
    addLot(w, north(800), { ccId: w.east.id });
    const lots = await callerFor(w.crew.id, w.east.id).lots();
    expect(lots.map((l) => l.id)).toEqual([noCc.id, free.id]);
    expect(lots[0]!.distanceM).toBeLessThan(lots[1]!.distanceM);
    expect(lots.every((l) => !l.mine)).toBe(true);
  });

  test("status changes: own lot yes, another CC's lot no, same status is a no-op", async () => {
    const api = callerFor(w.crew.id, w.east.id);
    const mine = addLot(w, north(250), { crewId: w.crew.id, ccId: w.east.id });
    const done = await api.setLotStatus({ lotId: mine.id, status: "done" });
    expect(done.status).toBe("done");
    expect(done.statusByCrewId).toBe(w.crew.id);
    const again = await api.setLotStatus({ lotId: mine.id, status: "done" });
    expect(again.statusAt).toBe(done.statusAt);
    const back = await api.setLotStatus({ lotId: mine.id, status: "open" });
    expect(back.status).toBe("open");

    const westLot = addLot(w, north(100, WEST), { ccId: w.west.id });
    expect(await codeOf(api.setLotStatus({ lotId: westLot.id, status: "done" }))).toBe("FORBIDDEN");
  });

  test("map carries the truck bringing the crew's request", async () => {
    const api = callerFor(w.crew.id, w.east.id);
    expect((await api.map()).trucks).toEqual([]);
    await api.createRequest({ typeId: w.typeId("water"), qty: 1 });
    const m = await api.map();
    expect(m.trucks.map((t) => t.name)).toEqual(["Truck 1"]);
    expect(m.cc.id).toBe(w.east.id);
    expect(m.me).not.toBeNull();
  });
});

describe("crew scope", () => {
  test("a driver session is refused", async () => {
    const session = createSession({ role: "driver", truckId: w.truck.id, ccId: w.east.id });
    const api = crewRouter.createCaller({ session, ip: "test", ccOverride: null });
    expect(await codeOf(api.myRequests())).toBe("FORBIDDEN");
    const anon = crewRouter.createCaller({ session: null, ip: "test", ccOverride: null });
    expect(await codeOf(anon.lots())).toBe("UNAUTHORIZED");
  });
});
