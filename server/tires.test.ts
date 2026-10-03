import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Same pattern as dispatch.test.ts: the db opens $DATA_DIR at import, so the env goes first.
const dir = mkdtempSync(join(tmpdir(), "lrbuddy-tires-test-"));
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
const { createSession } = await import("./auth.ts");
const { tiresRouter } = await import("./routers/tires.ts");
const { adminSession } = await import("./testing.ts");
const { eq } = await import("drizzle-orm");
const { handleTirePhotoUpload, serveTirePhoto } = await import("./tires.ts");
const { encode } = await import("jpeg-js");

afterAll(() => {
  d.cancelScheduledRoutes();
  rmSync(dir, { recursive: true, force: true });
});

// #region fixture
const EAST = { lat: 42.3786, lng: -82.9911 };
const WEST = { lat: 42.3701, lng: -83.0209 };

const world = () => {
  d.cancelScheduledRoutes();
  db.delete(s.events).run();
  const ev = setup.createEvent({ name: "Tires", year: 2026, startDate: "2026-09-28", dayCount: 2, active: true });
  const [day1, day2] = db.select().from(s.days).where(eq(s.days.eventId, ev.id)).orderBy(s.days.sort).all();
  const east = setup.createCc({ dayId: day1!.id, name: "East", ...EAST });
  const west = setup.createCc({ dayId: day1!.id, name: "West", ...WEST });
  const east2 = setup.createCc({ dayId: day2!.id, name: "East", ...EAST });
  const crewA = setup.createCrew({ dayId: day1!.id, ccId: east.id, companyId: null });
  const crewB = setup.createCrew({ dayId: day1!.id, ccId: east.id, companyId: null });
  const crewW = setup.createCrew({ dayId: day1!.id, ccId: west.id, companyId: null });
  const crewE2 = setup.createCrew({ dayId: day2!.id, ccId: east2.id, companyId: null });
  const truck = setup.createTruck({ dayId: day1!.id, ccId: east.id, name: "Truck 1" });
  return { ev, day1: day1!, east, west, east2, crewA, crewB, crewW, crewE2, truck };
};
type World = ReturnType<typeof world>;

const crewCaller = (crewId: number) => tiresRouter.createCaller({ session: createSession({ role: "crew", crewId, displayName: "Sam" }), ip: "test", ccOverride: null });
const greenCaller = (ccId: number, name = "Jordan") => tiresRouter.createCaller({ session: createSession({ role: "green", ccId, displayName: name }), ip: "test", ccOverride: null });
const driverCaller = (truckId: number) => tiresRouter.createCaller({ session: createSession({ role: "driver", truckId, displayName: "Pat" }), ip: "test", ccOverride: null });

const codeOf = async (p: Promise<unknown>): Promise<string | null> => {
  try {
    await p;
    return null;
  } catch (e) {
    return (e as { code?: string }).code ?? "UNKNOWN";
  }
};

const near = (m: number) => ({ lat: EAST.lat + m / 111_200, lng: EAST.lng });
// #endregion

let w: World;
beforeEach(() => {
  w = world();
});

describe("tire piles", () => {
  test("a crew sees every pile at its CC and day, its own and other crews', and none from another CC or day", async () => {
    const a = await crewCaller(w.crewA.id).add(near(50));
    const b = await crewCaller(w.crewB.id).add(near(120));
    const g = await greenCaller(w.east.id, "Jordan").add(near(200));
    await crewCaller(w.crewW.id).add({ lat: WEST.lat, lng: WEST.lng });
    await crewCaller(w.crewE2.id).add(near(60));

    const seen = await crewCaller(w.crewA.id).list();
    expect(seen.map((p) => p.id)).toEqual([a.id, b.id, g.id]);
    expect(seen.map((p) => p.madeBy)).toEqual([w.crewA.name, w.crewB.name, "Jordan"]);
    expect(seen.map((p) => p.mine)).toEqual([true, false, false]);
    expect(seen.map((p) => p.canDelete)).toEqual([true, false, false]);
    expect(seen.every((p) => !p.canMove)).toBe(true);

    // The West crew and Day 2's crew at the same site see only their own CC row's piles.
    expect((await crewCaller(w.crewW.id).list()).length).toBe(1);
    expect((await crewCaller(w.crewE2.id).list()).length).toBe(1);
  });

  test("a crew deletes only piles its crew made", async () => {
    const a = await crewCaller(w.crewA.id).add(near(50));
    const b = await crewCaller(w.crewB.id).add(near(120));
    const g = await greenCaller(w.east.id).add(near(200));
    const crew = crewCaller(w.crewA.id);
    expect(await codeOf(crew.remove({ id: b.id }))).toBe("FORBIDDEN");
    expect(await codeOf(crew.remove({ id: g.id }))).toBe("FORBIDDEN");
    expect(await codeOf(crew.move({ id: a.id, ...near(70) }))).toBe("FORBIDDEN");
    expect(await crew.remove({ id: a.id })).toEqual({ id: a.id });
    expect((await crew.list()).map((p) => p.id)).toEqual([b.id, g.id]);
  });

  test("a crew cannot touch a pile at another CC", async () => {
    const west = await crewCaller(w.crewW.id).add({ lat: WEST.lat, lng: WEST.lng });
    expect(await codeOf(crewCaller(w.crewA.id).remove({ id: west.id }))).toBe("NOT_FOUND");
    expect(await codeOf(greenCaller(w.east.id).remove({ id: west.id }))).toBe("NOT_FOUND");
    expect(await codeOf(greenCaller(w.east.id).move({ id: west.id, ...near(10) }))).toBe("NOT_FOUND");
  });

  test("a green shirt adds, moves and deletes any pile at its CC", async () => {
    const a = await crewCaller(w.crewA.id).add(near(50));
    const green = greenCaller(w.east.id, "Jordan");
    const g = await green.add(near(200));
    expect(g).toMatchObject({ role: "green", crewId: null, madeBy: "Jordan", canMove: true, canDelete: true });
    const moved = await green.move({ id: a.id, ...near(80) });
    expect(moved.lat).toBeCloseTo(near(80).lat, 9);
    expect((await green.list()).every((p) => p.canMove && p.canDelete)).toBe(true);
    await green.remove({ id: a.id });
    await green.remove({ id: g.id });
    expect(await green.list()).toEqual([]);
  });

  test("a driver adds piles, sees every pile at its CC, deletes only its truck's, moves none", async () => {
    const a = await crewCaller(w.crewA.id).add(near(50));
    const g = await greenCaller(w.east.id).add(near(200));
    const driver = driverCaller(w.truck.id);
    const t = await driver.add(near(300));
    expect(t).toMatchObject({ role: "driver", crewId: null, truckId: w.truck.id, madeBy: "Truck 1", mine: true, canDelete: true, canMove: false });
    const seen = await driver.list();
    expect(seen.map((p) => p.id)).toEqual([a.id, g.id, t.id]);
    expect(seen.map((p) => p.canDelete)).toEqual([false, false, true]);
    expect(seen.every((p) => !p.canMove)).toBe(true);
    // The crew and the green shirt see the truck's pile; the crew may not delete it.
    expect((await crewCaller(w.crewA.id).list()).find((p) => p.id === t.id)).toMatchObject({ madeBy: "Truck 1", canDelete: false });
    expect((await greenCaller(w.east.id).list()).find((p) => p.id === t.id)).toMatchObject({ canDelete: true, canMove: true });
    expect(await codeOf(crewCaller(w.crewA.id).remove({ id: t.id }))).toBe("FORBIDDEN");
    expect(await codeOf(driver.move({ id: a.id, ...near(10) }))).toBe("FORBIDDEN");
    expect(await codeOf(driver.move({ id: t.id, ...near(10) }))).toBe("FORBIDDEN");
    expect(await codeOf(driver.remove({ id: a.id }))).toBe("FORBIDDEN");
    expect(await codeOf(driver.remove({ id: g.id }))).toBe("FORBIDDEN");
    expect(await driver.remove({ id: t.id })).toEqual({ id: t.id });
    // Another CC's truck sees none of them.
    const westTruck = setup.createTruck({ dayId: w.day1.id, ccId: w.west.id, name: "Truck 3" });
    expect((await driverCaller(westTruck.id).list()).map((p) => p.id)).toEqual([]);
  });

  test("admin acts at the CC named by ?cc=", async () => {
    const a = await crewCaller(w.crewA.id).add(near(50));
    const admin = tiresRouter.createCaller({ session: adminSession(), ip: "test", ccOverride: w.east.id });
    expect((await admin.list()).map((p) => p.id)).toEqual([a.id]);
    await admin.remove({ id: a.id });
    expect(await admin.list()).toEqual([]);
  });

  test("every change reaches the CC's live feed", async () => {
    const seen: Array<{ type: string; ccId: number | null; deleted?: boolean }> = [];
    const off = bus.subscribe((m) => {
      if (m.type === "tire.changed") seen.push({ type: m.type, ccId: m.ccId, deleted: m.payload.deleted });
    });
    const a = await crewCaller(w.crewA.id).add(near(50));
    await greenCaller(w.east.id).move({ id: a.id, ...near(60) });
    await crewCaller(w.crewA.id).remove({ id: a.id });
    off();
    expect(seen).toEqual([
      { type: "tire.changed", ccId: w.east.id, deleted: false },
      { type: "tire.changed", ccId: w.east.id, deleted: false },
      { type: "tire.changed", ccId: w.east.id, deleted: true },
    ]);
  });

  test("a green shirt photographs a pile; a crew cannot; any session of the event views it", async () => {
    const a = await crewCaller(w.crewA.id).add(near(50));
    const jpeg = new Uint8Array(encode({ width: 32, height: 16, data: new Uint8Array(32 * 16 * 4).fill(128) }, 80).data);
    const post = (session: { id: string }) => {
      const form = new FormData();
      form.set("pileId", String(a.id));
      form.set("photo", new Blob([jpeg], { type: "image/jpeg" }), "photo.jpg");
      form.set("thumb", new Blob([jpeg], { type: "image/jpeg" }), "thumb.jpg");
      return handleTirePhotoUpload(new Request("http://test/tire-photos", { method: "POST", body: form, headers: { cookie: `lrb_session=${session.id}` } }));
    };
    expect((await post(createSession({ role: "crew", crewId: w.crewA.id }))).status).toBe(403);
    expect((await post(createSession({ role: "green", ccId: w.west.id }))).status).toBe(403);
    const green = createSession({ role: "green", ccId: w.east.id, displayName: "Jordan" });
    expect((await post(green)).status).toBe(200);
    const row = (await crewCaller(w.crewA.id).list())[0]!;
    expect(row.photoAt).not.toBeNull();
    expect(row.photoBy).toBe("Jordan");
    const crewSession = createSession({ role: "crew", crewId: w.crewB.id });
    const got = await serveTirePhoto(new Request(`http://test/tire-photos/${a.id}`, { headers: { cookie: `lrb_session=${crewSession.id}` } }), a.id, false);
    expect(got.status).toBe(200);
    expect((await serveTirePhoto(new Request(`http://test/tire-photos/${a.id}`), a.id, false)).status).toBe(401);
    // Deleting the pile takes its photo with it.
    await greenCaller(w.east.id).remove({ id: a.id });
    expect((await serveTirePhoto(new Request(`http://test/tire-photos/${a.id}`, { headers: { cookie: `lrb_session=${crewSession.id}` } }), a.id, false)).status).toBe(404);
  });
});
