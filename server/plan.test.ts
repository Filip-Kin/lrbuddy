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
const { splitSides, joinNames } = await import("./routers/plan/areas.ts");
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

  test("Load parcels with the assessor layer down reads as the Survey notice", async () => {
    const real = globalThis.fetch;
    globalThis.fetch = Object.assign(async () => { throw new TypeError("fetch failed"); }, { preconnect: real.preconnect });
    try {
      await expect(admin.parcels.loadBbox({ bbox: [-82.991, 42.38, -82.99, 42.381] })).rejects.toMatchObject({
        code: "BAD_GATEWAY",
        message: "Parcels not loaded. Try again.",
      });
    } finally {
      globalThis.fetch = real;
    }
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
    await admin.assignments.set({ dayId, ccId, crewIds: [crew.id], keys: [ODD, EVEN] });
    const first = await admin.assignments.publish();
    expect(first).toMatchObject({ added: 3, updated: 0, kept: 0, areas: 1 });
    const lotsAfter = db.select().from(s.lots).where(eq(s.lots.eventId, eventId)).all();
    expect(lotsAfter.map((l) => l.parcelId).sort()).toEqual(["Garland-3961.", "Garland-3963.", "Garland-3964."]);
    expect(lotsAfter.every((l) => l.source === "survey" && l.crewId === crew.id && l.ccId === ccId && l.status === "open")).toBe(true);

    const done = lotsAfter.find((l) => l.parcelId === "Garland-3961.")!;
    db.update(s.lots).set({ status: "done", crewId: null }).where(eq(s.lots.id, done.id)).run();
    const areaId = db.select().from(s.crews).where(eq(s.crews.id, crew.id)).get()!.areaId!;
    const area = db.select().from(s.crewAreas).where(eq(s.crewAreas.id, areaId)).get()!.polygon!;
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
    await admin.assignments.set({ dayId, ccId, crewIds: [crew.id], keys: [ODD, EVEN] });
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
    await admin.assignments.set({ dayId, ccId, crewIds: [crew.id], keys: [ODD, EVEN] });
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
    await admin.assignments.set({ dayId, ccId, crewIds: [crew.id], keys: [ODD] });
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
    await admin.assignments.set({ dayId, ccId, crewIds: [crew.id], keys: [ODD, EVEN] });
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
    const areaId = db.select().from(s.crews).where(eq(s.crews.id, crew.id)).get()!.areaId!;
    expect(db.select().from(s.crewAreas).where(eq(s.crewAreas.id, areaId)).get()!.polygon).toEqual({ type: "Polygon", coordinates: [ring] });
    await admin.crews.setArea({ crewId: crew.id, area: null });
    expect(db.select().from(s.crews).where(eq(s.crews.id, crew.id)).get()!.areaId).toBeNull();
    // Nobody holds the area any more, so it goes.
    expect(db.select().from(s.crewAreas).where(eq(s.crewAreas.id, areaId)).get()).toBeUndefined();
  });

  test("crews are named from the company's short, else the first word of its name", async () => {
    const gm = db.insert(s.companies).values({ eventId, name: "General Motors", short: "GM" }).returning().get().id;
    const hfh = db.insert(s.companies).values({ eventId, name: "Henry Ford Health" }).returning().get().id;
    await admin.assignments.setHeadcount({ companyId: gm, dayId, ccId, headcount: 20 });
    await admin.assignments.setHeadcount({ companyId: hfh, dayId, ccId, headcount: 10 });
    expect((await admin.assignments.buildCrews({ dayId, ccId, companyId: gm })).map((c) => c.name)).toEqual(["GM 1", "GM 2"]);
    expect((await admin.assignments.buildCrews({ dayId, ccId, companyId: hfh })).map((c) => c.name)).toEqual(["Henry 1"]);
  });

  test("a shared area: one area for both crews, labelled with both, and publish splits its sides between them", async () => {
    await tagAll();
    const a = setup.createCrew({ dayId, ccId, companyId: ford, headcount: 9 });
    const b = setup.createCrew({ dayId, ccId, companyId: ford, headcount: 8 });
    const r = await admin.assignments.set({ dayId, ccId, crewIds: [a.id, b.id], keys: [ODD, EVEN] });
    expect(r.areaId).not.toBeNull();
    const rows = db.select().from(s.crews).where(eq(s.crews.dayId, dayId)).all();
    expect(rows.map((c) => c.areaId)).toEqual([r.areaId, r.areaId]);
    const list = await admin.assignments.list();
    expect(list.map((x) => x.assignment?.crewName)).toEqual(["Ford 1 & Ford 2", "Ford 1 & Ford 2"]);

    const res = await admin.assignments.publish();
    expect(res).toMatchObject({ added: 3, areas: 1 });
    const lotsAfter = db.select().from(s.lots).where(eq(s.lots.eventId, eventId)).all();
    const byCrew = new Map<number | null, string[]>();
    for (const l of lotsAfter) byCrew.set(l.crewId, [...(byCrew.get(l.crewId) ?? []), l.parcelId ?? ""]);
    // Each crew gets one whole block side: the odd side (3961 high, 3963 low) and the even side (3964 low).
    expect([...byCrew.keys()].sort()).toEqual([a.id, b.id].sort());
    const sides = [...byCrew.values()].map((v) => v.sort().join(","));
    expect(sides.sort()).toEqual(["Garland-3961.,Garland-3963.", "Garland-3964."]);
    const area = db.select().from(s.crewAreas).where(eq(s.crewAreas.id, r.areaId!)).get()!;
    expect(area.polygon?.coordinates[0]).toHaveLength(5);

    // Assigning the same two again reuses their area instead of making another.
    const again = await admin.assignments.set({ dayId, ccId, crewIds: [b.id, a.id], keys: [ODD] });
    expect(again.areaId).toBe(r.areaId);
    expect(db.select().from(s.crewAreas).all()).toHaveLength(1);
  });

  test("print: a company with a shared area gets a company sheet with headcounts and the joined label", async () => {
    await tagAll();
    db.update(s.commandCenters).set({ letter: "B", address: "3201 Webb St" }).where(eq(s.commandCenters.id, ccId)).run();
    db.update(s.companies).set({ short: "GM" }).where(eq(s.companies.id, ford)).run();
    const crews = [9, 8, 10].map((headcount) => setup.createCrew({ dayId, ccId, companyId: ford, headcount }));
    await admin.assignments.set({ dayId, ccId, crewIds: [crews[0]!.id], keys: [EVEN] });
    await admin.assignments.set({ dayId, ccId, crewIds: [crews[1]!.id, crews[2]!.id], keys: [ODD] });
    await admin.assignments.publish();
    const sheets = await admin.print.sheets({ dayId });
    expect(sheets.companyPages).toHaveLength(1);
    const page = sheets.companyPages[0]!;
    expect(page).toMatchObject({ ccId, companyName: "Ford", short: "GM", headcount: 27 });
    expect(page.crews.map((c) => [c.name, c.headcount])).toEqual([
      ["GM 1", 9],
      ["GM 2", 8],
      ["GM 3", 10],
    ]);
    expect(page.areaIds).toHaveLength(2);
    const cc = sheets.ccPages[0]!;
    expect(cc).toMatchObject({ letter: "B", address: "3201 Webb St" });
    expect(cc.areas.map((a) => a.name).sort()).toEqual(["GM 1", "GM 2 & GM 3"]);
    expect(cc.areas.every((a) => page.areaIds.includes(a.areaId))).toBe(true);
    // The day's area: one padded ring per area, wider than the area it pads.
    expect(cc.dayArea).toHaveLength(2);
    const [w, , e] = cc.dayBounds;
    const areaLng = cc.areas.flatMap((a) => a.area.coordinates[0]!.map((p) => p[0]!));
    expect(w).toBeLessThan(Math.min(...areaLng));
    expect(e).toBeGreaterThan(Math.max(...areaLng));
    // Crew sheets name the shared rectangle the same way.
    const shared = sheets.crewPages.find((p) => p.crewId === crews[2]!.id)!;
    expect(shared).toMatchObject({ teamName: "GM 3", areaName: "GM 2 & GM 3", ccLetter: "B" });
    expect(shared.otherAreas.map((a) => a.name)).toEqual(["GM 1"]);
  });
});

describe("shared areas", () => {
  test("labels join with commas and an ampersand", () => {
    expect(joinNames(["GM 2"])).toBe("GM 2");
    expect(joinNames(["GM 9", "GM 10"])).toBe("GM 9 & GM 10");
    expect(joinNames(["GM 9", "GM 10", "GM 11"])).toBe("GM 9, GM 10 & GM 11");
  });

  test("splitSides gives each crew a run of neighbouring sides with about equal work", () => {
    // Six sides in a row running north-east, out of order, the middle two heavy.
    const sides = [3, 0, 5, 1, 4, 2].map((i) => ({ key: `s${i}`, center: { lat: 42.38 + i * 0.001, lng: -82.99 + i * 0.001 }, weight: i === 2 || i === 3 ? 6 : 2 }));
    const split = splitSides(sides, [11, 12, 13]);
    expect(["s0", "s1", "s2", "s3", "s4", "s5"].map((k) => split.get(k))).toEqual([11, 11, 12, 12, 13, 13]);
    // More crews than sides: every side still goes to someone, one each.
    const few = splitSides(sides.slice(0, 2), [1, 2, 3]);
    expect([...few.values()].sort()).toEqual([1, 2]);
  });
});


