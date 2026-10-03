import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LotGeometry } from "./db/schema.ts";

// The db opens $DATA_DIR at import, so the env is set first and every app module is imported dynamically.
const dir = mkdtempSync(join(tmpdir(), "lrbuddy-alley-lots-test-"));
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
const { upsertParcels } = await import("./parcels.ts");
const { greenRouter } = await import("./routers/green.ts");
const { eq } = await import("drizzle-orm");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

// An east-west alley at lat 42.38 from lng -83.122 to -83.118 (about 330 m), Lawrence on the north,
// Collingwood on the south, all one block between Dexter and Wildemere. Crew A's rectangle holds it.
const LAT = 42.38;
const M_LAT = 111_320;
const kx = M_LAT * Math.cos((LAT * Math.PI) / 180);
const W = -83.122;
const E = -83.118;
const rect = (w: number, e: number, south: number, north: number): { type: "Polygon"; coordinates: Array<Array<[number, number]>> } => ({
  type: "Polygon",
  coordinates: [[[w, south], [e, south], [e, north], [w, north], [w, south]]],
});
const square = (lat: number, lng: number): LotGeometry => ({
  type: "Polygon",
  coordinates: [[[lng - 0.00005, lat - 0.00005], [lng + 0.00005, lat - 0.00005], [lng + 0.00005, lat + 0.00005], [lng - 0.00005, lat + 0.00005], [lng - 0.00005, lat - 0.00005]]],
});

const world = () => {
  db.delete(s.events).run();
  db.delete(s.parcels).run();
  db.delete(s.osmAlleys).run();
  const ev = setup.createEvent({ name: "Alley lots", year: 2026, startDate: "2026-10-01", dayCount: 1, active: true });
  const day = db.select().from(s.days).where(eq(s.days.eventId, ev.id)).get()!;
  const cc = setup.createCc({ dayId: day.id, name: "Durfee", lat: 42.381, lng: -83.12 });
  const gm = db.insert(s.companies).values({ eventId: ev.id, name: "General Motors", short: "GM" }).returning().get();
  const crewA = setup.createCrew({ dayId: day.id, ccId: cc.id, companyId: gm.id });
  const area = db.insert(s.crewAreas).values({ eventId: ev.id, dayId: day.id, polygon: rect(-83.1225, -83.1175, 42.3792, 42.3808) }).returning().get();
  db.update(s.crews).set({ areaId: area.id }).where(eq(s.crews.id, crewA.id)).run();
  const rows = [];
  let n = 0;
  for (let x = 10; x < 320; x += 12) {
    for (const [street, dy] of [["LAWRENCE", 20], ["COLLINGWOOD", -20]] as const) {
      const lat = LAT + dy / M_LAT;
      const lng = W + x / kx;
      n++;
      rows.push({
        parcelId: `${n}.`,
        address: `${1000 + n} ${street}`,
        lat,
        lng,
        geometry: square(lat, lng),
        streetName: street,
        streetNumber: 1000 + n,
        streetPrefix: null,
        crossStreet1: "Dexter Ave",
        crossStreet2: "Wildemere St",
        propertyClass: "401",
        propertyClassDescription: "RESIDENTIAL",
        taxpayer1: null,
        isImproved: true,
        pctPreClaimed: 0,
        saleDate: null,
      });
    }
  }
  upsertParcels(rows);
  db.insert(s.osmAlleys).values({ osmId: 4242, centerline: [[LAT, W], [LAT, E]], minLat: LAT, maxLat: LAT, minLng: W, maxLng: E, fetchedAt: 1 }).run();
  const ctx = { session: createSession({ role: "green", ccId: cc.id, displayName: "Gwen" }), ip: "127.0.0.1", ccOverride: null };
  return { ev, day, cc, crewA, green: greenRouter.createCaller(ctx) };
};

let w: ReturnType<typeof world>;
beforeEach(() => {
  w = world();
});

const codeOf = async (p: Promise<unknown>): Promise<string | null> => {
  try {
    await p;
    return null;
  } catch (e) {
    return typeof e === "object" && e !== null && "code" in e ? String((e as { code: unknown }).code) : "ERROR";
  }
};
const alleyLots = () => db.select().from(s.lots).where(eq(s.lots.source, "drawn")).all();

describe("alley halves on the Flag screen (SPEC 22, alleys)", () => {
  test("the cached alley in the day area, cut in two halves, named by its streets and compass half", async () => {
    const halves = await w.green.alleyHalves();
    expect(halves.map((h) => [h.key, h.name, h.lotId])).toEqual([
      ["4242:0:0", "Alley, Lawrence to Collingwood, west half", null],
      ["4242:0:1", "Alley, Lawrence to Collingwood, east half", null],
    ]);
    expect(halves[0]!.lng).toBeLessThan(halves[1]!.lng);
    expect(halves[0]!.geometry.type).toBe("Polygon");
  });

  test("the first flag makes the lot as Draw lot does; the next finds it", async () => {
    const got: number[] = [];
    const off = bus.subscribe((m) => {
      if (m.type === "lot.changed") got.push(m.payload.lot.id);
    });
    const { lot } = await w.green.flagAlley({ key: "4242:0:1", status: "open" });
    off();
    expect(lot).toMatchObject({ source: "drawn", parcelId: null, address: "Alley, Lawrence to Collingwood, east half", status: "open", crewId: w.crewA.id, ccId: w.cc.id, alleyKey: "4242:0:1" });
    expect(got).toEqual([lot.id]);
    expect(lot.lng).toBeGreaterThan((W + E) / 2);

    const again = await w.green.flagAlley({ key: "4242:0:1", status: "do_not_touch" });
    expect(again.lot.id).toBe(lot.id);
    expect(again.lot.status).toBe("do_not_touch");
    expect(alleyLots()).toHaveLength(1);
    expect((await w.green.alleyHalves()).map((h) => h.lotId)).toEqual([null, lot.id]);

    // Not todo keeps the row, as for every drawn lot; flagging again brings it back to Todo.
    await w.green.setLotStatus({ lotId: lot.id, status: "open" });
    await w.green.setLotStatus({ lotId: lot.id, status: "not_todo" });
    expect(alleyLots()[0]!.status).toBe("not_todo");
    expect((await w.green.flagAlley({ key: "4242:0:1", status: "open" })).lot.id).toBe(lot.id);
    expect(alleyLots()).toHaveLength(1);
  });

  test("a hand-drawn lot over a half's middle is that half's lot", async () => {
    const drawn = await w.green.drawLot({
      polygon: { type: "Polygon", coordinates: [[[W + 20 / kx, LAT - 2 / M_LAT], [W + 150 / kx, LAT - 2 / M_LAT], [W + 150 / kx, LAT + 2 / M_LAT], [W + 20 / kx, LAT + 2 / M_LAT]]] },
      name: "Alley, Lawrence",
      status: "open",
      crewId: null,
    });
    expect((await w.green.alleyHalves()).map((h) => h.lotId)).toEqual([drawn.id, null]);
    expect((await w.green.flagAlley({ key: "4242:0:0", status: "open" })).lot.id).toBe(drawn.id);
    expect(alleyLots()).toHaveLength(1);
  });

  test("a key that is no half, or a half outside the day area, is refused", async () => {
    expect(await codeOf(w.green.flagAlley({ key: "4242:5:0", status: "open" }))).toBe("BAD_REQUEST");
    expect(await codeOf(w.green.flagAlley({ key: "nonsense", status: "open" }))).toBe("BAD_REQUEST");
    db.insert(s.osmAlleys).values({ osmId: 99, centerline: [[42.39, -83.0], [42.39, -82.99]], minLat: 42.39, maxLat: 42.39, minLng: -83.0, maxLng: -82.99, fetchedAt: 1 }).run();
    expect(await codeOf(w.green.flagAlley({ key: "99:0:0", status: "open" }))).toBe("FORBIDDEN");
    expect((await w.green.alleyHalves()).map((h) => h.key)).toEqual(["4242:0:0", "4242:0:1"]);
    expect(alleyLots()).toHaveLength(0);
  });
});
