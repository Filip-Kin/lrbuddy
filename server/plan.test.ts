import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LotGeometry } from "./db/schema.ts";
import type { ParcelInput } from "./parcels.ts";

// The db module opens $DATA_DIR at import; set the env before anything loads it.
const dir = mkdtempSync(join(tmpdir(), "lrbuddy-plan-test-"));
process.env.DATA_DIR = dir;
process.env.SESSION_SECRET = "test-secret";
process.env.ADMIN_PASSWORD = "test-admin";
process.env.OSRM_URL = "off";
process.env.VAPID_PUBLIC_KEY = "";
process.env.VAPID_PRIVATE_KEY = "";

const { db } = await import("./db/index.ts");
const s = await import("./db/schema.ts");
const setup = await import("./setup.ts");
const d = await import("./dispatch.ts");
const p = await import("./parcels.ts");
const { createSession } = await import("./auth.ts");
const { planRouter } = await import("./routers/plan.ts");
const { eq } = await import("drizzle-orm");
const { config } = await import("./config.ts");

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

const callerFor = (role: "admin" | "green") => planRouter.createCaller({ session: createSession({ role, displayName: "Kelsey" }), ip: "test", ccOverride: null });

let eventId = 0;
let dayId = 0;
let ccId = 0;
let ford = 0;
let admin: ReturnType<typeof callerFor>;
const ODD = "GARLAND|E CANFIELD ST|MACK AVE|odd";
const EVEN = "GARLAND|E CANFIELD ST|MACK AVE|even";

beforeEach(() => {
  d.cancelScheduledRoutes();
  db.delete(s.events).run();
  db.delete(s.parcels).run();
  const ev = setup.createEvent({ name: "Test", year: 2026, startDate: "2026-09-28", dayCount: 1, active: true });
  eventId = ev.id;
  dayId = db.select().from(s.days).where(eq(s.days.eventId, ev.id)).get()!.id;
  ccId = setup.createCc({ dayId, name: "East", lat: 42.3786, lng: -82.9911 }).id;
  ford = db.insert(s.companies).values({ eventId, name: "Ford" }).returning().get().id;
  p.upsertParcels([
    parcel("Garland", 3961, 42.3801, -82.99),
    parcel("Garland", 3963, 42.3803, -82.99),
    parcel("Garland", 3965, 42.3805, -82.99),
    parcel("Garland", 3964, 42.3802, -82.9897),
  ]);
  admin = callerFor("admin");
});
// #endregion

describe("plan access", () => {
  test("a green session is refused", async () => {
    await expect(callerFor("green").blocks.list()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("survey", () => {
  test("the newest tag wins, clear removes the parcel from the work list, undo restores the one before", async () => {
    await admin.survey.tag({ parcelId: "Garland-3961.", grade: "low", side: "left", at: 1000 });
    await admin.survey.tag({ parcelId: "Garland-3961.", grade: "high", side: "left", at: 2000 });
    const clear = await admin.survey.tag({ parcelId: "Garland-3963.", grade: "clear", at: 3000 });
    let list = await admin.survey.list();
    expect(list.map((r) => [r.parcelId, r.grade, r.by])).toEqual([
      ["Garland-3963.", "clear", "Kelsey"],
      ["Garland-3961.", "high", "Kelsey"],
    ]);
    let sides = await admin.blocks.list();
    expect(sides[0]).toMatchObject({ key: ODD, high: 1, clear: 1, workCount: 1, assignment: null });
    await admin.survey.undo({ id: clear.tag.id });
    list = await admin.survey.list();
    expect(list).toHaveLength(1);
    sides = await admin.blocks.list();
    expect(sides[0]).toMatchObject({ clear: 0, workCount: 1 });
  });

  test("a parcel not in the cache is refused", async () => {
    await expect(admin.survey.tag({ parcelId: "nope.", grade: "low" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  test("near lists cached parcels within the radius, nearest first, with grade", async () => {
    await admin.survey.tag({ parcelId: "Garland-3963.", grade: "high" });
    const near = await admin.survey.near({ lat: 42.3803, lng: -82.99, radiusM: 15 });
    expect(near[0]).toMatchObject({ parcelId: "Garland-3963.", grade: "high", distanceM: 0 });
    expect(near.map((r) => r.parcelId)).not.toContain("Garland-3965.");
  });
});

describe("assignments and publish", () => {
  const tagAll = async (): Promise<void> => {
    await admin.survey.tag({ parcelId: "Garland-3961.", grade: "high" });
    await admin.survey.tag({ parcelId: "Garland-3963.", grade: "low" });
    await admin.survey.tag({ parcelId: "Garland-3965.", grade: "clear" });
    await admin.survey.tag({ parcelId: "Garland-3964.", grade: "low" });
  };

  test("build crews makes one crew per 10 named by company, once", async () => {
    await admin.assignments.setHeadcount({ companyId: ford, dayId, ccId, headcount: 25 });
    const built = await admin.assignments.buildCrews({ dayId, ccId, companyId: ford });
    expect(built.map((c) => [c.name, c.headcount])).toEqual([
      ["Ford 1", 9],
      ["Ford 2", 8],
      ["Ford 3", 8],
    ]);
    await expect(admin.assignments.buildCrews({ dayId, ccId, companyId: ford })).rejects.toMatchObject({ code: "CONFLICT" });
    const companies = await admin.assignments.companies({ dayId });
    expect(companies[0]).toMatchObject({ name: "Ford", headcount: 25, crewCapacity: 3 });
    expect(companies[0]!.crews).toHaveLength(3);
  });

  test("publish writes survey lots, never duplicates, leaves done lots alone and sets the crew area", async () => {
    await tagAll();
    const crew = setup.createCrew({ dayId, ccId, companyId: ford, headcount: 10 });
    await admin.assignments.set({ dayId, ccId, crewId: crew.id, keys: [ODD, EVEN] });
    const first = await admin.assignments.publish();
    expect(first).toMatchObject({ added: 3, updated: 0, kept: 0, areas: 1 });
    const lotsAfter = db.select().from(s.lots).where(eq(s.lots.eventId, eventId)).all();
    expect(lotsAfter.map((l) => l.parcelId).sort()).toEqual(["Garland-3961.", "Garland-3963.", "Garland-3964."]);
    expect(lotsAfter.every((l) => l.source === "survey" && l.crewId === crew.id && l.ccId === ccId && l.status === "open")).toBe(true);

    const done = lotsAfter.find((l) => l.parcelId === "Garland-3961.")!;
    db.update(s.lots).set({ status: "done", crewId: null }).where(eq(s.lots.id, done.id)).run();
    const area = db.select().from(s.crews).where(eq(s.crews.id, crew.id)).get()!.area!;
    expect(area.coordinates[0]).toHaveLength(5);

    const second = await admin.assignments.publish();
    expect(second).toMatchObject({ added: 0, updated: 2, kept: 1, areas: 0 });
    expect(db.select().from(s.lots).where(eq(s.lots.eventId, eventId)).all()).toHaveLength(3);
    const stillDone = db.select().from(s.lots).where(eq(s.lots.id, done.id)).get()!;
    expect(stillDone).toMatchObject({ status: "done", crewId: null });
  });

  test("review: a parcel tagged clear after a publish leaves the crew's work list on the next publish", async () => {
    await tagAll();
    const crew = setup.createCrew({ dayId, ccId, companyId: ford, headcount: 10 });
    await admin.assignments.set({ dayId, ccId, crewId: crew.id, keys: [ODD, EVEN] });
    await admin.assignments.publish();
    await admin.survey.tag({ parcelId: "Garland-3963.", grade: "clear" });
    await admin.assignments.publish();
    const lot = db.select().from(s.lots).where(eq(s.lots.parcelId, "Garland-3963.")).get();
    // Clear takes the parcel off the work list (SPEC 16); an open lot on the crew still sends them there.
    expect(lot === undefined || lot.status !== "open" || lot.crewId !== crew.id).toBe(true);
  });

  test("a cleared parcel's lot with photos is kept, off the crew and skipped", async () => {
    await tagAll();
    const crew = setup.createCrew({ dayId, ccId, companyId: ford, headcount: 10 });
    await admin.assignments.set({ dayId, ccId, crewId: crew.id, keys: [ODD, EVEN] });
    await admin.assignments.publish();
    const lot = db.select().from(s.lots).where(eq(s.lots.parcelId, "Garland-3963.")).get()!;
    db.insert(s.lotPhotos).values({ lotId: lot.id, kind: "before", role: "admin", at: Date.now(), width: 10, height: 10, bytes: 100 }).run();
    await admin.survey.tag({ parcelId: "Garland-3963.", grade: "clear" });
    expect(await admin.assignments.publish()).toMatchObject({ removed: 1 });
    expect(db.select().from(s.lots).where(eq(s.lots.id, lot.id)).get()).toMatchObject({ status: "skipped", crewId: null });
    expect(await admin.assignments.publish()).toMatchObject({ removed: 0 });
  });

  test("assigning a side again moves it; clear removes it", async () => {
    await tagAll();
    await admin.assignments.set({ dayId, ccId, companyId: ford, keys: [ODD] });
    const crew = setup.createCrew({ dayId, ccId, companyId: ford });
    await admin.assignments.set({ dayId, ccId, crewId: crew.id, keys: [ODD] });
    const list = await admin.assignments.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.assignment).toMatchObject({ companyName: "Ford", crewId: crew.id, crewName: "Ford 1" });
    await admin.assignments.clear({ keys: [ODD] });
    expect(await admin.assignments.list()).toHaveLength(0);
  });

  test("an unknown block side is refused", async () => {
    await expect(admin.assignments.set({ dayId, ccId, companyId: ford, keys: ["NOWHERE|odd"] })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  test("totals and print sheets", async () => {
    await tagAll();
    const crew = setup.createCrew({ dayId, ccId, companyId: ford });
    await admin.assignments.set({ dayId, ccId, crewId: crew.id, keys: [ODD, EVEN] });
    await admin.assignments.publish();
    const totals = await admin.blocks.totals();
    expect(totals).toMatchObject({ workParcels: 3, high: 1, low: 2, sides: 2, assignedSides: 2, crewsNeeded: 1 });
    const sheets = await admin.print.sheets({ dayId });
    expect(sheets.crewPages).toHaveLength(1);
    const page = sheets.crewPages[0]!;
    expect(page).toMatchObject({ teamName: "Ford 1", ccName: "East", code: crew.token, url: `${config.publicUrl}/j/${crew.token}`, loginUrl: `${config.publicUrl}/login` });
    expect(page.qrSvg).toStartWith("<svg");
    expect(page.lots.every((l) => l.parcelId !== null)).toBe(true);
    expect(page.area).not.toBeNull();
    expect(page.lots.map((l) => l.grade).sort()).toEqual(["high", "low", "low"]);
    expect(sheets.ccPages[0]!.workLots).toHaveLength(3);
    expect(sheets.ccPages[0]!.areas).toHaveLength(1);
  });

  test("setArea stores and clears the printed rectangle", async () => {
    const crew = setup.createCrew({ dayId, ccId, companyId: ford });
    const ring = [[-82.99, 42.38], [-82.98, 42.38], [-82.98, 42.39], [-82.99, 42.39], [-82.99, 42.38]] as Array<[number, number]>;
    await admin.crews.setArea({ crewId: crew.id, area: { type: "Polygon", coordinates: [ring] } });
    expect(db.select().from(s.crews).where(eq(s.crews.id, crew.id)).get()!.area).toEqual({ type: "Polygon", coordinates: [ring] });
    await admin.crews.setArea({ crewId: crew.id, area: null });
    expect(db.select().from(s.crews).where(eq(s.crews.id, crew.id)).get()!.area).toBeNull();
  });
});
