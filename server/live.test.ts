import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Review findings, fix round 2: an open live stream keeps the scope it had
// when it opened. A revoked session kept receiving its CC's events, and a
// truck moved to another CC kept the old CC's events and missed the new one's.

const dir = mkdtempSync(join(tmpdir(), "lrbuddy-live-test-"));
process.env.DATA_DIR = dir;
process.env.SESSION_SECRET ??= "test-secret";
process.env.OSRM_URL = "off";
process.env.VAPID_PUBLIC_KEY = "";
process.env.VAPID_PRIVATE_KEY = "";

const { db } = await import("./db/index.ts");
const s = await import("./db/schema.ts");
const d = await import("./dispatch.ts");
const setup = await import("./setup.ts");
const { createSession, deleteSession } = await import("./auth.ts");
const { adminSession: mkAdmin } = await import("./testing.ts");
const { adminRouter } = await import("./routers/admin.ts");
const { greenRouter } = await import("./routers/green.ts");
const { sharedRouter } = await import("./routers/shared.ts");
const { crewRouter } = await import("./routers/crew.ts");
const { eq } = await import("drizzle-orm");

afterAll(() => {
  d.cancelScheduledRoutes();
  rmSync(dir, { recursive: true, force: true });
});

// #region fixture
const EAST = { lat: 42.3786, lng: -82.9911 };
const WEST = { lat: 42.3701, lng: -83.0209 };

const fresh = () => {
  d.cancelScheduledRoutes();
  db.delete(s.events).run();
  const ev = setup.createEvent({ name: "Live", year: 2026, startDate: "2026-09-28", dayCount: 1, active: true });
  const day = db.select().from(s.days).where(eq(s.days.eventId, ev.id)).get()!;
  const east = setup.createCc({ dayId: day.id, name: "East", ...EAST });
  const west = setup.createCc({ dayId: day.id, name: "West", ...WEST });
  return { dayId: day.id, east, west };
};

let w: ReturnType<typeof fresh>;
beforeEach(() => {
  w = fresh();
});

const admin = () => adminRouter.createCaller({ session: mkAdmin(), ip: "test", ccOverride: null });
const green = (ccId: number) => greenRouter.createCaller({ session: createSession({ role: "green", ccId }), ip: "test", ccOverride: null });

/** Reads a stream in the background until it ends or `stop` is called. */
const drain = async <T>(iterable: AsyncIterable<T>) => {
  const got: T[] = [];
  const state: { error: unknown; done: boolean } = { error: null, done: false };
  const it = iterable[Symbol.asyncIterator]();
  void (async () => {
    try {
      for (;;) {
        const r = await it.next();
        if (r.done) break;
        got.push(r.value);
      }
    } catch (err) {
      state.error = err;
    } finally {
      state.done = true;
    }
  })();
  // Let the generator reach its bus listener before anything is emitted.
  await Bun.sleep(10);
  return { got, state, stop: () => void it.return?.(undefined) };
};

const bodies = (msgs: ReadonlyArray<{ type: string; payload: unknown }>): string[] =>
  msgs.flatMap((m) => (m.type === "broadcast" ? [(m.payload as { broadcast: { body: string } }).broadcast.body] : []));

const code = (err: unknown): string | null =>
  typeof err === "object" && err !== null && "code" in err ? String((err as { code: unknown }).code) : null;
// #endregion

describe("a revoked session's open stream", () => {
  test("crew token regenerated: shared.onCc ends with UNAUTHORIZED and gets nothing after", async () => {
    const crew = setup.createCrew({ dayId: w.dayId, ccId: w.west.id, companyId: null });
    const session = createSession({ role: "crew", crewId: crew.id, ccId: w.west.id });
    const stream = await drain(await sharedRouter.createCaller({ session, ip: "test", ccOverride: null }).onCc());
    await green(w.west.id).broadcast({ body: "before revoke" });
    await Bun.sleep(10);
    expect(bodies(stream.got)).toEqual(["before revoke"]);

    await admin().crews.regenerateToken({ id: crew.id });
    await green(w.west.id).broadcast({ body: "SECRET after revoke" });
    await Bun.sleep(10);
    expect(bodies(stream.got)).toEqual(["before revoke"]);
    expect(stream.state.done).toBe(true);
    expect(code(stream.state.error)).toBe("UNAUTHORIZED");
  });

  test("truck code regenerated: the driver's stream ends", async () => {
    const truck = setup.createTruck({ dayId: w.dayId, ccId: w.west.id, name: "Truck 3" });
    const session = createSession({ role: "driver", truckId: truck.id, ccId: w.west.id });
    const stream = await drain(await sharedRouter.createCaller({ session, ip: "test", ccOverride: null }).onCc());
    await admin().trucks.regenerateCode({ id: truck.id });
    await green(w.west.id).broadcast({ body: "after revoke" });
    await Bun.sleep(10);
    expect(bodies(stream.got)).toEqual([]);
    expect(code(stream.state.error)).toBe("UNAUTHORIZED");
  });

  test("green code regenerated: the green stream ends", async () => {
    const session = createSession({ role: "green", ccId: w.west.id });
    const stream = await drain(await sharedRouter.createCaller({ session, ip: "test", ccOverride: null }).onCc());
    await admin().greenCodes.regenerate({ ccId: w.west.id });
    await green(w.west.id).broadcast({ body: "after revoke" });
    await Bun.sleep(10);
    expect(bodies(stream.got)).toEqual([]);
    expect(code(stream.state.error)).toBe("UNAUTHORIZED");
  });

  test("signed out: crew.onMine and admin.onEvent end too", async () => {
    const crew = setup.createCrew({ dayId: w.dayId, ccId: w.west.id, companyId: null });
    const crewSession = createSession({ role: "crew", crewId: crew.id, ccId: w.west.id });
    const adminSession = mkAdmin();
    const mine = await drain(await crewRouter.createCaller({ session: crewSession, ip: "test", ccOverride: null }).onMine());
    const all = await drain(await adminRouter.createCaller({ session: adminSession, ip: "test", ccOverride: null }).onEvent());
    deleteSession(crewSession.id);
    deleteSession(adminSession.id);
    await green(w.west.id).broadcast({ body: "after logout" });
    await Bun.sleep(10);
    expect(bodies(mine.got)).toEqual([]);
    expect(bodies(all.got)).toEqual([]);
    expect(code(mine.state.error)).toBe("UNAUTHORIZED");
    expect(code(all.state.error)).toBe("UNAUTHORIZED");
  });

  test("a live session's stream stays open through an unrelated admin write", async () => {
    const crew = setup.createCrew({ dayId: w.dayId, ccId: w.west.id, companyId: null });
    const other = setup.createCrew({ dayId: w.dayId, ccId: w.west.id, companyId: null });
    const session = createSession({ role: "crew", crewId: crew.id, ccId: w.west.id });
    const stream = await drain(await sharedRouter.createCaller({ session, ip: "test", ccOverride: null }).onCc());
    await admin().crews.regenerateToken({ id: other.id });
    await green(w.west.id).broadcast({ body: "still here" });
    await Bun.sleep(10);
    expect(bodies(stream.got)).toEqual(["still here"]);
    expect(stream.state.done).toBe(false);
    stream.stop();
  });
});

describe("an open stream follows a truck or crew to its new CC", () => {
  test("truck moved West to East: the driver gets East's broadcast, not West's", async () => {
    const truck = setup.createTruck({ dayId: w.dayId, ccId: w.west.id, name: "Truck 3" });
    const session = createSession({ role: "driver", truckId: truck.id, ccId: w.west.id });
    const stream = await drain(await sharedRouter.createCaller({ session, ip: "test", ccOverride: null }).onCc());
    await admin().trucks.update({ id: truck.id, ccId: w.east.id });
    await green(w.east.id).broadcast({ body: "EAST after move" });
    await green(w.west.id).broadcast({ body: "WEST after move" });
    await Bun.sleep(10);
    expect(bodies(stream.got)).toEqual(["EAST after move"]);
    const moved = stream.got.find((m) => m.type === "scope.changed");
    expect(moved).toMatchObject({ type: "scope.changed", ccId: w.east.id, dayId: w.dayId });
    expect(stream.state.done).toBe(false);
    stream.stop();
  });

  test("crew moved East to West: shared.onCc and crew.onMine follow", async () => {
    const crew = setup.createCrew({ dayId: w.dayId, ccId: w.east.id, companyId: null });
    const session = createSession({ role: "crew", crewId: crew.id, ccId: w.east.id });
    const cc = await drain(await sharedRouter.createCaller({ session, ip: "test", ccOverride: null }).onCc());
    const mine = await drain(await crewRouter.createCaller({ session, ip: "test", ccOverride: null }).onMine());
    await admin().crews.update({ id: crew.id, ccId: w.west.id });
    await green(w.east.id).broadcast({ body: "EAST after move" });
    await green(w.west.id).broadcast({ body: "WEST after move" });
    await Bun.sleep(10);
    expect(bodies(cc.got)).toEqual(["WEST after move"]);
    expect(bodies(mine.got)).toEqual(["WEST after move"]);
    expect(cc.got.some((m) => m.type === "scope.changed")).toBe(true);
    cc.stop();
    mine.stop();
  });
});
