import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LotGeometry } from "../../db/schema.ts";
import type { ParcelInput } from "../../parcels.ts";

// The db module opens $DATA_DIR at import; set the env before anything loads it.
const dir = mkdtempSync(join(tmpdir(), "lrbuddy-survey-test-"));
process.env.DATA_DIR = dir;
process.env.SESSION_SECRET = "test-secret";
process.env.OSRM_URL = "off";
process.env.VAPID_PUBLIC_KEY = "";
process.env.VAPID_PRIVATE_KEY = "";

const { db } = await import("../../db/index.ts");
const s = await import("../../db/schema.ts");
const setup = await import("../../setup.ts");
const d = await import("../../dispatch.ts");
const p = await import("../../parcels.ts");
const { createSession } = await import("../../auth.ts");
const { adminSession: mkAdmin } = await import("../../testing.ts");
const { planRouter } = await import("../plan.ts");
const { hullRing } = await import("./survey.ts");
const { and, eq } = await import("drizzle-orm");

afterAll(() => {
  d.cancelScheduledRoutes();
  rmSync(dir, { recursive: true, force: true });
});

// #region fixture
const square = (lat: number, lng: number): LotGeometry => {
  const k = 0.0001;
  return { type: "Polygon", coordinates: [[[lng - k, lat - k], [lng + k, lat - k], [lng + k, lat + k], [lng - k, lat + k], [lng - k, lat - k]]] };
};

const parcel = (street: string, n: number, lat: number, lng: number): ParcelInput => ({
  parcelId: `${street}-${n}.`,
  address: `${n} ${street}`,
  lat,
  lng,
  geometry: square(lat, lng),
  streetName: street.toUpperCase(),
  streetNumber: n,
  streetPrefix: null,
  crossStreet1: "Mack Ave",
  crossStreet2: "E Canfield St",
  propertyClass: "402",
  propertyClassDescription: "RESIDENTIAL-VACANT",
  taxpayer1: null,
  isImproved: false,
  pctPreClaimed: 0,
  saleDate: null,
});

const ODD = "GARLAND|E CANFIELD ST|MACK AVE|odd";
const EVEN = "GARLAND|E CANFIELD ST|MACK AVE|even";
let eventId = 0;
let dayId = 0;
let ccId = 0;
let admin: ReturnType<typeof planRouter.createCaller>;

beforeEach(() => {
  d.cancelScheduledRoutes();
  db.delete(s.events).run();
  db.delete(s.parcels).run();
  const ev = setup.createEvent({ name: "Test", year: 2026, startDate: "2026-09-28", dayCount: 2, active: true });
  eventId = ev.id;
  dayId = db.select().from(s.days).where(eq(s.days.eventId, ev.id)).orderBy(s.days.sort).get()!.id;
  ccId = setup.createCc({ dayId, name: "East", lat: 42.3786, lng: -82.9911 }).id;
  p.upsertParcels([
    parcel("Garland", 3961, 42.3801, -82.99),
    parcel("Garland", 3963, 42.3803, -82.99),
    parcel("Garland", 3965, 42.3805, -82.99),
    parcel("Garland", 3964, 42.3802, -82.9897),
  ]);
  admin = planRouter.createCaller({ session: mkAdmin("Kelsey"), ip: "test", ccOverride: null });
});
// #endregion

describe("hullRing", () => {
  test("closed convex outline around the points, inner points dropped", () => {
    const ring = hullRing([
      [0, 0],
      [2, 0],
      [2, 2],
      [0, 2],
      [1, 1],
      [1, 0],
    ]);
    expect(ring[0]).toEqual(ring[ring.length - 1]!);
    expect(ring).toHaveLength(5);
    expect(ring.map((r) => r.join(","))).not.toContain("1,1");
  });
  test("nothing in, nothing out", () => {
    expect(hullRing([])).toEqual([]);
  });
});

describe("survey.sides", () => {
  test("lists touched sides with an outline round every parcel on them, and the rules", async () => {
    await admin.survey.tag({ parcelId: "Garland-3961.", grade: "high" });
    await admin.survey.tag({ parcelId: "Garland-3964.", grade: "clear" });
    const r = await admin.survey.sides();
    expect(r.rules.darkAt).toBe(10);
    expect(r.rules.gradeMeaning.high).toBe("Half day for a crew");
    const odd = r.sides.find((x) => x.key === ODD)!;
    expect(odd).toMatchObject({ parcelCount: 3, high: 1, workCount: 1, band: "light" });
    // Three parcels in a column: the hull spans the first to the last one, outline included.
    const lats = odd.outline.map((pt) => pt[1]);
    expect(Math.min(...lats)).toBeCloseTo(42.38, 4);
    expect(Math.max(...lats)).toBeCloseTo(42.3806, 4);
    expect(r.sides.find((x) => x.key === EVEN)).toMatchObject({ band: "none", workCount: 0 });
  });

  test("with a day, only sides assigned to that day", async () => {
    await admin.survey.tag({ parcelId: "Garland-3961.", grade: "low" });
    await admin.survey.tag({ parcelId: "Garland-3964.", grade: "low" });
    const company = db.insert(s.companies).values({ eventId, name: "Ford" }).returning().get();
    db.insert(s.assignments).values({ eventId, dayId, ccId, companyId: company.id, blockSideKey: EVEN, order: 0 }).run();
    const r = await admin.survey.sides({ dayId });
    expect(r.sides.map((x) => x.key)).toEqual([EVEN]);
    const list = await admin.survey.list({ dayId });
    expect(list.map((x) => x.parcelId)).toEqual(["Garland-3964."]);
  });
});

describe("survey photo lot", () => {
  test("lotOf is empty until a photo needs a lot; lotForPhoto makes one survey lot, once", async () => {
    expect(await admin.survey.lotOf({ parcelId: "Garland-3963." })).toEqual({ lotId: null });
    const a = await admin.survey.lotForPhoto({ parcelId: "Garland-3963." });
    const b = await admin.survey.lotForPhoto({ parcelId: "Garland-3963." });
    expect(b.lotId).toBe(a.lotId);
    expect(await admin.survey.lotOf({ parcelId: "Garland-3963." })).toEqual({ lotId: a.lotId });
    const rows = db.select().from(s.lots).where(and(eq(s.lots.eventId, eventId), eq(s.lots.parcelId, "Garland-3963."))).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: "survey", status: "open", ccId: null, address: "3963 Garland" });
    expect(rows[0]!.geometry).not.toBeNull();
  });

  test("an existing lot on the parcel is reused", async () => {
    const lot = db.insert(s.lots).values({ eventId, parcelId: "Garland-3961.", lat: 42.3801, lng: -82.99, source: "dlba" }).returning().get();
    expect(await admin.survey.lotForPhoto({ parcelId: "Garland-3961." })).toEqual({ lotId: lot.id });
  });

  test("an unknown parcel is refused", async () => {
    await expect(admin.survey.lotForPhoto({ parcelId: "nope." })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
