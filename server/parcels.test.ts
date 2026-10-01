import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LotGeometry, SurveyGrade } from "./db/schema.ts";
import type { BlockSideParcel, ParcelInput } from "./parcels.ts";

// The db module opens $DATA_DIR at import; set the env before anything loads it.
const dir = mkdtempSync(join(tmpdir(), "lrbuddy-parcels-test-"));
process.env.DATA_DIR = dir;
process.env.SESSION_SECRET = "test-secret";
process.env.ADMIN_PASSWORD = "test-admin";
process.env.OSRM_URL = "off";

const { db } = await import("./db/index.ts");
const s = await import("./db/schema.ts");
const setup = await import("./setup.ts");
const p = await import("./parcels.ts");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

// #region fixture
const square = (lat: number, lng: number): LotGeometry => {
  const d = 0.0001;
  return { type: "Polygon", coordinates: [[[lng - d, lat - d], [lng + d, lat - d], [lng + d, lat + d], [lng - d, lat + d], [lng - d, lat - d]]] };
};

/** A parcel on Garland between E Canfield St and Mack Ave. */
const garland = (n: number, extra: Partial<ParcelInput> = {}): ParcelInput => ({
  parcelId: `G${n}.`,
  address: `${n} Garland`,
  lat: 42.38 + n / 1e6,
  lng: -82.99,
  geometry: square(42.38 + n / 1e6, -82.99),
  streetName: "GARLAND",
  streetNumber: n,
  streetPrefix: null,
  crossStreet1: n % 4 === 1 ? "Mack Ave" : "E Canfield St",
  crossStreet2: n % 4 === 1 ? "E Canfield St" : "Mack Ave",
  propertyClass: "402",
  propertyClassDescription: "RESIDENTIAL-VACANT",
  taxpayer1: null,
  isImproved: false,
  pctPreClaimed: 0,
  saleDate: null,
  ...extra,
});
// #endregion

describe("blockSideKey", () => {
  test("odd and even sides of one block get different keys", () => {
    const odd = p.blockSideKey(garland(3965));
    const even = p.blockSideKey(garland(3964));
    expect(odd).toBe("GARLAND|E CANFIELD ST|MACK AVE|odd");
    expect(even).toBe("GARLAND|E CANFIELD ST|MACK AVE|even");
  });

  test("cross streets in either order make the same key", () => {
    expect(p.blockSideKey(garland(3965))).toBe(p.blockSideKey(garland(3961)));
  });

  test("missing cross streets fall back to street, hundred block and parity", () => {
    expect(p.blockSideKey(garland(3965, { crossStreet1: null, crossStreet2: "" }))).toBe("GARLAND|3900|odd");
    expect(p.blockSideKey(garland(3964, { crossStreet1: null, crossStreet2: null }))).toBe("GARLAND|3900|even");
    expect(p.parseKey("GARLAND|3900|odd")).toEqual({ street: "GARLAND", fromCross: null, toCross: null, block: 3900, parity: "odd" });
  });

  test("review: two blocks of one street with no cross streets are not one block side", () => {
    // Real rows from the layer (seed bbox, 2026-09-30): 3727 and 5533 Mcclellan both have blank
    // cross streets and sit about 1.4 km apart, two blocks apart. One key merges them, so one
    // assignment hands both blocks to one crew and the side's centre falls between them.
    const near = { streetName: "MCCLELLAN", streetNumber: 3727, crossStreet1: null, crossStreet2: null, address: "3727 Mcclellan" };
    const far = { streetName: "MCCLELLAN", streetNumber: 5533, crossStreet1: null, crossStreet2: null, address: "5533 Mcclellan" };
    expect(p.blockSideKey(near)).not.toBe(p.blockSideKey(far));
  });

  test("the prefix belongs to the street; the address fills a missing street or number", () => {
    expect(p.blockSideKey({ streetName: "Warren", streetPrefix: "E", streetNumber: 12, crossStreet1: "Chalmers", crossStreet2: "Alter" })).toBe(
      "E WARREN|ALTER|CHALMERS|even",
    );
    expect(p.blockSideKey({ streetName: null, streetNumber: null, address: "4477 Bewick" })).toBe("BEWICK|4400|odd");
  });

  test("no street or no number is no block side", () => {
    expect(p.blockSideKey({ streetName: "GARLAND", streetNumber: null })).toBeNull();
    expect(p.blockSideKey({ streetName: null, streetNumber: 12 })).toBeNull();
  });

  test("labels read street, span and side", () => {
    expect(p.blockSideLabel("GARLAND|E CANFIELD ST|MACK AVE|odd")).toBe("Garland, E Canfield St to Mack Ave, odd");
    expect(p.blockSideLabel("GARLAND|3900|even")).toBe("Garland, 3900 block, even");
  });
});

describe("block side aggregation", () => {
  const side = (key: string, grades: Array<SurveyGrade | null>): BlockSideParcel[] =>
    grades.map((grade, i) => ({ parcelId: `${key}-${i}`, blockSideKey: key, lat: 42.38 + i / 1e5, lng: -82.99, grade }));

  test("bands follow the work count: 0, 1 to 4, 5 to 9, 10 and up", () => {
    const rows = [
      ...side("A|odd", ["clear", "clear", null]),
      ...side("B|odd", ["low", "high", "low", null]),
      ...side("C|odd", [...Array<SurveyGrade>(5).fill("low"), "high", "high"]),
      ...side("D|odd", [...Array<SurveyGrade>(8).fill("low"), "high", "high", null, "clear"]),
    ];
    const out = p.aggregateBlockSides(rows);
    const by = new Map(out.map((b) => [b.key, b]));
    expect(by.get("A|odd")).toMatchObject({ workCount: 0, band: "none", clear: 2, parcelCount: 3 });
    expect(by.get("B|odd")).toMatchObject({ workCount: 3, band: "light", high: 1, low: 2, parcelCount: 4 });
    expect(by.get("C|odd")).toMatchObject({ workCount: 7, band: "mid" });
    expect(by.get("D|odd")).toMatchObject({ workCount: 10, band: "dark", parcelCount: 12, surveyed: 11 });
    expect(out.map((b) => b.key)).toEqual(["D|odd", "C|odd", "B|odd", "A|odd"]);
  });

  test("a side nobody surveyed is not listed", () => {
    expect(p.aggregateBlockSides(side("E|even", [null, null]))).toEqual([]);
  });

  test("band edges", () => {
    expect([0, 1, 4, 5, 9, 10, 30].map(p.bandFor)).toEqual(["none", "light", "light", "mid", "mid", "dark", "dark"]);
  });

  test("crews needed counts a high parcel as two low ones at the defaults", () => {
    expect(p.crewsNeeded(0, 0)).toBe(0);
    expect(p.crewsNeeded(0, 10)).toBe(1);
    expect(p.crewsNeeded(5, 0)).toBe(1);
    expect(p.crewsNeeded(3, 5)).toBe(2);
    expect(p.crewsNeeded(0, 11)).toBe(2);
  });
});

describe("blockSides from the database", () => {
  let eventId = 0;
  beforeEach(() => {
    db.delete(s.events).run();
    db.delete(s.parcels).run();
    eventId = setup.createEvent({ name: "Test", year: 2026, startDate: "2026-09-28", dayCount: 1, active: true }).id;
  });

  test("joins the newest tag per parcel; clear takes a parcel off the work list", () => {
    p.upsertParcels([garland(3961), garland(3963), garland(3965), garland(3964)]);
    const tag = (parcelId: string, grade: SurveyGrade, at: number): void => {
      db.insert(s.surveyTags).values({ eventId, parcelId, grade, side: "tap", by: "Kelsey", at }).run();
    };
    tag("G3961.", "low", 1000);
    tag("G3961.", "high", 2000);
    tag("G3963.", "high", 1000);
    tag("G3963.", "clear", 3000);
    tag("G3965.", "low", 1000);
    const sides = p.blockSides(eventId);
    expect(sides).toHaveLength(1);
    expect(sides[0]).toMatchObject({ key: "GARLAND|E CANFIELD ST|MACK AVE|odd", parcelCount: 3, high: 1, low: 1, clear: 1, workCount: 2, band: "light" });
    expect(p.workParcelsOnSides(eventId, [sides[0]!.key]).map((x) => [x.parcelId, x.grade]).sort()).toEqual([
      ["G3961.", "high"],
      ["G3965.", "low"],
    ]);
  });

  test("another event's tags do not count", () => {
    p.upsertParcels([garland(3961)]);
    const other = setup.createEvent({ name: "Other", year: 2025, startDate: "2025-09-28", dayCount: 1 }).id;
    db.insert(s.surveyTags).values({ eventId: other, parcelId: "G3961.", grade: "high", side: "tap", at: 1 }).run();
    expect(p.blockSides(eventId)).toEqual([]);
  });

  test("a refreshed parcel keeps one row and recomputes its key", () => {
    p.upsertParcels([garland(3961)]);
    p.upsertParcels([garland(3961, { crossStreet1: null, crossStreet2: null })]);
    const rows = db.select().from(s.parcels).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.blockSideKey).toBe("GARLAND|3900|odd");
  });

  test("featureToParcel reads the layer's fields", () => {
    const row = p.featureToParcel({
      geometry: square(42.38, -82.99),
      properties: {
        parcel_id: "21038203.",
        address: "3965 GARLAND",
        street_name: "GARLAND",
        street_number: 3965,
        street_prefix: "",
        cross_street_1: "E Canfield St",
        cross_street_2: "Mack Ave",
        is_improved: 0,
        pct_pre_claimed: 0,
        sale_date: "2019-08-09",
      },
    });
    expect(row).toMatchObject({ parcelId: "21038203.", address: "3965 Garland", streetNumber: 3965, streetPrefix: null, isImproved: false, saleDate: "2019-08-09" });
  });
});
