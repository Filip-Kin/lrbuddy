import { describe, expect, test } from "bun:test";
import { cacheKey, invalidateCached, MAX_AGE_MS, pathsForRole, pathsInvalidatedBy, pruneCache, scopeOf, usable, type CacheEntry, type CacheStore } from "./queryCache.ts";

const memory = (): CacheStore & { map: Map<string, CacheEntry> } => {
  const map = new Map<string, CacheEntry>();
  return {
    map,
    get: async (k) => map.get(k),
    set: async (k, e) => void map.set(k, e),
    del: async (k) => void map.delete(k),
    keys: async () => [...map.keys()],
  };
};

const green = { role: "green", ccId: 3, dayId: 4 };
const driver = { role: "driver", ccId: 3, dayId: 4 };

describe("phone query cache", () => {
  test("keys by role, CC and day", () => {
    expect(cacheKey(green, "green.parcels")).toBe("green|3|4|green.parcels");
    expect(cacheKey({ ...green, dayId: 5 }, "green.parcels")).not.toBe(cacheKey(green, "green.parcels"));
    expect(scopeOf({ role: "green", cc: { id: 3 }, day: { id: 4 } })).toEqual(green);
    expect(scopeOf({ role: "admin", cc: null, day: null })).toBeNull();
  });

  test("lot.changed drops every lot list and the parcels, for that CC and day only", async () => {
    const s = memory();
    const e: CacheEntry = { v: "b1", at: Date.now(), data: [] };
    for (const p of pathsForRole("green")) await s.set(cacheKey(green, p), e);
    for (const p of pathsForRole("driver")) await s.set(cacheKey(driver, p), e);
    const other = { ...green, ccId: 9 };
    await s.set(cacheKey(other, "green.parcels"), e);
    await invalidateCached(s, green, "lots");
    await invalidateCached(s, driver, "lots");
    expect(s.map.has(cacheKey(green, "green.parcels"))).toBe(false);
    expect(s.map.has(cacheKey(green, "green.overview"))).toBe(false);
    expect(s.map.has(cacheKey(driver, "driver.lots"))).toBe(false);
    // Lots are not on the driver's route answer, and another CC is untouched.
    expect(s.map.has(cacheKey(driver, "driver.route"))).toBe(true);
    expect(s.map.has(cacheKey(other, "green.parcels"))).toBe(true);
  });

  test("events that do not touch lots keep the parcels", () => {
    for (const k of ["requests", "route", "positions", "stock", "broadcast", "access"] as const) expect(pathsInvalidatedBy(k)).not.toContain("green.parcels");
    expect(pathsInvalidatedBy("all")).toContain("green.parcels");
  });

  test("no scope, nothing dropped", async () => {
    const s = memory();
    await s.set("x", { v: "b1", at: Date.now(), data: 1 });
    await invalidateCached(s, null, "all");
    expect(s.map.size).toBe(1);
  });

  test("another build or an old entry is not used, and is pruned", async () => {
    const now = Date.now();
    const s = memory();
    await s.set("a", { v: "b1", at: now, data: 1 });
    await s.set("b", { v: "b0", at: now, data: 1 });
    await s.set("c", { v: "b1", at: now - MAX_AGE_MS - 1, data: 1 });
    expect(usable(await s.get("a"), "b1", now)).toBe(true);
    expect(usable(await s.get("b"), "b1", now)).toBe(false);
    expect(await pruneCache(s, "b1", now)).toBe(2);
    expect([...s.map.keys()]).toEqual(["a"]);
  });

  test("crews keep nothing", () => {
    expect(pathsForRole("crew")).toEqual([]);
  });
});
