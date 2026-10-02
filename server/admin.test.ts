import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The db module opens $DATA_DIR at import; set the env before anything loads it.
const dir = mkdtempSync(join(tmpdir(), "lrbuddy-admin-test-"));
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
const { createSession } = await import("./auth.ts");
const { adminRouter } = await import("./routers/admin.ts");
const { eq } = await import("drizzle-orm");
// Config is read once per process; another test file may have loaded it first.
const { config } = await import("./config.ts");

afterAll(() => {
  d.cancelScheduledRoutes();
  rmSync(dir, { recursive: true, force: true });
});

// #region fixture
const EAST = { lat: 42.3786, lng: -82.9911 };
const WEST = { lat: 42.3701, lng: -83.0209 };

const callerFor = (role: "admin" | "green") => {
  const session = createSession({ role });
  return adminRouter.createCaller({ session, ip: "test", ccOverride: null });
};

interface World {
  eventId: number;
  day1: number;
  day2: number;
  east: number;
  west: number;
}

const fresh = (): World => {
  d.cancelScheduledRoutes();
  db.delete(s.events).run();
  db.delete(s.positions).run();
  const ev = setup.createEvent({ name: "Test", year: 2026, startDate: "2026-09-28", dayCount: 2, active: true });
  const [day1, day2] = db.select().from(s.days).where(eq(s.days.eventId, ev.id)).orderBy(s.days.sort).all();
  const east = setup.createCc({ dayId: day1!.id, name: "East", ...EAST, address: "Anchor Detroit" });
  const west = setup.createCc({ dayId: day1!.id, name: "West", ...WEST });
  return { eventId: ev.id, day1: day1!.id, day2: day2!.id, east: east.id, west: west.id };
};

let w: World;
let admin: ReturnType<typeof callerFor>;
beforeEach(() => {
  w = fresh();
  admin = callerFor("admin");
});
// #endregion

describe("admin access", () => {
  test("a green session is refused", async () => {
    const green = callerFor("green");
    await expect(green.events.list()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("crew CSV import", () => {
  test("matches days by label, date or number, CCs with or without the prefix, and adds companies", async () => {
    const csv = [
      "Day, CC, Company, Lead Name, Lead Phone, Headcount",
      "Day 1,East,Ford,Pat,313-555-0100,10",
      "2026-09-28,CC West,Rocket,Sam,,8",
      "1,east,ford,Lee,,",
      "Day 9,East,Ford,Nope,,1",
      "Day 1,Nowhere,Ford,Nope,,1",
    ].join("\n");
    const r = await admin.crews.importCsv({ csv });
    expect(r.added).toBe(3);
    expect(r.errors).toEqual(['Row 5: day "Day 9" not found', 'Row 6: CC "Nowhere" not found on Day 1']);
    const crews = await admin.crews.list({ dayId: w.day1 });
    expect(crews.map((c) => [c.name, c.ccName, c.companyName, c.headcount])).toEqual([
      ["Ford 1", "East", "Ford", 10],
      ["Rocket 1", "West", "Rocket", 8],
      ["Ford 2", "East", "Ford", null],
    ]);
    expect(crews[0]!.joinUrl).toBe(`${config.publicUrl}/j/${crews[0]!.token}`);
    const companies = await admin.companies.list();
    expect(companies.map((c) => [c.name, c.crewCount, c.headcount])).toEqual([
      ["Ford", 2, 10],
      ["Rocket", 1, 8],
    ]);
  });

  test("a blank CC works on a day with one CC", async () => {
    setup.createCc({ dayId: w.day2, name: "Only", ...EAST });
    const r = await admin.crews.importCsv({ csv: "day,cc,company\nDay 2,,GM\n" });
    expect(r).toEqual({ added: 1, updated: 0, errors: [] });
  });

  test("importing the same CSV twice updates the crews instead of doubling them", async () => {
    const csv = "day,cc,company,lead_name,lead_phone,headcount\nDay 1,East,Ford,Rita Red,313-555-0101,10\nDay 1,West,GM,Ron Red,,8\n";
    expect(await admin.crews.importCsv({ csv })).toEqual({ added: 2, updated: 0, errors: [] });
    const fixed = "day,cc,company,lead_name,lead_phone,headcount\nDay 1,East,Ford,Rita R.,(313) 555-0101,12\nDay 1,West,GM,ron red,,9\n";
    expect(await admin.crews.importCsv({ csv: fixed })).toEqual({ added: 0, updated: 2, errors: [] });
    const crews = await admin.crews.list({ dayId: w.day1 });
    expect(crews.map((c) => [c.name, c.leadName, c.headcount])).toEqual([
      ["Ford 1", "Rita R.", 12],
      ["GM 1", "ron red", 9],
    ]);
  });
});

describe("companies", () => {
  test("a duplicate name, any case, is refused", async () => {
    await admin.companies.create({ name: "Ford" });
    await expect(admin.companies.create({ name: "ford" })).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("day setup", () => {
  test("copy from the previous day brings CCs, green shirts and truck capacities, once", async () => {
    await admin.greenShirts.create({ ccId: w.east, name: "Dana", phone: "3135550101", roleLabel: "Site lead" });
    const truck = await admin.trucks.create({ ccId: w.east, name: "Truck 1" });
    const water = (await admin.catalog.list()).find((t) => t.key === "water")!;
    await admin.trucks.setCapacity({ truckId: truck.id, typeId: water.id, capacity: 44 });

    expect(await admin.days.copyFromPrevious({ id: w.day2 })).toEqual({ ccs: 2, trucks: 1 });
    const day2 = await admin.days.get({ id: w.day2 });
    const east = day2.ccs.find((c) => c.name === "East")!;
    expect(east.greenShirts.map((g) => g.name)).toEqual(["Dana"]);
    expect(east.trucks[0]!.stock.find((x) => x.key === "water")).toMatchObject({ capacity: 44, qty: 44 });
    expect(east.greenCode).not.toBeNull();
    expect(east.trucks[0]!.code).not.toBe(truck.code);
    expect(day2.previous).toMatchObject({ id: w.day1, ccCount: 2 });

    await expect(admin.days.copyFromPrevious({ id: w.day2 })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  test("a truck cannot move to a CC on another day", async () => {
    const truck = await admin.trucks.create({ ccId: w.east, name: "Truck 1" });
    const other = setup.createCc({ dayId: w.day2, name: "Later", ...EAST });
    await expect(admin.trucks.update({ id: truck.id, ccId: other.id })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  test("removing a truck puts its stops back to open", async () => {
    const truck = await admin.trucks.create({ ccId: w.east, name: "Truck 1" });
    db.update(s.trucks).set({ lastSeenAt: Date.now() }).where(eq(s.trucks.id, truck.id)).run();
    const crew = setup.createCrew({ dayId: w.day1, ccId: w.east, companyId: null });
    const water = (await admin.catalog.list()).find((t) => t.key === "water")!;
    const req = d.createRequest({ crewId: crew.id, ccId: w.east, dayId: w.day1, typeId: water.id, qty: 1, createdBy: "crew", lat: EAST.lat, lng: EAST.lng });
    expect(req).toMatchObject({ status: "assigned", truckId: truck.id });

    const r = await admin.trucks.delete({ id: truck.id });
    expect(r.reopened).toBe(1);
    const after = db.select().from(s.requests).where(eq(s.requests.id, req.id)).get()!;
    expect(after).toMatchObject({ status: "open", truckId: null, assignedAt: null });
  });
});

describe("lots", () => {
  const addLot = (lat: number, lng: number, parcelId: string) =>
    db.insert(s.lots).values({ eventId: w.eventId, lat, lng, parcelId, address: `${parcelId} St`, source: "csv" }).returning().get();

  test("a new CC clears the crew; a status change stamps the time", async () => {
    const crew = setup.createCrew({ dayId: w.day1, ccId: w.east, companyId: null });
    const lot = addLot(42.378, -82.99, "A.");
    db.update(s.lots).set({ ccId: w.east, crewId: crew.id }).where(eq(s.lots.id, lot.id)).run();

    const moved = await admin.lots.update({ id: lot.id, ccId: w.west });
    expect(moved).toMatchObject({ ccId: w.west, crewId: null });
    const done = await admin.lots.update({ id: lot.id, status: "done", note: " cleared " });
    expect(done.status).toBe("done");
    expect(done.note).toBe("cleared");
    expect(done.statusAt).toBeGreaterThan(0);

    const list = await admin.lots.list();
    expect(list[0]!.crewName).toBeNull();
  });

  test("lot CSV rows name what is wrong with lat and lng", async () => {
    const { parseLotsCsv } = await import("./lots-import.ts");
    const r = parseLotsCsv('address,lat,lng\n"123 Fake St",42.37,-83.00\nBad row,abc,-83\nNo lng,42.3,\nFar,95,-83\n');
    expect(r.rows).toHaveLength(1);
    expect(r.errors).toEqual(["Row 3: lat not a number", "Row 4: lng missing", "Row 5: lat out of range"]);
  });

  test("assessor addresses arrive in title case", async () => {
    const { titleCase } = await import("./lots-import.ts");
    expect(titleCase("5125 IROQUOIS")).toBe("5125 Iroquois");
    expect(titleCase("1200 E GRAND BLVD")).toBe("1200 E Grand Blvd");
    expect(titleCase("4776 Seminole")).toBe("4776 Seminole");
  });

  test("Land Bank and every other import store addresses in title case", async () => {
    const { fetchDlba, upsertLots } = await import("./lots-import.ts");
    const page = { features: [{ attributes: { name: "4136 BUCKINGHAM", parcel_id: "DLBA1.", latitude: 42.375, longitude: -83.0 } }] };
    const fake: typeof fetch = Object.assign(async () => new Response(JSON.stringify(page)), { preconnect: fetch.preconnect });
    const rows = await fetchDlba([-83.01, 42.37, -82.99, 42.38], { fetchImpl: fake });
    expect(rows.map((r) => r.address)).toEqual(["4136 Buckingham"]);
    upsertLots(w.eventId, [{ parcelId: "CAPS.", address: " 4114 DEVONSHIRE ", lat: 42.376, lng: -83.0 }], "csv");
    const stored = (await admin.lots.list()).find((l) => l.parcelId === "CAPS.");
    expect(stored?.address).toBe("4114 Devonshire");
  });

  test("CSV lots can go straight to a CC; a lot already at another CC keeps it", async () => {
    const { upsertLots } = await import("./lots-import.ts");
    const held = addLot(42.37, -83.0, "HELD.");
    db.update(s.lots).set({ ccId: w.west }).where(eq(s.lots.id, held.id)).run();
    const r = upsertLots(
      w.eventId,
      [
        { parcelId: null, address: "New", lat: 42.371, lng: -83.001 },
        { parcelId: "HELD.", address: "Held", lat: 42.37, lng: -83.0 },
      ],
      "csv",
      w.east,
    );
    expect(r).toEqual({ added: 1, updated: 1, skipped: 0 });
    const byAddress = new Map((await admin.lots.list()).map((l) => [l.address, l.ccId]));
    expect(byAddress.get("New")).toBe(w.east);
    expect(byAddress.get("Held")).toBe(w.west);
  });

  test("assign and remove by id only touch the selected lots", async () => {
    const a = addLot(42.378, -82.99, "IN1.");
    const b = addLot(42.379, -82.991, "IN2.");
    addLot(42.36, -83.05, "OUT.");
    expect(await admin.lots.assignCc({ ids: [a.id, b.id], ccId: w.east })).toEqual({ updated: 2 });
    const counts = await admin.lots.counts();
    expect(counts.unassigned).toBe(1);
    expect(await admin.lots.delete({ ids: [a.id, b.id] })).toEqual({ deleted: 2 });
    expect((await admin.lots.list()).map((l) => l.parcelId)).toEqual(["OUT."]);
  });

  test("a rotated rectangle takes the lots inside it, not its bounding box", async () => {
    const { assignLotsToCcInArea } = await import("./lots-import.ts");
    addLot(42.38, -82.99, "MID.");
    addLot(42.3845, -82.9945, "CORNER.");
    // A diamond around (42.38, -82.99): the corner lot is inside its bbox but outside the diamond.
    const ring: Array<[number, number]> = [[-82.995, 42.38], [-82.99, 42.385], [-82.985, 42.38], [-82.99, 42.375], [-82.995, 42.38]];
    expect(assignLotsToCcInArea(w.eventId, ring, w.east)).toBe(1);
    const byParcel = new Map((await admin.lots.list()).map((l) => [l.parcelId, l.ccId]));
    expect(byParcel.get("MID.")).toBe(w.east);
    expect(byParcel.get("CORNER.")).toBeNull();
  });

  test("an import's CC only takes lots in the area that have no CC", async () => {
    const { assignLotsToCcInArea } = await import("./lots-import.ts");
    addLot(42.378, -82.99, "FREE.");
    const taken = addLot(42.379, -82.991, "WEST.");
    db.update(s.lots).set({ ccId: w.west }).where(eq(s.lots.id, taken.id)).run();
    const box: [number, number, number, number] = [-82.995, 42.375, -82.985, 42.382];
    expect(assignLotsToCcInArea(w.eventId, box, w.east, true)).toBe(1);
    const byParcel = new Map((await admin.lots.list()).map((l) => [l.parcelId, l.ccId]));
    expect(byParcel.get("FREE.")).toBe(w.east);
    expect(byParcel.get("WEST.")).toBe(w.west);
  });
});

describe("catalog", () => {
  test("a new item gets a key from its label, unique within the event", async () => {
    const a = await admin.catalog.create({ label: "Water", unit: "case", priority: 3, tracksStock: true, defaultCapacity: 5 });
    const b = await admin.catalog.create({ label: "Rakes & hoes", unit: "each", priority: 1, tracksStock: true, defaultCapacity: 4 });
    expect(a.key).toBe("water_2");
    expect(b.key).toBe("rakes_hoes");
    expect(b.sort).toBe(a.sort + 1);
  });
});

describe("catalog stock", () => {
  test("a tracked item added after the trucks reaches every truck, full at its default", async () => {
    const t = setup.createTruck({ dayId: w.day1, ccId: w.east, name: "Truck 1" });
    const ice = await admin.catalog.create({ label: "Ice", unit: "each", priority: 2, tracksStock: false });
    expect(d.stockFor(t.id).some((r) => r.typeId === ice.id)).toBe(false);
    await admin.catalog.update({ id: ice.id, tracksStock: true, defaultCapacity: 10 });
    const row = d.stockFor(t.id).find((r) => r.typeId === ice.id);
    expect(row).toMatchObject({ qty: 10, capacity: 10 });
    const bags = await admin.catalog.create({ label: "Gloves", unit: "box", priority: 1, tracksStock: true, defaultCapacity: 4 });
    expect(d.stockFor(t.id).find((r) => r.typeId === bags.id)).toMatchObject({ qty: 4, capacity: 4 });
  });
});

describe("export", () => {
  test("empty exports still carry their header", async () => {
    const csv = await admin.export.requests();
    expect(csv.split("\n")[0]).toStartWith("id,day,date,cc,crew,company");
    expect((await admin.export.stockMoves()).trim()).toBe("id,day,cc,truck,item,unit,delta,reason,request_id,at");
  });

  test("lot rows name the day, CC and crew instead of ids", async () => {
    const crew = setup.createCrew({ dayId: w.day1, ccId: w.east, companyId: null });
    db.insert(s.lots).values({ eventId: w.eventId, lat: 42.378, lng: -82.99, parcelId: "P.", address: "1 Main", source: "csv", ccId: w.east, crewId: crew.id }).run();
    const lines = (await admin.export.lots()).trim().split(/\r?\n/);
    expect(lines[0]).toBe("id,parcel_id,address,lat,lng,source,day,cc,crew,company,status,status_at,note");
    expect(lines[1]).toContain(",Day 1,East,Crew 1,,open,,");
    expect(await admin.export.counts()).toMatchObject({ lots: 1, requests: 0 });
  });
});

