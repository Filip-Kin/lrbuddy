import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Review findings, 2026-09-30 (correctness and security pass). Each test fails
// on the code as it stands and passes once the defect is fixed.

const dir = mkdtempSync(join(tmpdir(), "lrbuddy-review-test-"));
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
const { createSession, getSession } = await import("./auth.ts");
const { adminRouter } = await import("./routers/admin.ts");
const { driverRouter } = await import("./routers/driver.ts");
const { sharedRouter } = await import("./routers/shared.ts");
const { eq } = await import("drizzle-orm");

afterAll(() => {
  d.cancelScheduledRoutes();
  rmSync(dir, { recursive: true, force: true });
});

// #region fixture
const MIN = 60_000;
const EAST = { lat: 42.3786, lng: -82.9911 };
const WEST = { lat: 42.3701, lng: -83.0209 };

const fresh = () => {
  d.cancelScheduledRoutes();
  db.delete(s.events).run();
  db.delete(s.positions).run();
  const ev = setup.createEvent({ name: "Review", year: 2026, startDate: "2026-09-28", dayCount: 1, active: true });
  const day = db.select().from(s.days).where(eq(s.days.eventId, ev.id)).get()!;
  const east = setup.createCc({ dayId: day.id, name: "East", ...EAST });
  const west = setup.createCc({ dayId: day.id, name: "West", ...WEST });
  const types = db.select().from(s.requestTypes).where(eq(s.requestTypes.eventId, ev.id)).all();
  return { dayId: day.id, east, west, typeId: (key: string) => types.find((t) => t.key === key)!.id };
};

let w: ReturnType<typeof fresh>;
beforeEach(() => {
  w = fresh();
});

const admin = () => adminRouter.createCaller({ session: createSession({ role: "admin" }), ip: "test", ccOverride: null });
// #endregion

describe("open requests reach a truck that comes back", () => {
  // shared.position sweeps open requests only when the truck was stale at that
  // moment. Every driver query (driverProcedure -> touchTruck) marks the truck
  // seen first, and the driver app loads its queue before the first GPS fix,
  // so the sweep never runs and the request sits open next to an idle truck.
  test("driver opens the queue, then posts a position: the open request is assigned", async () => {
    const now = Date.now();
    const truck = setup.createTruck({ dayId: w.dayId, ccId: w.east.id, name: "Truck 1" });
    db.update(s.trucks).set({ lastSeenAt: now - 60 * MIN }).where(eq(s.trucks.id, truck.id)).run();
    const crew = setup.createCrew({ dayId: w.dayId, ccId: w.east.id, companyId: null });
    db.insert(s.positions).values({ kind: "crew", refId: crew.id, ...EAST, at: now }).run();
    const r = d.createRequest({ crewId: crew.id, ccId: w.east.id, dayId: w.dayId, typeId: w.typeId("water"), qty: 1, createdBy: "crew" }, now);
    expect(r.status).toBe("open");

    const session = createSession({ role: "driver", truckId: truck.id, ccId: w.east.id });
    await driverRouter.createCaller({ session, ip: "test", ccOverride: null }).queue();
    await sharedRouter.createCaller({ session, ip: "test", ccOverride: null }).position({ ...EAST });

    const after = db.select().from(s.requests).where(eq(s.requests.id, r.id)).get()!;
    expect(after.status).toBe("assigned");
    expect(after.truckId).toBe(truck.id);
  });
});

describe("regenerating a code or token revokes it", () => {
  // Regenerate exists so a lost QR sheet or a leaked code stops working. The
  // sessions made with the old value stay valid for their full 30 days.
  test("a crew session made with the old join token ends", async () => {
    const crew = setup.createCrew({ dayId: w.dayId, ccId: w.east.id, companyId: null });
    const old = createSession({ role: "crew", crewId: crew.id, ccId: w.east.id });
    await admin().crews.regenerateToken({ id: crew.id });
    expect(getSession(old.id)).toBeNull();
  });

  test("a driver session made with the old truck code ends", async () => {
    const truck = setup.createTruck({ dayId: w.dayId, ccId: w.east.id, name: "Truck 1" });
    const old = createSession({ role: "driver", truckId: truck.id, ccId: w.east.id });
    await admin().trucks.regenerateCode({ id: truck.id });
    expect(getSession(old.id)).toBeNull();
  });

  test("a green session made with the old CC code ends", async () => {
    const old = createSession({ role: "green", ccId: w.east.id });
    await admin().greenCodes.regenerate({ ccId: w.east.id });
    expect(getSession(old.id)).toBeNull();
  });
});

describe("push scope follows a move", () => {
  // pushToCc selects sessions by sessions.cc_id, which is written once at
  // login and never updated. After an admin moves a truck or a crew, the old
  // CC's broadcasts keep going to them and the new CC's never arrive.
  test("moving a truck to another CC moves its driver sessions' CC", async () => {
    const truck = setup.createTruck({ dayId: w.dayId, ccId: w.east.id, name: "Truck 1" });
    const session = createSession({ role: "driver", truckId: truck.id, ccId: w.east.id });
    await admin().trucks.update({ id: truck.id, ccId: w.west.id });
    expect(db.select().from(s.sessions).where(eq(s.sessions.id, session.id)).get()?.ccId).toBe(w.west.id);
  });

  test("moving a crew to another CC moves its sessions' CC", async () => {
    const crew = setup.createCrew({ dayId: w.dayId, ccId: w.east.id, companyId: null });
    const session = createSession({ role: "crew", crewId: crew.id, ccId: w.east.id });
    await admin().crews.update({ id: crew.id, ccId: w.west.id });
    expect(db.select().from(s.sessions).where(eq(s.sessions.id, session.id)).get()?.ccId).toBe(w.west.id);
  });
});

describe("login rate limit", () => {
  // clientIp() takes the first X-Forwarded-For entry, which the caller writes.
  // A new value per request resets the 20 per minute limit, so truck and CC
  // codes (32^6) and the admin password can be guessed without a 429.
  test("a spoofed X-Forwarded-For per attempt still hits 429 by the 21st try", async () => {
    const port = 31000 + Math.floor(Math.random() * 2000);
    const dataDir = mkdtempSync(join(tmpdir(), "lrbuddy-review-rl-"));
    const proc = Bun.spawn(["bun", "server/index.ts"], {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, SESSION_SECRET: "x", ADMIN_PASSWORD: "right-password" },
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      const base = `http://127.0.0.1:${port}`;
      for (let i = 0; i < 50; i++) {
        const ok = await fetch(`${base}/health`).then((r) => r.ok).catch(() => false);
        if (ok) break;
        await Bun.sleep(100);
      }
      const codes: number[] = [];
      for (let i = 0; i < 25; i++) {
        const res = await fetch(`${base}/auth/login`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-forwarded-for": `198.51.100.${i + 1}` },
          body: JSON.stringify({ code: `WRONG${i}` }),
        });
        codes.push(res.status);
      }
      expect(codes).toContain(429);
    } finally {
      proc.kill();
      await proc.exited;
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 20_000);
});
