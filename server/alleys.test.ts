import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Fetcher } from "./oneway.ts";

const dir = mkdtempSync(join(tmpdir(), "lrbuddy-alleys-test-"));
process.env.DATA_DIR = dir;
process.env.SESSION_SECRET ??= "test-secret";
process.env.ADMIN_PASSWORD ??= "test-admin";
process.env.OSRM_URL = "off";

const { db } = await import("./db/index.ts");
const s = await import("./db/schema.ts");
const a = await import("./alleys.ts");
const setup = await import("./setup.ts");
const { createSession } = await import("./auth.ts");
const { alleysRouter } = await import("./routers/alleys.ts");
const { eq } = await import("drizzle-orm");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const fixture = readFileSync(join(import.meta.dir, "fixtures/overpass-alleys.json"), "utf8");
const ok: Fetcher = async () => new Response(fixture, { status: 200, headers: { "content-type": "application/json" } });
const M = 111320;

describe("alley shapes", () => {
  test("parse keeps alleys only", () => {
    expect(a.parseAlleys(JSON.parse(fixture)).map((x) => x.osmId)).toEqual([558673969, 558673970, 558673971]);
    expect(a.alleyQuery([-83.126, 42.373, -83.11, 42.385])).toContain('way["highway"="service"]["service"="alley"](42.37300,-83.12600,42.38500,-83.11000);out geom;');
  });

  test("a straight alley buffers to a 6 m wide box around it", () => {
    const line: Array<[number, number]> = [
      [42.38, -83.12],
      [42.38, -83.12 + 100 / (M * Math.cos((42.38 * Math.PI) / 180))],
    ];
    const ring = a.bufferLine(line).coordinates[0]!;
    expect(ring).toHaveLength(5);
    expect(ring[0]).toEqual(ring[4]!);
    const lats = ring.map((p) => p[1]!);
    expect((Math.max(...lats) - Math.min(...lats)) * M).toBeCloseTo(6, 3);
  });

  test("a bent alley keeps 3 m each side at the corner", () => {
    const k = M * Math.cos((42.38 * Math.PI) / 180);
    const line: Array<[number, number]> = [
      [42.38, -83.12],
      [42.38, -83.12 + 50 / k],
      [42.38 + 50 / M, -83.12 + 50 / k],
    ];
    const ring = a.bufferLine(line).coordinates[0]!;
    // Outer corner of a right angle sits 3 m out on both axes.
    const corner = ring[1]!;
    expect((corner[0]! - (-83.12 + 50 / k)) * k).toBeCloseTo(-3, 3);
    expect((corner[1]! - 42.38) * M).toBeCloseTo(3, 3);
  });

  test("names come from the parcels on each side and their cross streets", () => {
    const line: Array<[number, number]> = [
      [42.38, -83.121],
      [42.38, -83.119],
    ];
    const p = (lat: number, street: string) => ({ lat, lng: -83.12, streetName: street, crossStreet1: "LAWTON", crossStreet2: "WILDEMERE" });
    const names = a.alleyNames(line, [p(42.3802, "WEBB"), p(42.3803, "WEBB"), p(42.3798, "BURLINGAME"), p(42.39, "FAR AWAY")]);
    expect(names).toEqual({ betweenStreet1: "Webb", betweenStreet2: "Burlingame", fromCross: "Lawton", toCross: "Wildemere" });
    expect(a.alleyNames(line, [])).toEqual({ betweenStreet1: null, betweenStreet2: null, fromCross: null, toCross: null });
  });
});

describe("alley store and access", () => {
  const world = () => {
    db.delete(s.events).run();
    const ev = setup.createEvent({ name: "Alleys", year: 2026, startDate: "2026-10-01", dayCount: 1, active: true });
    const day = db.select().from(s.days).where(eq(s.days.eventId, ev.id)).get()!;
    const cc = setup.createCc({ dayId: day.id, name: "Webb", lat: 42.38052, lng: -83.12056, address: "3201 Webb St" });
    const other = setup.createCc({ dayId: day.id, name: "East", lat: 42.3786, lng: -82.9911, address: "Anchor" });
    return { cc, other, day };
  };
  const caller = (session: Parameters<typeof createSession>[0]) => alleysRouter.createCaller({ session: createSession(session), ip: "test", ccOverride: null });

  test("a refetch keeps status; Overpass down keeps the rows", async () => {
    const { cc } = world();
    expect(await a.loadAlleysForCc(cc.id, { fetcher: ok })).toEqual({ alleys: 3, error: null });
    const row = db.select().from(s.alleys).where(eq(s.alleys.osmId, 558673969)).get()!;
    a.setAlleyStatus(row.id, "done");
    await a.loadAlleysForCc(cc.id, { fetcher: ok });
    expect(db.select().from(s.alleys).where(eq(s.alleys.id, row.id)).get()!.status).toBe("done");
    const down: Fetcher = async () => new Response("busy", { status: 429 });
    expect(await a.loadAlleysForCc(cc.id, { fetcher: down, retries: 0 })).toEqual({ alleys: 3, error: "Overpass 429" });
  });

  test("greens and drivers at the CC set the status; others cannot", async () => {
    const { cc, other, day } = world();
    await a.loadAlleysForCc(cc.id, { fetcher: ok });
    const id = db.select().from(s.alleys).all()[0]!.id;
    const truck = setup.createTruck({ dayId: day.id, ccId: cc.id, name: "B1" });
    const farTruck = setup.createTruck({ dayId: day.id, ccId: other.id, name: "E1" });
    const crew = setup.createCrew({ dayId: day.id, ccId: cc.id, companyId: null });

    expect((await caller({ role: "green", ccId: cc.id }).setStatus({ id, status: "in_progress" })).status).toBe("in_progress");
    expect((await caller({ role: "driver", truckId: truck.id, ccId: cc.id }).setStatus({ id, status: "do_not_touch" })).status).toBe("do_not_touch");
    expect((await caller({ role: "admin" }).setStatus({ id, status: "done" })).status).toBe("done");
    await expect(caller({ role: "green", ccId: other.id }).setStatus({ id, status: "open" })).rejects.toThrow("Not allowed");
    await expect(caller({ role: "driver", truckId: farTruck.id, ccId: other.id }).setStatus({ id, status: "open" })).rejects.toThrow("Not allowed");
    await expect(caller({ role: "crew", crewId: crew.id, ccId: cc.id }).setStatus({ id, status: "open" })).rejects.toThrow("Not allowed");

    const view = { w: -83.13, s: 42.37, e: -83.11, n: 42.39 };
    expect(await caller({ role: "green", ccId: cc.id }).inView(view)).toHaveLength(3);
    expect(await caller({ role: "green", ccId: other.id }).inView(view)).toHaveLength(0);
    expect(await caller({ role: "admin" }).inView(view)).toHaveLength(3);
    expect(await caller({ role: "admin" }).inView({ w: -83.0, s: 42.0, e: -82.9, n: 42.1 })).toHaveLength(0);
  });
});
