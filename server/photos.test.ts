import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Same setup as dispatch.test.ts: env first, then everything that opens the db.
const dir = mkdtempSync(join(tmpdir(), "lrbuddy-photos-test-"));
process.env.DATA_DIR = dir;
process.env.SESSION_SECRET = "test-secret";
process.env.OSRM_URL = "off";
process.env.VAPID_PUBLIC_KEY = "";
process.env.VAPID_PRIVATE_KEY = "";

const { db } = await import("./db/index.ts");
const s = await import("./db/schema.ts");
const d = await import("./dispatch.ts");
const setup = await import("./setup.ts");
const { createSession } = await import("./auth.ts");
const { adminSession: mkAdmin } = await import("./testing.ts");
const photos = await import("./photos.ts");
const { encode } = await import("jpeg-js");
const { eq } = await import("drizzle-orm");

afterAll(() => {
  d.cancelScheduledRoutes();
  rmSync(dir, { recursive: true, force: true });
});

// #region fixture
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const EAST = { lat: 42.3786, lng: -82.9911 };
const WEST = { lat: 42.3701, lng: -83.0209 };
const north = (m: number, from: { lat: number; lng: number }) => ({ lat: from.lat + m / 111_200, lng: from.lng });

const jpeg = (w = 32, h = 16): Uint8Array => new Uint8Array(encode({ width: w, height: h, data: new Uint8Array(w * h * 4).fill(128) }, 80).data);

const world = () => {
  d.cancelScheduledRoutes();
  db.delete(s.events).run();
  db.delete(s.positions).run();
  const ev = setup.createEvent({ name: "Test", year: 2026, startDate: "2026-09-28", dayCount: 1, active: true });
  const other = setup.createEvent({ name: "Other", year: 2025, startDate: "2025-09-28", dayCount: 1, active: false });
  const day = db.select().from(s.days).where(eq(s.days.eventId, ev.id)).get()!;
  const east = setup.createCc({ dayId: day.id, name: "East", ...EAST });
  const west = setup.createCc({ dayId: day.id, name: "West", ...WEST });
  const truck = setup.createTruck({ dayId: day.id, ccId: east.id, name: "Truck 1" });
  const westTruck = setup.createTruck({ dayId: day.id, ccId: west.id, name: "Truck 3" });
  const crew = setup.createCrew({ dayId: day.id, ccId: east.id, companyId: null });
  const mate = setup.createCrew({ dayId: day.id, ccId: east.id, companyId: null });
  // Crew 1 stands 2 km from East, close to a West lot.
  const crewAt = north(300, WEST);
  db.insert(s.positions).values({ kind: "crew", refId: crew.id, ...crewAt, at: Date.now() - MIN }).run();
  const lot = (at: { lat: number; lng: number }, ccId: number | null, eventId = ev.id) =>
    db.insert(s.lots).values({ eventId, lat: at.lat, lng: at.lng, source: "manual", address: "100 Test St", ccId }).returning().get();
  return {
    ev,
    day,
    east,
    west,
    eastLot: lot(north(100, EAST), east.id),
    westNear: lot(north(150, crewAt), west.id),
    westFar: lot(north(-900, WEST), west.id),
    otherEventLot: lot(EAST, null, other.id),
    crew: createSession({ role: "crew", crewId: crew.id, ccId: east.id, displayName: "Sam" }),
    mate: createSession({ role: "crew", crewId: mate.id, ccId: east.id, displayName: "Ana" }),
    driver: createSession({ role: "driver", truckId: truck.id, ccId: east.id, displayName: "Chris" }),
    westDriver: createSession({ role: "driver", truckId: westTruck.id, ccId: west.id, displayName: "Kim" }),
    green: createSession({ role: "green", ccId: east.id, displayName: "Dana" }),
    westGreen: createSession({ role: "green", ccId: west.id, displayName: "Tom" }),
    admin: mkAdmin("Admin"),
  };
};

type World = ReturnType<typeof world>;
let w: World;
beforeEach(() => {
  w = world();
});

const upload = async (
  session: { id: string } | null,
  lotId: number,
  opts: { kind?: string; photo?: Uint8Array; thumb?: Uint8Array; now?: number; heading?: string } = {},
): Promise<{ status: number; body: { ok: boolean; error?: string; photo?: { id: number } } }> => {
  const form = new FormData();
  form.set("lotId", String(lotId));
  form.set("kind", opts.kind ?? "before");
  form.set("photo", new Blob([opts.photo ?? jpeg(64, 48)], { type: "image/jpeg" }), "photo.jpg");
  form.set("thumb", new Blob([opts.thumb ?? jpeg(32, 24)], { type: "image/jpeg" }), "thumb.jpg");
  form.set("lat", "42.38");
  form.set("lng", "-82.99");
  if (opts.heading !== undefined) form.set("heading", opts.heading);
  const req = new Request("http://test/photos", { method: "POST", body: form, headers: session ? { cookie: `lrb_session=${session.id}` } : {} });
  const res = await photos.handlePhotoUpload(req, opts.now);
  return { status: res.status, body: (await res.json()) as { ok: boolean; error?: string; photo?: { id: number } } };
};

const scopeOf = (session: import("./db/schema.ts").Session) => photos.photoScope(session)!;
// #endregion

describe("upload authorisation", () => {
  test("no session is refused", async () => {
    expect((await upload(null, w.eastLot.id)).status).toBe(401);
  });

  test("crew: a lot at its CC, and a lot at another CC within 400 m of its last position", async () => {
    const a = await upload(w.crew, w.eastLot.id);
    expect(a.status).toBe(200);
    const b = await upload(w.crew, w.westNear.id, { kind: "after" });
    expect(b.status).toBe(200);
    const row = db.select().from(s.lotPhotos).where(eq(s.lotPhotos.id, a.body.photo!.id)).get()!;
    expect(row.crewId).toBe(w.crew.crewId);
    expect(row.ccId).toBe(w.east.id);
    expect(row.dayId).toBe(w.day.id);
    expect(row.takenBy).toBe("Sam");
    expect(row.width).toBe(64);
    expect(row.height).toBe(48);
    expect(existsSync(photos.photoPath(row.id))).toBe(true);
    expect(existsSync(photos.photoPath(row.id, true))).toBe(true);
  });

  test("heading: stored 0 to 360 when sent, null when not (the file input has none)", async () => {
    const rowOf = (id: number) => db.select().from(s.lotPhotos).where(eq(s.lotPhotos.id, id)).get()!;
    const a = await upload(w.crew, w.eastLot.id, { heading: "-30" });
    expect(rowOf(a.body.photo!.id)).toMatchObject({ heading: 330, lat: 42.38, lng: -82.99 });
    const b = await upload(w.crew, w.eastLot.id, { heading: "45.5" });
    expect(rowOf(b.body.photo!.id).heading).toBe(45.5);
    const c = await upload(w.crew, w.eastLot.id);
    expect(rowOf(c.body.photo!.id).heading).toBeNull();
    const d = await upload(w.crew, w.eastLot.id, { heading: "north" });
    expect(rowOf(d.body.photo!.id).heading).toBeNull();
  });

  test("crew: a lot at another CC and far away is refused", async () => {
    expect((await upload(w.crew, w.westFar.id)).status).toBe(403);
  });

  test("crew: with no position, only lots at its CC", async () => {
    expect((await upload(w.mate, w.westNear.id)).status).toBe(403);
    expect((await upload(w.mate, w.eastLot.id)).status).toBe(200);
  });

  test("driver and green photograph lots at their CC, none elsewhere", async () => {
    expect((await upload(w.driver, w.eastLot.id)).status).toBe(200);
    expect((await upload(w.driver, w.westNear.id)).status).toBe(403);
    expect((await upload(w.green, w.eastLot.id)).status).toBe(200);
    expect((await upload(w.green, w.westFar.id)).status).toBe(403);
    expect((await upload(w.westDriver, w.westFar.id)).status).toBe(200);
  });

  test("admin photographs every lot, filed under the lot's CC", async () => {
    const r = await upload(w.admin, w.westFar.id);
    expect(r.status).toBe(200);
    expect(db.select().from(s.lotPhotos).where(eq(s.lotPhotos.id, r.body.photo!.id)).get()!.ccId).toBe(w.west.id);
    expect((await upload(w.admin, w.otherEventLot.id)).status).toBe(200);
  });

  test("a lot in another event reads as not found", async () => {
    expect((await upload(w.green, w.otherEventLot.id)).status).toBe(404);
  });

  test("only JPEG, only before or after, 6 MB at most", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    expect((await upload(w.green, w.eastLot.id, { photo: png })).status).toBe(400);
    expect((await upload(w.green, w.eastLot.id, { thumb: png })).status).toBe(400);
    expect((await upload(w.green, w.eastLot.id, { kind: "during" })).status).toBe(400);
    const big = new Uint8Array(photos.MAX_PHOTO_BYTES + 1);
    big.set([0xff, 0xd8, 0xff]);
    expect((await upload(w.green, w.eastLot.id, { photo: big })).status).toBe(413);
    expect(db.select().from(s.lotPhotos).all().length).toBe(0);
  });

  test("a second photo of the same kind keeps the first; newest shows first", async () => {
    const t0 = Date.now();
    const a = await upload(w.crew, w.eastLot.id, { now: t0 });
    const b = await upload(w.crew, w.eastLot.id, { now: t0 + MIN });
    const list = photos.lotPhotoList(scopeOf(w.crew), w.eastLot);
    expect(list.photos.map((p) => p.id)).toEqual([b.body.photo!.id, a.body.photo!.id]);
    expect(list.canAdd).toBe(true);
    const sum = photos.photoSummary(w.ev.id).get(w.eastLot.id)!;
    expect(sum.before).toBe(b.body.photo!.id);
    expect(sum.beforeCount).toBe(2);
    expect(photos.pairState(sum)).toBe("before");
  });
});

describe("delete rules", () => {
  const take = async (session: { id: string }, lotId: number, now = Date.now()): Promise<number> => (await upload(session, lotId, { now })).body.photo!.id;

  test("the taker can delete the same day; files go, the row is marked", async () => {
    const id = await take(w.crew, w.eastLot.id);
    const r = photos.deletePhoto(scopeOf(w.crew), id);
    expect(r.ok).toBe(true);
    expect(db.select().from(s.lotPhotos).where(eq(s.lotPhotos.id, id)).get()!.deletedAt).not.toBeNull();
    expect(existsSync(photos.photoPath(id))).toBe(false);
    expect(existsSync(photos.photoPath(id, true))).toBe(false);
    expect(photos.lotPhotoList(scopeOf(w.crew), w.eastLot).photos).toHaveLength(0);
    const again = photos.deletePhoto(scopeOf(w.crew), id);
    expect(again.ok ? null : again.code).toBe("NOT_FOUND");
  });

  test("the taker cannot delete it the next day", async () => {
    const id = await take(w.crew, w.eastLot.id);
    const r = photos.deletePhoto(scopeOf(w.crew), id, Date.now() + DAY);
    expect(r.ok ? null : r.code).toBe("FORBIDDEN");
  });

  test("another crew or a driver cannot delete it", async () => {
    const id = await take(w.crew, w.eastLot.id);
    for (const who of [w.mate, w.driver]) {
      const r = photos.deletePhoto(scopeOf(who), id);
      expect(r.ok ? null : r.code).toBe("FORBIDDEN");
    }
  });

  test("green at the lot's CC can delete any, green elsewhere cannot", async () => {
    const id = await take(w.crew, w.eastLot.id, Date.now() - 3 * DAY);
    const west = photos.deletePhoto(scopeOf(w.westGreen), id);
    expect(west.ok ? null : west.code).toBe("FORBIDDEN");
    expect(photos.deletePhoto(scopeOf(w.green), id).ok).toBe(true);
  });

  test("admin can delete any", async () => {
    const id = await take(w.green, w.eastLot.id, Date.now() - 3 * DAY);
    expect(photos.deletePhoto(scopeOf(w.admin), id).ok).toBe(true);
  });

  test("the viewer offers Delete only where allowed", async () => {
    await take(w.crew, w.eastLot.id);
    expect(photos.lotPhotoList(scopeOf(w.crew), w.eastLot).photos[0]!.canDelete).toBe(true);
    expect(photos.lotPhotoList(scopeOf(w.mate), w.eastLot).photos[0]!.canDelete).toBe(false);
    expect(photos.lotPhotoList(scopeOf(w.green), w.eastLot).photos[0]!.canDelete).toBe(true);
  });
});

describe("serving and pairs", () => {
  test("files need a session of the lot's event; deleted photos are gone", async () => {
    const id = (await upload(w.crew, w.eastLot.id)).body.photo!.id;
    const get = (session: { id: string } | null, thumb = false) =>
      photos.servePhoto(new Request(`http://test/photos/${id}`, { headers: session ? { cookie: `lrb_session=${session.id}` } : {} }), id, thumb);
    expect((await get(null)).status).toBe(401);
    const ok = await get(w.westGreen, true);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("private, max-age=31536000");
    photos.deletePhoto(scopeOf(w.admin), id);
    expect((await get(w.admin)).status).toBe(404);
  });

  test("pairs take the newest of each kind; Missing after filters to a before with no after", async () => {
    await upload(w.crew, w.eastLot.id, { kind: "before" });
    await upload(w.crew, w.eastLot.id, { kind: "after" });
    await upload(w.green, w.eastLot.id, { kind: "after" });
    await upload(w.crew, w.westNear.id, { kind: "before" });
    const pairs = photos.photoPairs(photos.eventPhotos(w.ev.id));
    expect(pairs).toHaveLength(2);
    const east = pairs.find((p) => p.lotId === w.eastLot.id)!;
    expect(east.afterCount).toBe(2);
    expect(east.before).not.toBeNull();
    expect(photos.filterPairs(pairs, { missingAfter: true }).map((p) => p.lotId)).toEqual([w.westNear.id]);
    const names = [...photos.photoFileNames(photos.eventPhotos(w.ev.id)).values()];
    expect(names).toContain("day-1_east_100-test-st_after_2.jpg");
  });
});

describe("pairs zip", () => {
  test("only lots with both kinds; names from the address, numbered raws, same address _2; project line", () => {
    const w = world();
    const mk = (address: string | null, parcelId: string | null) =>
      db.insert(s.lots).values({ eventId: w.ev.id, lat: EAST.lat, lng: EAST.lng, source: "manual", address, parcelId, ccId: w.east.id }).returning().get();
    const shot = (lotId: number, kind: "before" | "after", at: number, deletedAt: number | null = null) =>
      db.insert(s.lotPhotos).values({ lotId, kind, role: "green", ccId: w.east.id, dayId: w.day.id, at, width: 10, height: 10, bytes: 10, deletedAt }).returning().get();
    const t0 = Date.UTC(2026, 9, 2, 16, 0);
    const a = mk("2208 Richton", "P1");
    const a1 = shot(a.id, "before", t0);
    const a2 = shot(a.id, "before", t0 + MIN);
    const a3 = shot(a.id, "after", t0 + 2 * MIN);
    const twin = mk("2208 Richton", "P2");
    const t1 = shot(twin.id, "before", t0);
    const t2 = shot(twin.id, "after", t0 + 3 * MIN);
    const lone = mk("9 Only Before", "P3");
    shot(lone.id, "before", t0);
    const gone = mk("5 Deleted After", "P4");
    shot(gone.id, "before", t0);
    shot(gone.id, "after", t0, t0 + MIN);
    const live = db.select().from(s.lotPhotos).all().filter((p) => p.deletedAt === null);

    const out = photos.pairsZip(live, 2026);
    expect(out.map((l) => l.lotId).sort()).toEqual([a.id, twin.id].sort());
    const first = out.find((l) => l.lotId === a.id)!;
    const second = out.find((l) => l.lotId === twin.id)!;
    expect([first.pairFile, second.pairFile].sort()).toEqual(["pairs/2208_Richton.jpg", "pairs/2208_Richton_2.jpg"]);
    const base = first.pairFile.slice(6, -4);
    expect(first).toMatchObject({ before: a2.id, after: a3.id, title: "2208 Richton, Detroit", subtitle: "Six Day Project 2026  ·  Oct 2" });
    expect(first.raw).toEqual([
      { id: a1.id, file: `raw/${base}_before_1.jpg` },
      { id: a2.id, file: `raw/${base}_before_2.jpg` },
      { id: a3.id, file: `raw/${base}_after.jpg` },
    ]);
    const base2 = second.pairFile.slice(6, -4);
    expect(second.raw).toEqual([
      { id: t1.id, file: `raw/${base2}_before.jpg` },
      { id: t2.id, file: `raw/${base2}_after.jpg` },
    ]);
  });
});
