import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Same pattern as dispatch.test.ts: the db opens $DATA_DIR at import, so the
// env is set first and every app module is imported dynamically.
const dir = mkdtempSync(join(tmpdir(), "lrbuddy-green-test-"));
process.env.DATA_DIR ??= dir;
process.env.SESSION_SECRET ??= "test-secret";
process.env.OSRM_URL = "off";
process.env.VAPID_PUBLIC_KEY = "";
process.env.VAPID_PRIVATE_KEY = "";

const { db } = await import("./db/index.ts");
const s = await import("./db/schema.ts");
const d = await import("./dispatch.ts");
const setup = await import("./setup.ts");
const { bus } = await import("./bus.ts");
const { greenRouter } = await import("./routers/green.ts");
const { adminSession: mkAdmin } = await import("./testing.ts");
const { eq, and } = await import("drizzle-orm");

type Session = typeof s.sessions.$inferSelect;

afterAll(() => {
  d.cancelScheduledRoutes();
  rmSync(dir, { recursive: true, force: true });
});

// #region fixture
const CC_EAST = { lat: 42.3786, lng: -82.9911 };
const CC_WEST = { lat: 42.3701, lng: -83.0209 };
const north = (km: number) => ({ lat: CC_EAST.lat + km / 111.2, lng: CC_EAST.lng });

const session = (role: Session["role"], ccId: number | null): Session => ({
  id: crypto.randomUUID(),
  role,
  userId: null,
  membershipId: null,
  crewId: null,
  truckId: null,
  ccId,
  displayName: "Test green",
  createdAt: Date.now(),
  lastUsedAt: Date.now(),
  userAgent: null,
});

const callerFor = (sess: Session | null, ccOverride: number | null = null) => greenRouter.createCaller({ session: sess, ip: "127.0.0.1", ccOverride });

const world = () => {
  d.cancelScheduledRoutes();
  db.delete(s.events).run();
  db.delete(s.positions).run();
  const ev = setup.createEvent({ name: "Green test", year: 2026, startDate: "2026-09-28", dayCount: 1, active: true });
  const day = db.select().from(s.days).where(eq(s.days.eventId, ev.id)).get()!;
  const east = setup.createCc({ dayId: day.id, name: "East", ...CC_EAST });
  const west = setup.createCc({ dayId: day.id, name: "West", ...CC_WEST });
  const types = db.select().from(s.requestTypes).where(eq(s.requestTypes.eventId, ev.id)).all();
  const typeId = (key: string) => types.find((t) => t.key === key)!.id;
  const now = Date.now();
  const truck = (ccId: number, name: string, pos: { lat: number; lng: number }) => {
    const t = setup.createTruck({ dayId: day.id, ccId, name });
    db.update(s.trucks).set({ lastSeenAt: now }).where(eq(s.trucks.id, t.id)).run();
    db.insert(s.positions).values({ kind: "truck", refId: t.id, ...pos, at: now }).run();
    return t;
  };
  return { ev, day, east, west, typeId, truck, now, green: callerFor(session("green", east.id)) };
};

const stockOf = (truckId: number, typeId: number) =>
  db.select().from(s.truckStock).where(and(eq(s.truckStock.truckId, truckId), eq(s.truckStock.typeId, typeId))).get()!;
// #endregion

describe("green router", () => {
  let w: ReturnType<typeof world>;
  beforeEach(() => {
    w = world();
  });

  test("a crewless stop on the map is dispatched to the nearest fresh truck", async () => {
    const near = w.truck(w.east.id, "Near", north(0.2));
    w.truck(w.east.id, "Far", north(3));
    const pin = north(0.4);
    const r = await w.green.createStop({ typeId: w.typeId("water"), qty: 2, ...pin, label: "Corner of Harding and Warren" });
    expect(r.status).toBe("assigned");
    expect(r.truckId).toBe(near.id);
    expect(r.crewId).toBeNull();
    expect(r.createdBy).toBe("green");
    expect(r.label).toBe("Corner of Harding and Warren");
    expect(r.lat).toBeCloseTo(pin.lat, 6);
  });

  test("a stop with no truck in range stays open", async () => {
    const r = await w.green.createStop({ typeId: w.typeId("snacks"), qty: 1, ...north(0.3) });
    expect(r.status).toBe("open");
    expect(r.truckId).toBeNull();
  });

  test("a stop names a crew only from this CC", async () => {
    const other = setup.createCrew({ dayId: w.day.id, ccId: w.west.id, companyId: null });
    await expect(w.green.createStop({ typeId: w.typeId("water"), qty: 1, ...north(0.3), crewId: other.id })).rejects.toThrow("Crew not at this command center");
  });

  test("assign moves a request to another truck at the CC, never to another CC", async () => {
    const a = w.truck(w.east.id, "A", north(0.1));
    const b = w.truck(w.east.id, "B", north(2));
    const westTruck = w.truck(w.west.id, "W", CC_WEST);
    const r = await w.green.createStop({ typeId: w.typeId("water"), qty: 1, ...north(0.2) });
    expect(r.truckId).toBe(a.id);
    const moved = await w.green.assign({ requestId: r.id, truckId: b.id });
    expect(moved.truckId).toBe(b.id);
    expect(moved.truckName).toBe("B");
    expect(moved.status).toBe("assigned");
    await expect(w.green.assign({ requestId: r.id, truckId: westTruck.id })).rejects.toThrow("Truck not at this command center");
  });

  test("a request at another CC is out of scope", async () => {
    const westGreen = callerFor(session("green", w.west.id));
    const r = await westGreen.createStop({ typeId: w.typeId("water"), qty: 1, ...CC_WEST });
    await expect(w.green.cancel({ requestId: r.id })).rejects.toThrow("Not at this command center");
    const mine = await w.green.requests();
    expect(mine.some((x) => x.id === r.id)).toBe(false);
  });

  test("cancel closes the request once", async () => {
    w.truck(w.east.id, "A", north(0.1));
    const r = await w.green.createStop({ typeId: w.typeId("water"), qty: 1, ...north(0.2) });
    const c = await w.green.cancel({ requestId: r.id });
    expect(c.status).toBe("cancelled");
    expect(c.cancelledBy).toBe("green");
    await expect(w.green.cancel({ requestId: r.id })).rejects.toThrow("Request already closed");
  });

  test("delivered takes stock off the truck that carried it", async () => {
    const t = w.truck(w.east.id, "A", north(0.1));
    const water = w.typeId("water");
    const before = stockOf(t.id, water).qty;
    const r = await w.green.createStop({ typeId: water, qty: 3, ...north(0.2) });
    const done = await w.green.deliver({ requestId: r.id });
    expect(done.status).toBe("delivered");
    expect(stockOf(t.id, water).qty).toBe(Math.max(0, before - 3));
    await expect(w.green.deliver({ requestId: r.id })).rejects.toThrow("Request already closed");
  });

  test("bulk lot assign touches only lots at this CC", async () => {
    const crew = setup.createCrew({ dayId: w.day.id, ccId: w.east.id, companyId: null });
    const mk = (ccId: number, n: number) =>
      db
        .insert(s.lots)
        .values({ eventId: w.ev.id, parcelId: `P${ccId}-${n}`, address: `${n} Harding`, lat: CC_EAST.lat, lng: CC_EAST.lng, source: "manual", ccId, status: "open" })
        .returning()
        .get();
    const mine = [mk(w.east.id, 1), mk(w.east.id, 2)];
    const theirs = mk(w.west.id, 3);
    const res = await w.green.assignLots({ lotIds: [...mine.map((l) => l.id), theirs.id], crewId: crew.id });
    expect(res.updated).toBe(2);
    expect(db.select().from(s.lots).where(eq(s.lots.id, theirs.id)).get()!.crewId).toBeNull();
    const view = await w.green.lots();
    expect(view.lots.every((l) => l.crewId === crew.id)).toBe(true);
    expect(view.counts.find((c) => c.crewId === crew.id)?.counts.open).toBe(2);
    const cleared = await w.green.assignLots({ lotIds: [mine[0]!.id], crewId: null });
    expect(cleared.updated).toBe(1);
  });

  test("crew lists never carry the join token", async () => {
    setup.createCrew({ dayId: w.day.id, ccId: w.east.id, companyId: null, leadName: "Jordan" });
    const crews = await w.green.crews();
    expect(crews).toHaveLength(1);
    expect("token" in crews[0]!).toBe(false);
    const overview = await w.green.overview();
    expect(overview.crews.every((c) => !("token" in c))).toBe(true);
  });

  test("broadcast is stored, emitted to the CC and listed newest first", async () => {
    const seen: string[] = [];
    const off = bus.subscribe((m) => {
      if (m.type === "broadcast" && m.ccId === w.east.id) seen.push(m.payload.broadcast.body);
    });
    await w.green.broadcast({ body: "Lunch at 12:30" });
    await w.green.broadcast({ body: "  Water at the CC  " });
    off();
    expect(seen).toEqual(["Lunch at 12:30", "Water at the CC"]);
    const list = await w.green.broadcasts();
    expect(list.map((b) => b.body)).toEqual(["Water at the CC", "Lunch at 12:30"]);
    expect(list[0]!.sentBy).toBe("Test green");
    await expect(w.green.broadcast({ body: "   " })).rejects.toThrow();
  });

  test("stats count by type and time to deliver", async () => {
    w.truck(w.east.id, "A", north(0.1));
    const a = await w.green.createStop({ typeId: w.typeId("water"), qty: 2, ...north(0.2) });
    await w.green.createStop({ typeId: w.typeId("water"), qty: 1, ...north(0.3) });
    const c = await w.green.createStop({ typeId: w.typeId("snacks"), qty: 1, ...north(0.3) });
    await w.green.deliver({ requestId: a.id });
    await w.green.cancel({ requestId: c.id });
    const st = await w.green.stats();
    expect(st.delivered).toBe(1);
    expect(st.open).toBe(0);
    expect(st.onTruck).toBe(1);
    expect(st.cancelled).toBe(1);
    expect(st.requestsByType).toEqual([{ label: "Water", count: 2, qty: 3 }]);
    expect(st.medianDeliverMs).not.toBeNull();
  });

  test("roles: admin needs a CC, drivers and crews are refused", async () => {
    const admin = callerFor(mkAdmin(), w.east.id);
    expect((await admin.overview()).cc.id).toBe(w.east.id);
    await expect(callerFor(mkAdmin()).overview()).rejects.toThrow("No command center");
    // An admin role with no admin membership behind it (a removed admin, a pre-SPEC 26 session) gets nothing.
    await expect(callerFor(session("admin", null), w.east.id).overview()).rejects.toThrow("Not allowed");
    await expect(callerFor(session("driver", null)).overview()).rejects.toThrow("Not allowed");
    await expect(callerFor(session("crew", null)).overview()).rejects.toThrow("Not allowed");
    await expect(callerFor(null).overview()).rejects.toThrow("Sign in");
  });
});

describe("lots follow the CC site across days", () => {
  test("Day 2's copied CC sees Day 1's lots; a Day 1 crew assignment reads as no crew", async () => {
    d.cancelScheduledRoutes();
    db.delete(s.events).run();
    const ev = setup.createEvent({ name: "Two days", year: 2027, startDate: "2027-09-27", dayCount: 2, active: true });
    const [d1, d2] = db.select().from(s.days).where(eq(s.days.eventId, ev.id)).orderBy(s.days.sort).all();
    const north1 = setup.createCc({ dayId: d1!.id, name: "North", ...CC_EAST });
    setup.createCc({ dayId: d1!.id, name: "South", ...CC_WEST });
    const crew1 = setup.createCrew({ dayId: d1!.id, ccId: north1.id, companyId: null });
    const lot = db
      .insert(s.lots)
      .values({ eventId: ev.id, lat: CC_EAST.lat, lng: CC_EAST.lng, source: "manual", status: "open", ccId: north1.id, crewId: crew1.id })
      .returning()
      .get();
    expect(setup.copySetupFromPreviousDay(d2!.id)).toEqual({ ccs: 2, trucks: 0 });
    const north2 = db.select().from(s.commandCenters).where(and(eq(s.commandCenters.dayId, d2!.id), eq(s.commandCenters.name, "North"))).get()!;
    const south2 = db.select().from(s.commandCenters).where(and(eq(s.commandCenters.dayId, d2!.id), eq(s.commandCenters.name, "South"))).get()!;

    const day2 = await callerFor(session("green", north2.id)).lots();
    expect(day2.lots.map((l) => l.id)).toEqual([lot.id]);
    expect(day2.lots[0]!.crewId).toBeNull();
    expect((await callerFor(session("green", south2.id)).lots()).lots).toHaveLength(0);
    // Day 1 keeps its view and its crew.
    const day1 = await callerFor(session("green", north1.id)).lots();
    expect(day1.lots[0]!.crewId).toBe(crew1.id);
    // Day 2 green can hand it to a Day 2 crew.
    const crew2 = setup.createCrew({ dayId: d2!.id, ccId: north2.id, companyId: null });
    expect(await callerFor(session("green", north2.id)).assignLots({ lotIds: [lot.id], crewId: crew2.id })).toEqual({ updated: 1 });
  });
});

describe("company filter", () => {
  test("lists only companies with a crew at this CC today", async () => {
    const w = world();
    const [ford, dte] = ["Ford", "DTE"].map((name) => db.insert(s.companies).values({ eventId: w.ev.id, name }).returning().get());
    setup.createCrew({ dayId: w.day.id, ccId: w.east.id, companyId: ford!.id });
    setup.createCrew({ dayId: w.day.id, ccId: w.west.id, companyId: dte!.id });
    const o = await w.green.overview();
    expect(o.companies.map((c) => c.name)).toEqual(["Ford"]);
  });
});

describe("wrap up", () => {
  test("work lots at this CC only, with crew and photo state; Before alone needs an After", async () => {
    const w = world();
    const crew = setup.createCrew({ dayId: w.day.id, ccId: w.east.id, companyId: null });
    const mk = (ccId: number, n: number, status: "open" | "in_progress" | "done" | "do_not_touch" | "not_todo", crewId: number | null = null) =>
      db
        .insert(s.lots)
        .values({ eventId: w.ev.id, parcelId: `W${ccId}-${n}`, address: `${n} Harding`, lat: CC_EAST.lat, lng: CC_EAST.lng, source: "manual", ccId, status, crewId })
        .returning()
        .get();
    const photo = (lotId: number, kind: "before" | "after", deletedAt: number | null = null) =>
      db
        .insert(s.lotPhotos)
        .values({ lotId, kind, role: "green", ccId: w.east.id, dayId: w.day.id, at: Date.now(), width: 10, height: 10, bytes: 10, deletedAt })
        .returning()
        .get();
    const before = mk(w.east.id, 1, "in_progress", crew.id);
    const both = mk(w.east.id, 2, "done");
    const bare = mk(w.east.id, 3, "open");
    mk(w.east.id, 4, "do_not_touch");
    mk(w.east.id, 5, "not_todo");
    const theirs = mk(w.west.id, 6, "open");
    const b1 = photo(before.id, "before");
    photo(before.id, "after", Date.now());
    photo(both.id, "before");
    const a2 = photo(both.id, "after");
    photo(theirs.id, "before");

    const rows = await w.green.wrap();
    expect(rows.map((r) => r.id).sort((a, b) => a - b)).toEqual([before.id, both.id, bare.id]);
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(before.id)).toMatchObject({ hasBefore: true, hasAfter: false, beforeThumb: b1.id, afterThumb: null, crewId: crew.id, crewName: expect.any(String) });
    expect(byId.get(both.id)).toMatchObject({ hasBefore: true, hasAfter: true, afterThumb: a2.id, crewName: null });
    expect(byId.get(bare.id)).toMatchObject({ hasBefore: false, hasAfter: false, beforeThumb: null });

    // The badges read the same state from the overview: Wrap up's needsAfter, Flag's hasBefore.
    const ov = await w.green.overview();
    const needs = ov.lots.filter((l) => l.needsAfter).map((l) => l.id);
    expect(needs).toEqual([before.id]);
    const noBefore = ov.lots.filter((l) => byId.has(l.id) && !l.hasBefore).map((l) => l.id);
    expect(noBefore).toEqual([bare.id]);

    // West sees only its own lot.
    const west = await callerFor(session("green", w.west.id)).wrap();
    expect(west.map((r) => r.id)).toEqual([theirs.id]);
  });

  test("Not done is a work lot on the list and needs no After; setLotStatus takes it and Todo again", async () => {
    const w = world();
    const lot = db
      .insert(s.lots)
      .values({ eventId: w.ev.id, parcelId: "ND-1", address: "7 Harding", lat: CC_EAST.lat, lng: CC_EAST.lng, source: "manual", ccId: w.east.id, status: "open" })
      .returning()
      .get();
    db.insert(s.lotPhotos).values({ lotId: lot.id, kind: "before", role: "green", ccId: w.east.id, dayId: w.day.id, at: Date.now(), width: 10, height: 10, bytes: 10 }).run();
    expect((await w.green.overview()).lots.find((l) => l.id === lot.id)?.needsAfter).toBe(true);

    const r = await w.green.setLotStatus({ lotId: lot.id, status: "not_done" });
    expect(r.lot?.status).toBe("not_done");
    const row = (await w.green.wrap()).find((l) => l.id === lot.id);
    expect(row).toMatchObject({ status: "not_done", hasBefore: true, hasAfter: false });
    // Nothing changed on the lot: no After badge on the Wrap up strip.
    expect((await w.green.overview()).lots.find((l) => l.id === lot.id)?.needsAfter).toBe(false);
    const stats = await w.green.stats();
    expect(stats.lotsByStatus.not_done).toBe(1);

    expect((await w.green.setLotStatus({ lotId: lot.id, status: "open" })).lot?.status).toBe("open");
  });

  test("roles: admin with a CC, never driver, crew or signed out", async () => {
    const w = world();
    expect(await callerFor(mkAdmin(), w.east.id).wrap()).toEqual([]);
    await expect(callerFor(mkAdmin()).wrap()).rejects.toThrow("No command center");
    await expect(callerFor(session("driver", null)).wrap()).rejects.toThrow("Not allowed");
    await expect(callerFor(session("crew", null)).wrap()).rejects.toThrow("Not allowed");
    await expect(callerFor(null).wrap()).rejects.toThrow("Sign in");
  });
});
