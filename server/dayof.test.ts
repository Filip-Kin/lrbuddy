import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AreaPolygon, LotGeometry } from "./db/schema.ts";

// The db opens $DATA_DIR at import, so the env is set first and every app module is imported dynamically.
const dir = mkdtempSync(join(tmpdir(), "lrbuddy-dayof-test-"));
process.env.DATA_DIR ??= dir;
process.env.SESSION_SECRET ??= "test-secret";
process.env.ADMIN_PASSWORD ??= "test-admin";
process.env.OSRM_URL = "off";
process.env.VAPID_PUBLIC_KEY = "";
process.env.VAPID_PRIVATE_KEY = "";

const { db } = await import("./db/index.ts");
const s = await import("./db/schema.ts");
const setup = await import("./setup.ts");
const { bus } = await import("./bus.ts");
const { upsertParcels } = await import("./parcels.ts");
const { greenRouter } = await import("./routers/green.ts");
const { DO_NOT_TOUCH } = await import("./dayof.ts");
const { eq } = await import("drizzle-orm");

type Session = typeof s.sessions.$inferSelect;
type Lot = typeof s.lots.$inferSelect;

afterAll(() => rmSync(dir, { recursive: true, force: true }));

// #region fixture
const session = (ccId: number): Session => ({
  id: crypto.randomUUID(),
  role: "green",
  userId: null,
  membershipId: null,
  crewId: null,
  truckId: null,
  ccId,
  displayName: "Test green",
  createdAt: Date.now(),
  lastUsedAt: Date.now(),
  userAgent: null,
});
const greenOf = (ccId: number) => greenRouter.createCaller({ session: session(ccId), ip: "127.0.0.1", ccOverride: null });

const square = (lat: number, lng: number): LotGeometry => ({
  type: "Polygon",
  coordinates: [[[lng - 0.0001, lat - 0.0001], [lng + 0.0001, lat - 0.0001], [lng + 0.0001, lat + 0.0001], [lng - 0.0001, lat + 0.0001], [lng - 0.0001, lat - 0.0001]]],
});

/**
 * Two streets at CC East: W Boston Blvd (two sides) in a shared area of GM 1
 * and GM 2, Rochester St (one side) in GM 3's own area. DTE has two crews at
 * East and nothing assigned; GM 4 is at West.
 */
const world = () => {
  db.delete(s.events).run();
  db.delete(s.parcels).run();
  const ev = setup.createEvent({ name: "Day of test", year: 2026, startDate: "2026-10-01", dayCount: 1, active: true });
  const day = db.select().from(s.days).where(eq(s.days.eventId, ev.id)).get()!;
  const east = setup.createCc({ dayId: day.id, name: "East", lat: 42.38, lng: -83.12 });
  const west = setup.createCc({ dayId: day.id, name: "West", lat: 42.37, lng: -83.0 });
  const gm = db.insert(s.companies).values({ eventId: ev.id, name: "General Motors", short: "GM" }).returning().get();
  const dte = db.insert(s.companies).values({ eventId: ev.id, name: "DTE", short: "DTE" }).returning().get();
  const crew = (ccId: number, companyId: number) => setup.createCrew({ dayId: day.id, ccId, companyId });
  const gm1 = crew(east.id, gm.id);
  const gm2 = crew(east.id, gm.id);
  const gm3 = crew(east.id, gm.id);
  const dte1 = crew(east.id, dte.id);
  const dte2 = crew(east.id, dte.id);
  const gm4 = crew(west.id, gm.id);

  const sides: Array<{ street: string; prefix: string | null; suffix: string; parity: 0 | 1; lat: number }> = [
    { street: "BOSTON", prefix: "W", suffix: "BLVD", parity: 1, lat: 42.3801 },
    { street: "BOSTON", prefix: "W", suffix: "BLVD", parity: 0, lat: 42.3799 },
    { street: "ROCHESTER", prefix: null, suffix: "ST", parity: 1, lat: 42.379 },
  ];
  const parcelRows = sides.flatMap((sd, i) =>
    Array.from({ length: 4 }, (_v, k) => {
      const n = 3000 + k * 20 + sd.parity;
      const lng = -83.121 + k * 0.0004;
      return {
        parcelId: `p${i}-${k}.`,
        address: `${n} ${sd.prefix ? `${sd.prefix} ` : ""}${sd.street} ${sd.suffix}`,
        lat: sd.lat,
        lng,
        geometry: square(sd.lat, lng),
        streetName: sd.street,
        streetNumber: n,
        streetPrefix: sd.prefix,
        crossStreet1: "Dexter Ave",
        crossStreet2: "Wildemere St",
        propertyClass: "402",
        propertyClassDescription: "RESIDENTIAL-VACANT",
        taxpayer1: null,
        isImproved: false,
        pctPreClaimed: 0,
        saleDate: null,
      };
    }),
  );
  upsertParcels(parcelRows);
  const keyOf = (i: number) => db.select().from(s.parcels).where(eq(s.parcels.parcelId, `p${i}-0.`)).get()!.blockSideKey!;
  const [bostonOdd, bostonEven, rochester] = [keyOf(0), keyOf(1), keyOf(2)];

  const ring = (lat: number): AreaPolygon => ({ type: "Polygon", coordinates: [[[-83.122, lat - 0.0005], [-83.119, lat - 0.0005], [-83.119, lat + 0.0005], [-83.122, lat + 0.0005], [-83.122, lat - 0.0005]]] });
  const shared = db.insert(s.crewAreas).values({ eventId: ev.id, dayId: day.id, polygon: ring(42.38) }).returning().get();
  const own = db.insert(s.crewAreas).values({ eventId: ev.id, dayId: day.id, polygon: ring(42.379) }).returning().get();
  db.update(s.crews).set({ areaId: shared.id }).where(eq(s.crews.id, gm1.id)).run();
  db.update(s.crews).set({ areaId: shared.id }).where(eq(s.crews.id, gm2.id)).run();
  db.update(s.crews).set({ areaId: own.id }).where(eq(s.crews.id, gm3.id)).run();
  let order = 1;
  for (const key of [bostonOdd, bostonEven]) {
    db.insert(s.assignments).values({ eventId: ev.id, dayId: day.id, ccId: east.id, companyId: gm.id, crewId: null, areaId: shared.id, blockSideKey: key, order: order++ }).run();
  }
  db.insert(s.assignments).values({ eventId: ev.id, dayId: day.id, ccId: east.id, companyId: gm.id, crewId: gm3.id, blockSideKey: rochester, order: order++ }).run();

  // Lots: Boston odd to GM 1, Boston even to GM 2, Rochester to GM 3. Each side: open, open, in progress, done.
  const statuses: Lot["status"][] = ["open", "open", "in_progress", "done"];
  const owner = [gm1.id, gm2.id, gm3.id];
  for (const p of parcelRows) {
    const i = Number(p.parcelId.slice(1, 2));
    const k = Number(p.parcelId.slice(3, 4));
    db.insert(s.lots)
      .values({ eventId: ev.id, parcelId: p.parcelId, address: p.address, lat: p.lat, lng: p.lng, geometry: p.geometry, source: "survey", ccId: east.id, crewId: owner[i]!, status: statuses[k]! })
      .run();
  }
  return { ev, day, east, west, gm, dte, gm1, gm2, gm3, dte1, dte2, gm4, shared, own, bostonOdd, bostonEven, rochester, green: greenOf(east.id) };
};

const lotsOn = (key: string): Lot[] => {
  const ids = db.select().from(s.parcels).where(eq(s.parcels.blockSideKey, key)).all().map((p) => p.parcelId);
  return db.select().from(s.lots).all().filter((l) => l.parcelId !== null && ids.includes(l.parcelId));
};

const listen = () => {
  const got: number[] = [];
  const off = bus.subscribe((m) => {
    if (m.type === "lot.changed") got.push(m.payload.lot.id);
  });
  return { got, off };
};
// #endregion

describe("green day of", () => {
  let w: ReturnType<typeof world>;
  beforeEach(() => {
    w = world();
  });

  test("the plan lists the CC's rectangles with streets, block sides and counts", async () => {
    const p = await w.green.plan();
    const shared = p.areas.find((a) => a.id === w.shared.id)!;
    expect(shared.label).toBe("GM 1 & GM 2");
    expect(shared.streets).toBe("W Boston Blvd");
    expect(shared.counts).toEqual({ open: 4, inProgress: 2, done: 2, skipped: 0 });
    expect(shared.doNotTouch).toBe(false);
    expect(p.sides.map((x) => x.key).sort()).toEqual([w.bostonEven, w.bostonOdd, w.rochester].sort());
    expect(p.sides.find((x) => x.key === w.rochester)!.areaId).toBe(w.own.id);
    expect(p.companies.map((c) => c.name)).toEqual(["DTE", "General Motors"]);
    expect(p.companies[1]!.crews.map((c) => c.name)).toEqual(["GM 1", "GM 2", "GM 3"]);
  });

  test("Done marks every unfinished lot of the rectangle done and leaves the others", async () => {
    const { got, off } = listen();
    const r = await w.green.markArea({ areaId: w.shared.id, action: "done" });
    off();
    expect(r.changed).toBe(6);
    expect([...lotsOn(w.bostonOdd), ...lotsOn(w.bostonEven)].every((l) => l.status === "done")).toBe(true);
    expect(lotsOn(w.rochester).map((l) => l.status).sort()).toEqual(["done", "in_progress", "open", "open"]);
    expect(got.length).toBe(6);
    // A second Done has nothing left to change and still tells open screens.
    const again = listen();
    expect((await w.green.markArea({ areaId: w.shared.id, action: "done" })).changed).toBe(0);
    again.off();
    expect(again.got.length).toBe(1);
  });

  test("Do not touch skips the unfinished lots with the note and flags the rectangle", async () => {
    const r = await w.green.markArea({ areaId: w.own.id, action: "doNotTouch" });
    expect(r.changed).toBe(3);
    const rows = lotsOn(w.rochester);
    expect(rows.filter((l) => l.status === "skipped").every((l) => l.note === DO_NOT_TOUCH)).toBe(true);
    expect(rows.find((l) => l.status === "done")!.note).toBeNull();
    expect(db.select().from(s.crewAreas).where(eq(s.crewAreas.id, w.own.id)).get()!.doNotTouch).toBe(true);
    expect((await w.green.plan()).areas.find((a) => a.id === w.own.id)!.doNotTouch).toBe(true);
    expect(db.select().from(s.crewAreas).where(eq(s.crewAreas.id, w.shared.id)).get()!.doNotTouch).toBeNull();
  });

  test("a block side's Done and Do not touch touch only that side", async () => {
    expect((await w.green.markSide({ key: w.bostonOdd, action: "done" })).changed).toBe(3);
    expect(lotsOn(w.bostonOdd).every((l) => l.status === "done")).toBe(true);
    expect(lotsOn(w.bostonEven).filter((l) => l.status !== "done").length).toBe(3);
    expect((await w.green.markSide({ key: w.bostonEven, action: "doNotTouch" })).changed).toBe(3);
    expect(lotsOn(w.bostonEven).filter((l) => l.status === "skipped").length).toBe(3);
    // A side's Do not touch does not flag the whole rectangle.
    expect(db.select().from(s.crewAreas).where(eq(s.crewAreas.id, w.shared.id)).get()!.doNotTouch).toBeNull();
  });

  test("Reassign to one crew moves the area, its block sides and its unfinished lots", async () => {
    const { got, off } = listen();
    const r = await w.green.reassignArea({ areaId: w.shared.id, companyId: w.dte.id, crewIds: [w.dte1.id] });
    off();
    expect(r).toEqual({ moved: 6, label: "DTE 1" });
    expect(got.length).toBe(6);
    const crew = (id: number) => db.select().from(s.crews).where(eq(s.crews.id, id)).get()!;
    expect(crew(w.dte1.id).areaId).toBe(w.shared.id);
    expect(crew(w.gm1.id).areaId).toBeNull();
    expect(crew(w.gm2.id).areaId).toBeNull();
    for (const key of [w.bostonOdd, w.bostonEven]) {
      const a = db.select().from(s.assignments).where(eq(s.assignments.blockSideKey, key)).get()!;
      expect(a).toMatchObject({ companyId: w.dte.id, crewId: w.dte1.id, areaId: null });
    }
    const lots = [...lotsOn(w.bostonOdd), ...lotsOn(w.bostonEven)];
    expect(lots.filter((l) => l.status !== "done").every((l) => l.crewId === w.dte1.id)).toBe(true);
    // Done lots keep the crew that did them.
    expect(lots.filter((l) => l.status === "done").map((l) => l.crewId).sort()).toEqual([w.gm1.id, w.gm2.id].sort());
    // The rectangle keeps its outline and now reads as DTE's.
    const p = await w.green.plan();
    expect(p.areas.find((a) => a.id === w.shared.id)).toMatchObject({ label: "DTE 1", companyName: "DTE" });
    // Rochester is untouched.
    expect(lotsOn(w.rochester).every((l) => l.crewId === w.gm3.id)).toBe(true);
  });

  test("Reassign to several crews shares the area and splits the lots by block side", async () => {
    await w.green.reassignArea({ areaId: w.own.id, companyId: w.dte.id, crewIds: [w.dte1.id, w.dte2.id] });
    const a = db.select().from(s.assignments).where(eq(s.assignments.blockSideKey, w.rochester)).get()!;
    expect(a).toMatchObject({ companyId: w.dte.id, crewId: null, areaId: w.own.id });
    expect(db.select().from(s.crews).where(eq(s.crews.id, w.dte2.id)).get()!.areaId).toBe(w.own.id);
    expect(db.select().from(s.crews).where(eq(s.crews.id, w.gm3.id)).get()!.areaId).toBeNull();
    // One side: all its unfinished lots go to one of the two, whole side only.
    const owners = new Set(lotsOn(w.rochester).filter((l) => l.status !== "done").map((l) => l.crewId));
    expect(owners.size).toBe(1);
    expect([w.dte1.id, w.dte2.id]).toContain([...owners][0]!);
    expect((await w.green.plan()).areas.find((x) => x.id === w.own.id)!.label).toBe("DTE 1 & DTE 2");
  });

  test("a crew taking a rectangle leaves its old one, which goes when nobody holds it", async () => {
    await w.green.reassignArea({ areaId: w.shared.id, companyId: w.gm.id, crewIds: [w.gm3.id] });
    expect(db.select().from(s.crews).where(eq(s.crews.id, w.gm3.id)).get()!.areaId).toBe(w.shared.id);
    expect(db.select().from(s.crewAreas).where(eq(s.crewAreas.id, w.own.id)).get()).toBeUndefined();
  });

  test("Reassign refuses crews of another CC or company, the same crews, and areas of another CC", async () => {
    await expect(w.green.reassignArea({ areaId: w.shared.id, companyId: w.gm.id, crewIds: [w.gm4.id] })).rejects.toThrow("Crew not at this command center");
    await expect(w.green.reassignArea({ areaId: w.shared.id, companyId: w.dte.id, crewIds: [w.gm3.id] })).rejects.toThrow("Crew is in another company");
    await expect(w.green.reassignArea({ areaId: w.shared.id, companyId: w.gm.id, crewIds: [w.gm2.id, w.gm1.id] })).rejects.toThrow("Already with these crews");
    await expect(w.green.reassignArea({ areaId: w.shared.id, companyId: w.dte.id, crewIds: [] })).rejects.toThrow();
    const west = greenOf(w.west.id);
    await expect(west.reassignArea({ areaId: w.shared.id, companyId: w.gm.id, crewIds: [w.gm4.id] })).rejects.toThrow("Area not at this command center");
    await expect(west.markArea({ areaId: w.shared.id, action: "done" })).rejects.toThrow("Area not at this command center");
    await expect(west.markSide({ key: w.rochester, action: "done" })).rejects.toThrow("Block side not at this command center");
    expect(lotsOn(w.rochester).filter((l) => l.status === "open").length).toBe(2);
  });
});
