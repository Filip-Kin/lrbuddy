import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LotGeometry } from "./db/schema.ts";

// The db opens $DATA_DIR at import, so the env is set first and every app module is imported dynamically.
const dir = mkdtempSync(join(tmpdir(), "lrbuddy-drawn-test-"));
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
const { createSession } = await import("./auth.ts");
const { upsertParcels } = await import("./parcels.ts");
const { greenRouter } = await import("./routers/green.ts");
const { driverRouter } = await import("./routers/driver.ts");
const { crewRouter } = await import("./routers/crew.ts");

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
  const ev = setup.createEvent({ name: "Drawn test", year: 2026, startDate: "2026-10-01", dayCount: 1, active: true });
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
    admin: greenRouter.createCaller(sessionCtx(createSession({ role: "admin", displayName: "Staff" }), east.id)),
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

/** A long thin box at lat 42.3801 between the A1 (south) and A2 (north) parcels, about 130 m by 2 m. */
const alley = { type: "Polygon" as const, coordinates: [[[-83.1218, 42.38009], [-83.1202, 42.38009], [-83.1202, 42.38011], [-83.1218, 42.38011]] as Array<[number, number]>] };
/** A 20 m square in the day area, outside both rectangles. */
const square20 = { type: "Polygon" as const, coordinates: [[[-83.1196, 42.3799], [-83.11936, 42.3799], [-83.11936, 42.38008], [-83.1196, 42.38008]] as Array<[number, number]>] };
const lotById = (id: number) => db.select().from(s.lots).where(eq(s.lots.id, id)).get();

describe("draw lot", () => {
  test("a long thin shape is named for the streets either side, north first, with the rectangle's crew", async () => {
    expect(await w.green.drawLotStart({ polygon: alley })).toEqual({ name: "Alley, A2 to A1", crewId: w.crewA.id });
    expect(await w.green.drawLotStart({ polygon: square20 })).toEqual({ name: "Lot", crewId: null });
  });

  test("Save makes a drawn lot: no parcel id, the shape, the centroid, the name, the status and crew given", async () => {
    const l = listen();
    const lot = await w.green.drawLot({ polygon: alley, name: " Alley, A2 to A1 ", status: "open", crewId: w.crewA.id });
    l.off();
    expect(lot).toMatchObject({ source: "drawn", parcelId: null, address: "Alley, A2 to A1", status: "open", crewId: w.crewA.id, ccId: w.east.id });
    expect(lot.lat).toBeCloseTo(42.3801, 5);
    expect(lot.lng).toBeCloseTo(-83.121, 5);
    expect(lot.geometry!.type).toBe("Polygon");
    expect(l.got).toContain(lot.id);
    // It is a lot like any other: on the driver's list, and Not todo keeps the row.
    expect((await w.driver.lots()).lots.some((x: { id: number }) => x.id === lot.id)).toBe(true);
    expect((await w.green.setLotStatus({ lotId: lot.id, status: "not_todo" })).lot!.status).toBe("not_todo");
  });

  test("too small, too few points or no area is refused; another CC's crew is refused", async () => {
    const tiny = { type: "Polygon" as const, coordinates: [[[-83.1196, 42.3799], [-83.11955, 42.3799], [-83.11955, 42.37994]] as Array<[number, number]>] };
    const line = { type: "Polygon" as const, coordinates: [[[-83.1196, 42.3799], [-83.1194, 42.3799], [-83.1192, 42.3799]] as Array<[number, number]>] };
    expect(await codeOf(w.green.drawLot({ polygon: tiny, name: "x", status: "open", crewId: null }))).toBe("BAD_REQUEST");
    expect(await codeOf(w.green.drawLot({ polygon: line, name: "x", status: "open", crewId: null }))).toBe("BAD_REQUEST");
    const westCrew = setup.createCrew({ dayId: w.day.id, ccId: w.west.id, companyId: w.gm.id });
    expect(await codeOf(w.green.drawLot({ polygon: square20, name: "x", status: "open", crewId: westCrew.id }))).toBe("BAD_REQUEST");
  });

  test("Edit shape moves the outline and centre; Delete lot only without photos or history", async () => {
    const lot = await w.admin.drawLot({ polygon: square20, name: "Corner dump", status: "do_not_touch", crewId: null });
    const moved = await w.green.editLotShape({ lotId: lot.id, polygon: alley });
    expect(moved.lat).toBeCloseTo(42.3801, 5);
    expect(moved.status).toBe("do_not_touch");
    expect(await w.green.deleteLot({ lotId: lot.id })).toEqual({ deleted: true });
    expect(lotById(lot.id)).toBeUndefined();

    const worked = await w.green.drawLot({ polygon: square20, name: "Lot", status: "open", crewId: null });
    await w.driver.setLotStatus({ lotId: worked.id, status: "done" });
    expect(await codeOf(w.green.deleteLot({ lotId: worked.id }))).toBe("BAD_REQUEST");
    const shot = await w.green.drawLot({ polygon: alley, name: "Lot", status: "open", crewId: null });
    db.insert(s.lotPhotos).values({ lotId: shot.id, kind: "before", role: "green", at: Date.now(), width: 10, height: 10, bytes: 10, deletedAt: Date.now() }).run();
    expect(await codeOf(w.green.deleteLot({ lotId: shot.id }))).toBe("BAD_REQUEST");
    // A parcel lot is not a drawn lot: no shape edits, no delete here.
    const parcelLot = (await w.green.setLotStatus({ parcelId: pid("a1"), status: "open" })).lot!;
    expect(await codeOf(w.green.editLotShape({ lotId: parcelLot.id, polygon: alley }))).toBe("BAD_REQUEST");
    expect(await codeOf(w.green.deleteLot({ lotId: parcelLot.id }))).toBe("BAD_REQUEST");
  });

  test("red shirts and drivers cannot draw", async () => {
    const asCrew = greenRouter.createCaller({ session: createSession({ role: "crew", crewId: w.crewA.id, ccId: w.east.id }), ip: "t", ccOverride: null });
    const asDriver = greenRouter.createCaller({ session: createSession({ role: "driver", truckId: w.truck.id, ccId: w.east.id }), ip: "t", ccOverride: null });
    expect(await codeOf(asCrew.drawLot({ polygon: square20, name: "x", status: "open", crewId: null }))).toBe("FORBIDDEN");
    expect(await codeOf(asDriver.drawLot({ polygon: square20, name: "x", status: "open", crewId: null }))).toBe("FORBIDDEN");
  });
});
