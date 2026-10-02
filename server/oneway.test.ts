import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Fetcher } from "./oneway.ts";

const dir = mkdtempSync(join(tmpdir(), "lrbuddy-oneway-test-"));
process.env.DATA_DIR = dir;
process.env.SESSION_SECRET ??= "test-secret";
process.env.OSRM_URL = "off";

const { db } = await import("./db/index.ts");
const s = await import("./db/schema.ts");
const o = await import("./oneway.ts");
const setup = await import("./setup.ts");
const { eq } = await import("drizzle-orm");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const fixture = readFileSync(join(import.meta.dir, "fixtures/overpass-oneway.json"), "utf8");
const ok = (): Fetcher => async () => new Response(fixture, { status: 200, headers: { "content-type": "application/json" } });

describe("Overpass one-way parse", () => {
  test("keeps one-way roads, reads -1 as reverse, drops two-way, footways and nodes", () => {
    const ways = o.parseOverpass(JSON.parse(fixture));
    expect(ways.map((w) => [w.osmId, w.direction])).toEqual([
      [8741718, 1],
      [8745637, 1],
      [900000001, -1],
    ]);
    expect(ways[1]!.name).toBe("Webb Street");
    expect(ways[1]!.points[0]).toEqual([42.3844748, -83.1105918]);
    expect(o.parseOverpass({ nope: true })).toEqual([]);
  });

  test("query is (s, w, n, e) and ends in out geom;", () => {
    const q = o.onewayQuery([-83.126, 42.373, -83.11, 42.385]);
    expect(q).toContain("(42.37300,-83.12600,42.38500,-83.11000)");
    expect(q.endsWith("out geom;")).toBe(true);
  });
});

describe("one-way cache", () => {
  const world = () => {
    db.delete(s.events).run();
    db.delete(s.onewayWays).run();
    const ev = setup.createEvent({ name: "Oneway", year: 2026, startDate: "2026-10-01", dayCount: 1, active: true });
    const day = db.select().from(s.days).where(eq(s.days.eventId, ev.id)).get()!;
    return setup.createCc({ dayId: day.id, name: "Webb", lat: 42.38052, lng: -83.12056, address: "3201 Webb St" });
  };

  test("a CC's bbox is fetched with a form body and a contactable agent, then cached", async () => {
    const cc = world();
    let calls = 0;
    let body = "";
    let agent = "";
    const fetcher: Fetcher = async (url, init) => {
      calls++;
      body = String(init.body);
      agent = new Headers(init.headers).get("user-agent") ?? "";
      return ok()(url, init);
    };
    const first = await o.loadOnewayForCc(cc.id, { fetcher });
    expect(first).toMatchObject({ ways: 3, cached: false, error: null });
    expect(body.startsWith("data=")).toBe(true);
    expect(agent).toContain("me@filipkin.com");
    const again = await o.loadOnewayForCc(cc.id, { fetcher });
    expect(again).toMatchObject({ ways: 3, cached: true });
    expect(calls).toBe(1);
    // The CC's padded box holds Webb St; a box far away holds nothing.
    expect(o.onewayInBBox([-83.112, 42.384, -83.105, 42.387]).map((w) => w.id).sort()).toEqual([8741718, 8745637, 900000001]);
    expect(o.onewayInBBox([-83.0, 42.0, -82.99, 42.01])).toEqual([]);
  });

  test("Overpass down: no throw, the cache stays as it was", async () => {
    const cc = world();
    await o.loadOnewayForCc(cc.id, { fetcher: ok() });
    const down: Fetcher = async () => new Response("busy", { status: 504 });
    const r = await o.loadOnewayForCc(cc.id, { fetcher: down, force: true, retries: 0 });
    expect(r.error).toBe("Overpass 504");
    expect(r.ways).toBe(3);
    const thrown: Fetcher = async () => {
      throw new Error("offline");
    };
    expect((await o.loadOnewayForCc(cc.id, { fetcher: thrown, force: true, retryDelayMs: 1 })).error).toBe("offline");
    expect(db.select().from(s.onewayWays).all()).toHaveLength(3);
  });

  test("a CC with no areas or lots fetches about 800 m round it", () => {
    const cc = world();
    const day = db.select().from(s.days).where(eq(s.days.id, cc.dayId)).get()!;
    const [w, south, e, n] = o.ccOnewayBBox(cc, day);
    expect((n - south) * 111320).toBeGreaterThan(1500);
    expect((n - south) * 111320).toBeLessThan(1700);
    expect(w).toBeLessThan(cc.lng);
    expect(e).toBeGreaterThan(cc.lng);
  });
});
