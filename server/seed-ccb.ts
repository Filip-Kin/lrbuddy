/**
 * The real Thursday CC B of the 2026 project (SPEC 19, "THURSDAY GROUP MAPS - B")
 * on Day 4 of the demo event: the CC at 3201 Webb St, Rocket and General Motors
 * with their crews, the rectangles from the printed sheet, survey tags so the
 * rectangles hold work, and a publish so the lots exist.
 *
 * The day area runs from Dexter Ave (west) to Linwood St (east) and from Tuxedo
 * St (north) to Chicago Blvd (south). Wildemere St and Lawton St split it into
 * three columns. Every rectangle is the set of block sides on both sides of its
 * streets inside its columns, read from the parcel layer's cross streets.
 */
import { eq, max } from "drizzle-orm";
import { db } from "./db/index.ts";
import { assignments, companies, companyDays, crewAreas, crews, greenShirts, surveyTags, type Crew, type Day, type ParcelRow } from "./db/schema.ts";
import type { BBox, LatLng } from "./geo.ts";
import { cachedParcelsInBBox, loadParcelsBBox, gridAreaAround, mainAxis, outlinePoints } from "./parcels.ts";
import { createSharedArea } from "./routers/plan/areas.ts";
import { publishAssignments } from "./routers/plan/assignments.ts";
import { createCc, createCrew, createTruck } from "./setup.ts";

/** Dexter Ave to Linwood St, Chicago Blvd to Tuxedo St, with a margin. */
export const CCB_BBOX: BBox = [-83.126, 42.373, -83.11, 42.385];
/** 3201 Webb St, used when the parcel layer cannot be reached. */
const CC_FALLBACK: LatLng = { lat: 42.38052, lng: -83.12056 };
/** 2026-07-14 10:00 in Detroit (EDT, UTC-4), the same survey morning as Day 1. */
const SURVEY_START = Date.UTC(2026, 6, 14, 14, 0, 0);
const FRESH_MS = 7 * 24 * 3600_000;
/** Past the cross streets at each end of a rectangle. */
const PAD_M = 15;
/**
 * Behind the rear lot lines. Two streets' parcels meet back to back at the
 * alley, so 15 m here made neighbouring rectangles overlap by 30 m; 2 m keeps
 * them side by side the way the printed sheet draws them.
 */
const PAD_BACK_M = 2;

const LEADS = [
  "Maya Jordan", "Owen Price", "Tessa Hall", "Ravi Nair", "Gabe Silva",
  "Hannah Cole", "Isaac Bell", "Leah Ford", "Marco Reyes", "Nadia Khan",
  "Peter Lang", "Rosa Diaz", "Sean Burke", "Tara Webb", "Victor Ames",
  "Wendy Park", "Xavier Cruz", "Yara Haddad", "Zane Ortiz", "Abby Moss",
];

export type Column = "W" | "M" | "E";

/** The cross streets that bound each column, as the parcel layer spells their start. */
const COLUMN_CROSSES: Record<Column, [string, string]> = {
  W: ["DEXTER", "WILDEMERE"],
  M: ["WILDEMERE", "LAWTON"],
  E: ["LAWTON", "LINWOOD"],
};

/** East-west streets inside the area, north to south, as `street_name` holds them. */
export const CCB_STREETS = ["TUXEDO", "WEBB", "BURLINGAME", "LAWRENCE", "COLLINGWOOD", "CALVERT", "GLYNN", "BOSTON", "ROCHESTER"] as const;
type Street = (typeof CCB_STREETS)[number];

interface SheetArea {
  company: "ROCKET" | "GM";
  /** Crew numbers within the company ("GM 9" is 9). */
  crews: number[];
  streets: Street[];
  columns: Column[];
}

/** The rectangles on the printed sheet. Calvert W and Rochester M stay unassigned. */
export const CCB_AREAS: readonly SheetArea[] = [
  { company: "ROCKET", crews: [1, 2, 3, 4, 5], streets: ["TUXEDO", "WEBB"], columns: ["W", "M", "E"] },
  { company: "GM", crews: [1], streets: ["BURLINGAME", "LAWRENCE"], columns: ["E"] },
  { company: "GM", crews: [2], streets: ["LAWRENCE", "COLLINGWOOD"], columns: ["W"] },
  { company: "GM", crews: [3], streets: ["LAWRENCE", "COLLINGWOOD"], columns: ["M"] },
  { company: "GM", crews: [4], streets: ["COLLINGWOOD", "CALVERT"], columns: ["E"] },
  { company: "GM", crews: [5], streets: ["CALVERT"], columns: ["M"] },
  { company: "GM", crews: [6], streets: ["GLYNN"], columns: ["W"] },
  { company: "GM", crews: [7], streets: ["GLYNN"], columns: ["M"] },
  { company: "GM", crews: [8], streets: ["GLYNN"], columns: ["E"] },
  { company: "GM", crews: [9, 10, 11], streets: ["BOSTON", "ROCHESTER"], columns: ["W"] },
  { company: "GM", crews: [12, 13], streets: ["BOSTON"], columns: ["M"] },
  { company: "GM", crews: [14], streets: ["BOSTON"], columns: ["E"] },
  { company: "GM", crews: [15], streets: ["ROCHESTER"], columns: ["E"] },
];

/** The column a parcel's cross streets put it in, or null outside the three. */
export const columnOf = (p: Pick<ParcelRow, "crossStreet1" | "crossStreet2">): Column | null => {
  const crosses = [p.crossStreet1, p.crossStreet2].map((c) => (c ?? "").trim().toUpperCase());
  for (const col of ["W", "M", "E"] as const) {
    const [a, b] = COLUMN_CROSSES[col];
    if (crosses.some((c) => c.startsWith(a)) && crosses.some((c) => c.startsWith(b))) return col;
  }
  return null;
};

/** FNV-1a, so the survey grades are the same on every run and every machine. */
const hash = (s: string): number => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
};

/** About 10 % high, 40 % low, the rest clear. */
export const ccbGrade = (parcelId: string): "high" | "low" | "clear" => {
  const k = hash(parcelId) % 100;
  return k < 10 ? "high" : k < 50 ? "low" : "clear";
};

const cacheArea = async (): Promise<string> => {
  const have = cachedParcelsInBBox(CCB_BBOX, 20_000);
  const oldest = have.reduce((n, p) => Math.min(n, p.fetchedAt), Infinity);
  const webb = have.some((p) => p.address?.toUpperCase().startsWith("3201 WEBB"));
  if (have.length > 1000 && webb && Date.now() - oldest < FRESH_MS) return `${have.length} parcels cached`;
  const r = await loadParcelsBBox(CCB_BBOX, { timeoutMs: 30_000 });
  return `${r.fetched} parcels loaded`;
};

export interface SeedCcbResult {
  ccId: number;
  parcels: string;
  tags: number;
  sides: number;
  areas: number;
  lots: number;
  crews: Crew[];
}

export const seedCcB = async (input: { eventId: number; day: Day; rocketId: number; gmId: number }): Promise<SeedCcbResult> => {
  const { eventId, day } = input;
  let note: string;
  try {
    note = await cacheArea();
  } catch (err) {
    note = "parcel layer unavailable";
    console.warn("[seed] CC B parcels failed, CC B gets no rectangles:", err instanceof Error ? err.message : String(err));
  }
  const cached = cachedParcelsInBBox(CCB_BBOX, 20_000);

  // #region the CC, at the centre of the 3201 Webb parcel
  const home = cached.find((p) => p.address?.toUpperCase().startsWith("3201 WEBB")) ?? null;
  const at = home ? { lat: home.lat, lng: home.lng } : CC_FALLBACK;
  const cc = createCc({ dayId: day.id, name: "Webb", letter: "B", address: "3201 Webb St, Detroit", lat: at.lat, lng: at.lng });
  const shirts: Array<[string, string, string]> = [
    ["Kelsey Ward", "313-555-0401", "Site lead"],
    ["Andre Banks", "313-555-0402", "Supplies"],
    ["Nina Lopez", "313-555-0403", "Crews"],
  ];
  for (const [name, phone, roleLabel] of shirts) db.insert(greenShirts).values({ ccId: cc.id, name, phone, roleLabel }).run();
  // A live day (SPEC 20): no positions and no requests, so nothing on the map is a fake person.
  createTruck({ dayId: day.id, ccId: cc.id, name: "Truck B1", driverName: "Luis Romero", driverPhone: "313-555-0411" });
  createTruck({ dayId: day.id, ccId: cc.id, name: "Truck B2", driverName: "Erin Shaw", driverPhone: "313-555-0412" });
  // #endregion

  // #region companies and crews: ROCKET 1 to 5, then GM 1 to 15, 20 people each
  db.insert(companyDays).values({ companyId: input.rocketId, dayId: day.id, ccId: cc.id, headcount: 100 }).run();
  db.insert(companyDays).values({ companyId: input.gmId, dayId: day.id, ccId: cc.id, headcount: 300 }).run();
  const made: Crew[] = [];
  const crewOf = new Map<string, Crew>();
  const plan: Array<["ROCKET" | "GM", number, number]> = [
    ...Array.from({ length: 5 }, (_v, i): ["ROCKET", number, number] => ["ROCKET", input.rocketId, i + 1]),
    ...Array.from({ length: 15 }, (_v, i): ["GM", number, number] => ["GM", input.gmId, i + 1]),
  ];
  plan.forEach(([short, companyId, n], i) => {
    const crew = createCrew({
      dayId: day.id,
      ccId: cc.id,
      companyId,
      headcount: 20,
      leadName: LEADS[i] ?? null,
      leadPhone: `313-555-${String(1300 + i).padStart(4, "0")}`,
    });
    made.push(crew);
    crewOf.set(`${short} ${n}`, crew);
  });
  // #endregion

  if (cached.length === 0) return { ccId: cc.id, parcels: note, tags: 0, sides: 0, areas: 0, lots: 0, crews: made };

  // #region parcels of the area by street and column
  const inArea = cached.filter((p): p is ParcelRow & { blockSideKey: string } => {
    if (!p.blockSideKey || !CCB_STREETS.includes((p.streetName ?? "").toUpperCase() as Street)) return false;
    return columnOf(p) !== null;
  });
  const cellOf = (p: ParcelRow): string => `${(p.streetName ?? "").toUpperCase()}|${columnOf(p)}`;
  // Two directions for every rectangle: the streets, read off Webb St, and the avenues, read off the
  // middle column's run from Tuxedo St down to Rochester St (one centre per street).
  const along = mainAxis(inArea.filter((p) => p.streetName?.toUpperCase() === "WEBB"));
  const middle = CCB_STREETS.flatMap((st) => {
    const ps = inArea.filter((p) => cellOf(p) === `${st}|M`);
    return ps.length ? [{ lat: ps.reduce((n, p) => n + p.lat, 0) / ps.length, lng: ps.reduce((n, p) => n + p.lng, 0) / ps.length }] : [];
  });
  const across = mainAxis(middle);
  // #endregion

  // #region survey tags: every parcel on the area's block sides, by Kelsey on 2026-07-14
  const ordered = [...inArea].sort((a, b) => a.blockSideKey.localeCompare(b.blockSideKey) || (a.streetNumber ?? 0) - (b.streetNumber ?? 0));
  db.transaction((tx) => {
    ordered.forEach((p, i) => {
      tx.insert(surveyTags)
        .values({ eventId, parcelId: p.parcelId, grade: ccbGrade(p.parcelId), side: i % 2 === 0 ? "left" : "right", lat: p.lat, lng: p.lng, by: "Kelsey", at: SURVEY_START + i * 12_000 })
        .run();
    });
  });
  // #endregion

  // #region rectangles and assignments
  const top = db.select({ n: max(assignments.order) }).from(assignments).where(eq(assignments.eventId, eventId)).get();
  let order = (top?.n ?? 0) + 1;
  let sides = 0;
  let areaCount = 0;
  db.transaction((tx) => {
    for (const a of CCB_AREAS) {
      const cells = new Set(a.streets.flatMap((s) => a.columns.map((c) => `${s}|${c}`)));
      const mine = inArea.filter((p) => cells.has(cellOf(p)));
      const keys = [...new Set(mine.map((p) => p.blockSideKey))].sort();
      const polygon = gridAreaAround(mine.flatMap((p) => outlinePoints(p.geometry)), along, across, PAD_M, PAD_BACK_M);
      const crewIds = a.crews.map((n) => crewOf.get(`${a.company} ${n}`)!.id);
      const companyId = a.company === "GM" ? input.gmId : input.rocketId;
      let areaId: number | null = null;
      if (crewIds.length > 1) {
        areaId = createSharedArea(tx, { eventId, dayId: day.id, crewIds, polygon }).id;
      } else {
        const row = tx.insert(crewAreas).values({ eventId, dayId: day.id, polygon }).returning().get();
        tx.update(crews).set({ areaId: row.id }).where(eq(crews.id, crewIds[0]!)).run();
      }
      areaCount++;
      for (const key of keys) {
        tx.insert(assignments)
          .values({ eventId, dayId: day.id, ccId: cc.id, companyId, crewId: crewIds.length === 1 ? crewIds[0]! : null, areaId, blockSideKey: key, order: order++ })
          .run();
        sides++;
      }
    }
  });
  // #endregion

  // Polygons are already set, so Publish keeps them (no reset).
  const published = publishAssignments(eventId, { dayId: day.id });


  return { ccId: cc.id, parcels: note, tags: ordered.length, sides, areas: areaCount, lots: published.added + published.updated, crews: made };
};

/** The ids the seed needs for CC B: Rocket and General Motors in the event. */
export const ccbCompanies = (eventId: number): { rocketId: number; gmId: number } => {
  const rows = db.select().from(companies).where(eq(companies.eventId, eventId)).all();
  const rocket = rows.find((c) => c.short === "ROCKET");
  const gm = rows.find((c) => c.short === "GM");
  if (!rocket || !gm) throw new Error("Seed needs Rocket and General Motors");
  return { rocketId: rocket.id, gmId: gm.id };
};
