import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LotGeometry } from "./db/schema.ts";

// The db opens $DATA_DIR at import, so the env is set first and every app module is imported dynamically.
const dir = mkdtempSync(join(tmpdir(), "lrbuddy-paint-test-"));
process.env.DATA_DIR ??= dir;
process.env.SESSION_SECRET ??= "test-secret";
process.env.OSRM_URL = "off";
process.env.VAPID_PUBLIC_KEY = "";
process.env.VAPID_PRIVATE_KEY = "";

const { db } = await import("./db/index.ts");
const s = await import("./db/schema.ts");
const setup = await import("./setup.ts");
const { bus } = await import("./bus.ts");
const { createSession } = await import("./auth.ts");
const { adminSession: mkAdmin } = await import("./testing.ts");
const { upsertParcels } = await import("./parcels.ts");
const { greenRouter } = await import("./routers/green.ts");
const { driverRouter } = await import("./routers/driver.ts");
const { crewRouter } = await import("./routers/crew.ts");
const { adminRouter } = await import("./routers/admin.ts");
const { clearPaintHistory } = await import("./paint.ts");
const { eq } = await import("drizzle-orm");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

// #region fixture
const square = (lat: number, lng: number): LotGeometry => ({
  type: "Polygon",
  coordinates: [[[lng - 0.00005, lat - 0.00005], [lng + 0.00005, lat - 0.00005], [lng + 0.00005, lat + 0.00005], [lng - 0.00005, lat + 0.00005], [lng - 0.00005, lat - 0.00005]]],
});
const rect = (w: number, e: number, south: number, north: number): { type: "Polygon"; coordinates: Array<Array<[number, number]>> } => ({
  type: "Polygon",
  coordinates: [[[w, south], [e, south], [e, north], [w, north], [w, south]]],
});

const CC = { lat: 42.38, lng: -83.12 };
/** Parcels: two in crew A's rectangle, one in B's, one in the day area outside both, one far away. */
const SPOTS = {
  a1: { lat: 42.3800, lng: -83.1215 },
  a2: { lat: 42.3802, lng: -83.1205 },
  b1: { lat: 42.3800, lng: -83.1170 },
  mid: { lat: 42.3800, lng: -83.1194 },
  far: { lat: 42.3900, lng: -83.1000 },
} as const;
type Spot = keyof typeof SPOTS;
const pid = (k: Spot): string => `${k}.`;

const world = () => {
  db.delete(s.events).run();
  db.delete(s.parcels).run();
  const ev = setup.createEvent({ name: "Paint test", year: 2026, startDate: "2026-10-01", dayCount: 1, active: true });
  const day = db.select().from(s.days).where(eq(s.days.eventId, ev.id)).get()!;
  const east = setup.createCc({ dayId: day.id, name: "East", ...CC });
  const west = setup.createCc({ dayId: day.id, name: "West", lat: 42.37, lng: -83.0 });
  const gm = db.insert(s.companies).values({ eventId: ev.id, name: "General Motors", short: "GM" }).returning().get();
  const dte = db.insert(s.companies).values({ eventId: ev.id, name: "DTE", short: "DTE" }).returning().get();
  const crewA = setup.createCrew({ dayId: day.id, ccId: east.id, companyId: gm.id });
  const crewB = setup.createCrew({ dayId: day.id, ccId: east.id, companyId: gm.id });
  const crewC = setup.createCrew({ dayId: day.id, ccId: east.id, companyId: gm.id });
  const areaA = db.insert(s.crewAreas).values({ eventId: ev.id, dayId: day.id, polygon: rect(-83.122, -83.12, 42.3795, 42.3805) }).returning().get();
  const areaB = db.insert(s.crewAreas).values({ eventId: ev.id, dayId: day.id, polygon: rect(-83.118, -83.116, 42.3795, 42.3805) }).returning().get();
  db.update(s.crews).set({ areaId: areaA.id }).where(eq(s.crews.id, crewA.id)).run();
  db.update(s.crews).set({ areaId: areaB.id }).where(eq(s.crews.id, crewB.id)).run();
  upsertParcels(
    (Object.keys(SPOTS) as Spot[]).map((k) => ({
      parcelId: pid(k),
      address: `${100 + k.length} ${k.toUpperCase()} ST`,
      lat: SPOTS[k].lat,
      lng: SPOTS[k].lng,
      geometry: square(SPOTS[k].lat, SPOTS[k].lng),
      streetName: k.toUpperCase(),
      streetNumber: 100 + k.length,
      streetPrefix: null,
      crossStreet1: "Dexter Ave",
      crossStreet2: "Wildemere St",
      propertyClass: "402",
      propertyClassDescription: "RESIDENTIAL-VACANT",
      taxpayer1: null,
      isImproved: false,
      pctPreClaimed: 0,
      saleDate: null,
    })),
  );
  const truck = setup.createTruck({ dayId: day.id, ccId: east.id, name: "Truck 1" });
  const westLot = db.insert(s.lots).values({ eventId: ev.id, ccId: west.id, address: "1 West St", lat: 42.37, lng: -83.0, source: "manual" }).returning().get();
  const sessionCtx = (session: ReturnType<typeof createSession>, ccOverride: number | null = null) => ({ session, ip: "127.0.0.1", ccOverride });
  return {
    ev,
    day,
    east,
    west,
    gm,
    dte,
    crewA,
    crewB,
    crewC,
    areaA,
    areaB,
    truck,
    westLot,
    green: greenRouter.createCaller(sessionCtx(createSession({ role: "green", ccId: east.id, displayName: "Gwen" }))),
    admin: greenRouter.createCaller(sessionCtx(mkAdmin("Staff"), east.id)),
    driver: driverRouter.createCaller(sessionCtx(createSession({ role: "driver", truckId: truck.id, ccId: east.id, displayName: "Dana" }))),
    crew: (crewId: number) => crewRouter.createCaller(sessionCtx(createSession({ role: "crew", crewId, ccId: east.id, displayName: "Red" }))),
  };
};

let w: ReturnType<typeof world>;
beforeEach(() => {
  w = world();
});

const lotOf = (k: Spot) => db.select().from(s.lots).where(eq(s.lots.parcelId, pid(k))).get();
const codeOf = async (p: Promise<unknown>): Promise<string | null> => {
  try {
    await p;
    return null;
  } catch (e) {
    return typeof e === "object" && e !== null && "code" in e ? String((e as { code: unknown }).code) : "ERROR";
  }
};
const listen = () => {
  const got: number[] = [];
  const off = bus.subscribe((m) => {
    if (m.type === "lot.changed") got.push(m.payload.lot.id);
  });
  return { got, off };
};
// #endregion

beforeEach(() => clearPaintHistory());

const statusOf = (k: Spot): string => lotOf(k)?.status ?? "bare";

describe("paint", () => {
  test("a stroke applies the brush, skips parcels already in that status, and emits lot.changed per lot", async () => {
    await w.green.setLotStatus({ parcelId: pid("a2"), status: "open" });
    const l = listen();
    const r = await w.green.paint({ brush: { kind: "status", status: "open" }, lotIds: [], parcelIds: [pid("a1"), pid("a2"), pid("b1")] });
    l.off();
    expect(r).toMatchObject({ changed: 2, skipped: 1, refused: 0, strokes: 1 });
    expect(lotOf("a1")).toMatchObject({ status: "open", crewId: w.crewA.id, source: "manual", ccId: w.east.id });
    expect(lotOf("b1")).toMatchObject({ status: "open", crewId: w.crewB.id });
    expect(new Set(l.got)).toEqual(new Set([lotOf("a1")!.id, lotOf("b1")!.id]));
    // Not todo on a bare parcel is already Not todo.
    const none = await w.green.paint({ brush: { kind: "status", status: "not_todo" }, lotIds: [], parcelIds: [pid("mid")] });
    expect(none).toMatchObject({ changed: 0, skipped: 1, strokes: 1 });
  });

  test("Undo restores the previous statuses, deleting lots the stroke created, and walks back stroke by stroke", async () => {
    const done = (await w.green.setLotStatus({ parcelId: pid("a2"), status: "done" })).lot!;
    await w.green.paint({ brush: { kind: "status", status: "open" }, lotIds: [done.id], parcelIds: [pid("a1"), pid("b1")] });
    await w.green.paint({ brush: { kind: "status", status: "do_not_touch" }, lotIds: [], parcelIds: [pid("a1"), pid("mid")] });
    expect([statusOf("a1"), statusOf("a2"), statusOf("b1"), statusOf("mid")]).toEqual(["do_not_touch", "open", "open", "do_not_touch"]);

    expect(await w.green.paintUndo()).toMatchObject({ restored: 2, kept: 0, strokes: 1 });
    expect([statusOf("a1"), statusOf("mid")]).toEqual(["open", "bare"]);

    expect(await w.green.paintUndo()).toMatchObject({ restored: 3, strokes: 0 });
    expect([statusOf("a1"), statusOf("a2"), statusOf("b1")]).toEqual(["bare", "done", "bare"]);
    expect(lotOf("a2")!.id).toBe(done.id);
    expect(await codeOf(w.green.paintUndo())).toBe("BAD_REQUEST");
  });

  test("Undo brings back a lot that Not todo deleted, with its id, and takes back the survey clear", async () => {
    const lot = db
      .insert(s.lots)
      .values({ eventId: w.ev.id, parcelId: pid("a1"), address: "Survey lot", lat: SPOTS.a1.lat, lng: SPOTS.a1.lng, source: "survey", ccId: w.east.id, crewId: w.crewA.id, status: "open" })
      .returning()
      .get();
    db.insert(s.surveyTags).values({ eventId: w.ev.id, parcelId: pid("a1"), grade: "low", side: "tap", by: "Kelsey", at: 1 }).run();
    const tags = () => db.select().from(s.surveyTags).where(eq(s.surveyTags.parcelId, pid("a1"))).all().length;
    await w.green.paint({ brush: { kind: "status", status: "not_todo" }, lotIds: [lot.id], parcelIds: [] });
    expect(lotOf("a1")).toBeUndefined();
    expect(tags()).toBe(2);
    await w.green.paintUndo();
    expect(lotOf("a1")).toMatchObject({ id: lot.id, status: "open", source: "survey", crewId: w.crewA.id });
    expect(tags()).toBe(1);
  });

  test("Undo leaves a lot someone changed after the stroke", async () => {
    await w.green.paint({ brush: { kind: "status", status: "open" }, lotIds: [], parcelIds: [pid("a1"), pid("a2")] });
    await w.driver.setLotStatus({ lotId: lotOf("a1")!.id, status: "in_progress" });
    expect(await w.green.paintUndo()).toMatchObject({ restored: 1, kept: 1 });
    expect([statusOf("a1"), statusOf("a2")]).toEqual(["in_progress", "bare"]);
  });

  test("Crew brush moves work lots to the crew and skips bare parcels; Undo gives them back", async () => {
    await w.green.paint({ brush: { kind: "status", status: "open" }, lotIds: [], parcelIds: [pid("a1"), pid("b1")] });
    const r = await w.green.paint({ brush: { kind: "crew", crewId: w.crewC.id }, lotIds: [], parcelIds: [pid("a1"), pid("b1"), pid("mid")] });
    expect(r).toMatchObject({ changed: 2, skipped: 1 });
    expect([lotOf("a1")!.crewId, lotOf("b1")!.crewId]).toEqual([w.crewC.id, w.crewC.id]);
    await w.green.paintUndo();
    expect([lotOf("a1")!.crewId, lotOf("b1")!.crewId]).toEqual([w.crewA.id, w.crewB.id]);
    const west = setup.createCrew({ dayId: w.day.id, ccId: w.west.id, companyId: w.gm.id });
    expect(await codeOf(w.green.paint({ brush: { kind: "crew", crewId: west.id }, lotIds: [], parcelIds: [pid("a1")] }))).toBe("BAD_REQUEST");
  });
});

describe("paint role scope", () => {
  test("red shirts and drivers have no Paint", async () => {
    const stroke = { brush: { kind: "status" as const, status: "open" as const }, lotIds: [], parcelIds: [pid("a1")] };
    const asCrew = greenRouter.createCaller({ session: createSession({ role: "crew", crewId: w.crewA.id, ccId: w.east.id }), ip: "t", ccOverride: null });
    const asDriver = greenRouter.createCaller({ session: createSession({ role: "driver", truckId: w.truck.id, ccId: w.east.id }), ip: "t", ccOverride: null });
    expect(await codeOf(asCrew.paint(stroke))).toBe("FORBIDDEN");
    expect(await codeOf(asDriver.paint(stroke))).toBe("FORBIDDEN");
    const asGreen = adminRouter.createCaller({ session: createSession({ role: "green", ccId: w.east.id }), ip: "t", ccOverride: null }).lots;
    expect(await codeOf(asGreen.paint({ ...stroke, ccId: w.east.id }))).toBe("FORBIDDEN");
    expect(lotOf("a1")).toBeUndefined();
  });

  test("a green's stroke refuses lots at another CC and applies the rest", async () => {
    const r = await w.green.paint({ brush: { kind: "status", status: "done" }, lotIds: [w.westLot.id], parcelIds: [pid("a1")] });
    expect(r).toMatchObject({ changed: 1, refused: 1 });
    expect(db.select().from(s.lots).where(eq(s.lots.id, w.westLot.id)).get()!.status).toBe("open");
  });

  test("admin paints at the CC it picks, with its own undo history per CC", async () => {
    const adminLots = adminRouter.createCaller({ session: mkAdmin("Staff"), ip: "t", ccOverride: null }).lots;
    expect((await adminLots.parcels({ ccId: w.east.id })).length).toBe(4);
    const r = await adminLots.paint({ ccId: w.east.id, brush: { kind: "status", status: "do_not_touch" }, lotIds: [w.westLot.id], parcelIds: [pid("mid")] });
    expect(r).toMatchObject({ changed: 1, refused: 1, strokes: 1 });
    expect(statusOf("mid")).toBe("do_not_touch");
    expect(await adminLots.paintState({ ccId: w.west.id })).toEqual({ strokes: 0 });
    expect(await codeOf(adminLots.paintUndo({ ccId: w.west.id }))).toBe("BAD_REQUEST");
    await adminLots.paintUndo({ ccId: w.east.id });
    expect(statusOf("mid")).toBe("bare");
  });
});
