import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Audit findings, 2026-10-01 (docs/AUDIT-2026-10-01.md). Each test failed on the
// code as it stood and passes once the finding is fixed.

const dir = mkdtempSync(join(tmpdir(), "lrbuddy-audit-test-"));
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
const a = await import("./access.ts");
const photos = await import("./photos.ts");
const { config } = await import("./config.ts");
const { createSession } = await import("./auth.ts");
const { accessRouter } = await import("./routers/access.ts");
const { sharedRouter } = await import("./routers/shared.ts");
const { eq } = await import("drizzle-orm");

afterAll(() => {
  d.cancelScheduledRoutes();
  rmSync(dir, { recursive: true, force: true });
});

// #region fixture
const EAST = { lat: 42.3786, lng: -82.9911 };

const fresh = () => {
  d.cancelScheduledRoutes();
  db.delete(s.events).run();
  db.delete(s.users).run();
  db.delete(s.sessions).run();
  db.delete(s.positions).run();
  const ev = setup.createEvent({ name: "Audit", year: 2026, startDate: "2026-09-28", dayCount: 2, active: true });
  const [d1, d2] = db.select().from(s.days).where(eq(s.days.eventId, ev.id)).orderBy(s.days.sort).all();
  const east = setup.createCc({ dayId: d1!.id, name: "East", ...EAST, code: "AUDE01" });
  const east2 = setup.createCc({ dayId: d2!.id, name: "East", ...EAST, code: "AUDE02" });
  const crew = setup.createCrew({ dayId: d1!.id, ccId: east.id, companyId: null, token: "audit-crew-01" });
  const crew2 = setup.createCrew({ dayId: d2!.id, ccId: east2.id, companyId: null, token: "audit-crew-02" });
  const truck = setup.createTruck({ dayId: d1!.id, ccId: east.id, name: "Truck 1" });
  const types = db.select().from(s.requestTypes).where(eq(s.requestTypes.eventId, ev.id)).all();
  return { ev, d1: d1!, d2: d2!, east, east2, crew, crew2, truck, typeId: (key: string) => types.find((t) => t.key === key)!.id };
};

let w: ReturnType<typeof fresh>;
beforeEach(() => {
  w = fresh();
});
// #endregion

describe("photo zip", () => {
  // A live photo row whose file is gone (a delete racing the download, a failed
  // write) left the ReadableStream's pull resolved without a chunk, so the
  // stream never asked again and the admin's download hung for good.
  test("a missing file is skipped and the zip still ends", async () => {
    const lot = db.insert(s.lots).values({ eventId: w.ev.id, lat: EAST.lat, lng: EAST.lng, source: "manual", status: "open" }).returning().get();
    const row = (id: number) =>
      db
        .insert(s.lotPhotos)
        .values({ id, lotId: lot.id, kind: "before", sessionId: "x", role: "admin", at: Date.now() + id, width: 1, height: 1, bytes: 6 })
        .returning()
        .get();
    const missing = row(901);
    const present = row(902);
    await Bun.write(photos.photoPath(present.id), new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]));
    const read = new Response(photos.photoZipStream([missing, present])).arrayBuffer();
    const timeout = new Promise<"stalled">((r) => setTimeout(() => r("stalled"), 2000));
    const out = await Promise.race([read, timeout]);
    expect(out).not.toBe("stalled");
    const bytes = new Uint8Array(out as ArrayBuffer);
    // One local file header (PK\x03\x04) for the photo that exists.
    let headers = 0;
    for (let i = 0; i + 3 < bytes.length; i++) if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x03 && bytes[i + 3] === 0x04) headers++;
    expect(headers).toBe(1);
  });
});

describe("route computations", () => {
  // Two computations for one truck can overlap: the debounce only spaces their
  // starts, and OSRM may take up to 4 s per group. The older one finishing last
  // wrote a route that still held a stop delivered or cancelled in between.
  test("an older computation finishing last does not overwrite a newer route", async () => {
    let calls = 0;
    const slow = Bun.serve({
      port: 0,
      async fetch() {
        calls++;
        if (calls === 1) await Bun.sleep(400);
        return new Response("no", { status: 500 });
      },
    });
    const mutable = config as { osrmUrl: string };
    const before = mutable.osrmUrl;
    mutable.osrmUrl = `http://127.0.0.1:${slow.port}`;
    try {
      const r = d.createRequest({ crewId: w.crew.id, ccId: w.east.id, dayId: w.d1.id, typeId: w.typeId("water"), qty: 1, createdBy: "crew", lat: 42.38, lng: -82.99 });
      d.cancelScheduledRoutes();
      expect(r.truckId).toBe(w.truck.id);
      const first = d.computeRouteNow(w.truck.id);
      await Bun.sleep(50);
      d.cancelRequest(r.id, "green");
      d.cancelScheduledRoutes();
      const second = await d.computeRouteNow(w.truck.id);
      expect(second?.legs.length).toBe(0);
      await first;
      const saved = db.select().from(s.routes).where(eq(s.routes.truckId, w.truck.id)).get();
      expect(saved?.legs.map((l) => l.key)).toEqual([]);
    } finally {
      mutable.osrmUrl = before;
      slow.stop(true);
    }
  });
});

describe("push subscriptions", () => {
  // The server POSTs to whatever endpoint a session registers. Browser push
  // services are always https; an http or loopback endpoint only turns the
  // server into a blind POST relay into its own network.
  test("an http or private endpoint is refused", async () => {
    const api = sharedRouter.createCaller({ session: createSession({ role: "crew", crewId: w.crew.id, ccId: w.east.id }), ip: "test", ccOverride: null });
    const keys = { p256dh: "k", auth: "a" };
    await expect(api.push.subscribe({ endpoint: "http://127.0.0.1:7682/notify", keys })).rejects.toThrow();
    await expect(api.push.subscribe({ endpoint: "https://localhost/x", keys })).rejects.toThrow();
    await expect(api.push.subscribe({ endpoint: "https://10.0.0.5/x", keys })).rejects.toThrow();
    await expect(api.push.subscribe({ endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys })).resolves.toEqual({ ok: true });
    expect(db.select().from(s.pushSubscriptions).all().map((r) => r.endpoint)).toEqual(["https://fcm.googleapis.com/fcm/send/abc"]);
  });
});

describe("access chooser", () => {
  // SPEC 18: on an event day the session picks today's approved membership.
  // `access.enter` took any approved membership of the event, so a red shirt
  // approved for Day 2 could act as that crew on Day 1 by posting its id.
  test("enter refuses a membership for another day while today is an event day", async () => {
    const user = a.upsertUser({ uid: "audit-u1", phone: "+13135550142", email: null, name: null }, "Jordan Reed");
    const session = createSession({ role: "none", userId: user.id, displayName: user.name });
    const now = Date.now();
    const other = db
      .insert(s.memberships)
      .values({ userId: user.id, eventId: w.ev.id, role: "crew", dayId: w.d2.id, ccId: w.east2.id, crewId: w.crew2.id, status: "approved", requestedAt: now, decidedAt: now })
      .returning()
      .get();
    const today = db
      .insert(s.memberships)
      .values({ userId: user.id, eventId: w.ev.id, role: "crew", dayId: w.d1.id, ccId: w.east.id, crewId: w.crew.id, status: "approved", requestedAt: now, decidedAt: now })
      .returning()
      .get();
    // Day 1 is today in Detroit.
    db.update(s.days).set({ date: a.detroitDate() }).where(eq(s.days.id, w.d1.id)).run();
    db.update(s.days).set({ date: "2099-01-02" }).where(eq(s.days.id, w.d2.id)).run();
    const api = accessRouter.createCaller({ session, ip: "test", ccOverride: null });
    await expect(api.enter({ id: other.id })).rejects.toThrow();
    await expect(api.enter({ id: today.id })).resolves.toEqual({ role: "crew" });
  });
});
