import { Database } from "bun:sqlite";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AreaPolygon } from "./db/schema.ts";

// The db module opens $DATA_DIR at import; set the env before anything loads it.
const dir = mkdtempSync(join(tmpdir(), "lrbuddy-crew-name-test-"));
process.env.DATA_DIR = dir;
process.env.SESSION_SECRET = "test-secret";
process.env.ADMIN_PASSWORD = "test-admin";
process.env.OSRM_URL = "off";
process.env.VAPID_PUBLIC_KEY = "";
process.env.VAPID_PRIVATE_KEY = "";

const { db, sqlite } = await import("./db/index.ts");
const s = await import("./db/schema.ts");
const setup = await import("./setup.ts");
const d = await import("./dispatch.ts");
const n = await import("./crew-name.ts");
const { createSession } = await import("./auth.ts");
const { adminRouter } = await import("./routers/admin.ts");
const { driverRouter } = await import("./routers/driver.ts");
const { createSharedArea } = await import("./routers/plan/areas.ts");
const { eq } = await import("drizzle-orm");

afterAll(() => {
  d.cancelScheduledRoutes();
  rmSync(dir, { recursive: true, force: true });
});

// #region fixture
const CC = { lat: 42.3786, lng: -82.9911 };
const box = (lat: number, lng: number): AreaPolygon => {
  const k = 0.001;
  return { type: "Polygon", coordinates: [[[lng - k, lat - k], [lng + k, lat - k], [lng + k, lat + k], [lng - k, lat + k], [lng - k, lat - k]]] };
};

interface World {
  eventId: number;
  day1: number;
  day2: number;
  cc1: number;
  cc2: number;
  gm: number;
  rocket: number;
  hfh: number;
}

let w: World;
beforeEach(() => {
  d.cancelScheduledRoutes();
  db.delete(s.events).run();
  const ev = setup.createEvent({ name: "Names", year: 2026, startDate: "2026-09-28", dayCount: 2, active: true });
  const [a, b] = db.select().from(s.days).where(eq(s.days.eventId, ev.id)).orderBy(s.days.sort).all();
  const company = (name: string, short: string | null) => db.insert(s.companies).values({ eventId: ev.id, name, short }).returning().get().id;
  w = {
    eventId: ev.id,
    day1: a!.id,
    day2: b!.id,
    cc1: setup.createCc({ dayId: a!.id, name: "Webb", ...CC, letter: "B" }).id,
    cc2: setup.createCc({ dayId: b!.id, name: "Webb", ...CC }).id,
    gm: company("General Motors", "GM"),
    rocket: company("Rocket", "ROCKET"),
    hfh: company("Henry Ford Health", null),
  };
});

const admin = () => adminRouter.createCaller({ session: createSession({ role: "admin" }), ip: "test", ccOverride: null });
const crew = (companyId: number | null, dayId = w.day1, ccId = w.cc1) => setup.createCrew({ dayId, ccId, companyId });
const nameOf = (id: number) => db.select().from(s.crews).where(eq(s.crews.id, id)).get()!.name;
// #endregion

describe("the naming rule", () => {
  test("company short, else the first word of the company name, else Crew and the crew number", () => {
    expect(n.crewName({ name: "General Motors", short: "GM" }, 2, 9)).toBe("GM 2");
    expect(n.crewName({ name: "Henry Ford Health", short: null }, 1, 4)).toBe("Henry 1");
    expect(n.crewName({ name: "  Rocket  Mortgage ", short: "  " }, 3, 4)).toBe("Rocket 3");
    expect(n.crewName(null, 0, 7)).toBe("Crew 7");
  });

  test("new crews count up per company per day; crews without a company take their number", () => {
    const made = [crew(w.rocket), crew(w.gm), crew(null), crew(w.gm), crew(w.hfh), crew(w.gm, w.day2, w.cc2)];
    expect(made.map((c) => c.name)).toEqual(["ROCKET 1", "GM 1", "Crew 3", "GM 2", "Henry 1", "GM 1"]);
    expect(setup.createCrew({ dayId: w.day1, ccId: w.cc1, companyId: w.gm, name: " Night shift " }).name).toBe("Night shift");
  });

  test("admin edit: a company change renames a rule name, keeps a custom one, and a typed name wins", async () => {
    const a = crew(w.gm);
    const b = crew(w.gm);
    crew(w.rocket);
    await admin().crews.update({ id: a.id, companyId: w.rocket, name: a.name });
    expect(nameOf(a.id)).toBe("ROCKET 2");
    await admin().crews.update({ id: b.id, name: "Porch crew" });
    await admin().crews.update({ id: b.id, companyId: w.rocket, name: "Porch crew" });
    expect(nameOf(b.id)).toBe("Porch crew");
    await admin().crews.update({ id: b.id, name: "" });
    expect(nameOf(b.id)).toBe("ROCKET 3");
    await admin().crews.update({ id: b.id, name: "" });
    expect(nameOf(b.id)).toBe("ROCKET 3");
    await admin().crews.update({ id: b.id, companyId: null });
    expect(nameOf(b.id)).toBe(`Crew ${b.number}`);
    const c = await admin().crews.create({ ccId: w.cc1, companyId: w.hfh, leadPhone: null, name: "" });
    expect(c.name).toBe("Henry 1");
  });

  test("a company's new short renames its rule-named crews; deleting the company leaves Crew n", async () => {
    const a = crew(w.hfh);
    const b = setup.createCrew({ dayId: w.day1, ccId: w.cc1, companyId: w.hfh, name: "Porch crew" });
    await admin().companies.update({ id: w.hfh, name: "Henry Ford Health", short: "HFH" });
    expect([nameOf(a.id), nameOf(b.id)]).toEqual(["HFH 1", "Porch crew"]);
    await admin().companies.delete({ id: w.hfh });
    expect([nameOf(a.id), nameOf(b.id)]).toEqual([`Crew ${a.number}`, "Porch crew"]);
  });
});

describe("migration 0008", () => {
  test("backfills the same names the app gives, from each crew's company", () => {
    // Out of company order on purpose: numbers interleave across companies and days.
    for (const [companyId, dayId, ccId] of [
      [w.rocket, w.day1, w.cc1], [w.gm, w.day1, w.cc1], [null, w.day1, w.cc1], [w.rocket, w.day1, w.cc1], [w.hfh, w.day1, w.cc1],
      [w.gm, w.day1, w.cc1], [w.gm, w.day2, w.cc2], [w.rocket, w.day2, w.cc2], [w.gm, w.day2, w.cc2],
    ] as const) crew(companyId, dayId, ccId);
    const expected = db.select({ id: s.crews.id, name: s.crews.name }).from(s.crews).orderBy(s.crews.id).all();
    expect(expected.map((r) => r.name)).toEqual(["ROCKET 1", "GM 1", "Crew 3", "ROCKET 2", "Henry 1", "GM 2", "GM 1", "ROCKET 1", "GM 2"]);

    // A copy of the database as it stood before 0008: no name column.
    const copy = join(dir, "before-0008.db");
    sqlite.exec(`VACUUM INTO '${copy}'`);
    const old = new Database(copy);
    old.exec("ALTER TABLE crews DROP COLUMN name");
    const folder = new URL("./db/migrations", import.meta.url).pathname;
    const file = readdirSync(folder).find((f) => f.startsWith("0008_"))!;
    for (const stmt of readFileSync(join(folder, file), "utf8").split("--> statement-breakpoint")) old.exec(stmt);
    const got = old.query<{ id: number; name: string }, []>("SELECT id, name FROM crews ORDER BY id").all();
    old.close();
    expect(got).toEqual(expected);
  });
});

describe("driver map", () => {
  test("crew dots carry the same names as the rectangle labels", async () => {
    const rockets = [crew(w.rocket), crew(w.rocket)];
    const gms = [crew(w.gm), crew(w.gm), crew(w.gm)];
    createSharedArea(db, { eventId: w.eventId, dayId: w.day1, crewIds: [rockets[0]!.id], polygon: box(CC.lat + 0.004, CC.lng) });
    createSharedArea(db, { eventId: w.eventId, dayId: w.day1, crewIds: gms.map((c) => c.id), polygon: box(CC.lat - 0.004, CC.lng) });
    const truck = setup.createTruck({ dayId: w.day1, ccId: w.cc1, name: "Truck B1" });
    const driver = driverRouter.createCaller({ session: createSession({ role: "driver", truckId: truck.id, ccId: w.cc1, displayName: "Dana" }), ip: "test", ccOverride: null });
    const dots = await driver.crews();
    const { areas } = await driver.lots();
    expect(dots.map((c) => c.name)).toEqual(["ROCKET 1", "ROCKET 2", "GM 1", "GM 2", "GM 3"]);
    expect(areas.map((a) => a.label).sort()).toEqual(["GM 1, GM 2 & GM 3", "ROCKET 1"]);
    const byId = new Map(dots.map((c) => [c.id, c.name]));
    for (const a of areas) {
      const names = a.crewIds.map((id) => byId.get(id) ?? "");
      expect(a.label.startsWith(names[0]!)).toBe(true);
      for (const name of names) expect(a.label).toContain(name);
    }
  });
});
