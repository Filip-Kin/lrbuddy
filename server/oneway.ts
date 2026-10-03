/**
 * One-way streets for the maps (SPEC 20). Pulls `highway=*` ways tagged
 * `oneway=yes` or `oneway=-1` from Overpass for a CC's day area, padded 300 m,
 * and caches them per bbox in `oneway_ways`. Every failure is soft: the maps
 * just show no arrows.
 *
 * Overpass needs a form-encoded body (a raw POST from Bun gets 406) and a
 * contactable User-Agent, and the query ends in `out geom;` (reuse index).
 */
import { and, eq, gte, lte } from "drizzle-orm";
import { db } from "./db/index.ts";
import { commandCenters, days, onewayWays, type CommandCenter, type Day } from "./db/schema.ts";
import { bboxAround, bboxOf, padBBox, type BBox, type LatLng } from "./geo.ts";
import { lotsAt } from "./queries.ts";
import { dayAreas } from "./routers/plan/areas.ts";

// #region constants
export const ONEWAY_PAD_M = 300;
/** A CC with no areas and no lots: this far round the CC, before the pad. */
const BARE_CC_M = 500;
const TIMEOUT_MS = 20_000;
/** A cached bbox younger than this is not fetched again unless forced. */
const FRESH_MS = 7 * 24 * 3600_000;
/** Placing or moving a CC, or drawing an area, often comes in bursts. */
const DEBOUNCE_MS = 5_000;
const USER_AGENT = "lrbuddy/1.0 (me@filipkin.com)";
const overpassUrl = (): string => {
  const v = process.env.OVERPASS_URL?.trim();
  return v && v !== "" ? v : "https://overpass-api.de/api/interpreter";
};
// #endregion

// #region parse
export interface OnewayInput {
  osmId: number;
  /** [[lat, lng], ...] in node order. */
  points: Array<[number, number]>;
  /** 1 along the node order, -1 against it. */
  direction: 1 | -1;
  name: string | null;
}

/** Ways no truck drives on; a one-way cycle track would only mislead a driver. */
const NOT_FOR_TRUCKS = new Set(["footway", "cycleway", "path", "pedestrian", "steps", "bridleway", "corridor"]);

export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** `oneway` tag to a direction, or null for a two-way or unknown value. */
export const onewayDirection = (tag: unknown): 1 | -1 | null => {
  if (typeof tag !== "string") return null;
  const v = tag.trim().toLowerCase();
  if (v === "yes" || v === "true" || v === "1") return 1;
  if (v === "-1" || v === "reverse") return -1;
  return null;
};

/** Ways from an Overpass `out geom;` answer that are one-way roads with at least two points. */
export const parseOverpass = (json: unknown): OnewayInput[] => {
  if (!isRecord(json) || !Array.isArray(json.elements)) return [];
  const out: OnewayInput[] = [];
  for (const el of json.elements) {
    if (!isRecord(el) || el.type !== "way" || typeof el.id !== "number") continue;
    const tags = isRecord(el.tags) ? el.tags : {};
    if (typeof tags.highway !== "string" || NOT_FOR_TRUCKS.has(tags.highway)) continue;
    const direction = onewayDirection(tags.oneway);
    if (direction === null || !Array.isArray(el.geometry)) continue;
    const points: Array<[number, number]> = [];
    for (const g of el.geometry) {
      if (isRecord(g) && typeof g.lat === "number" && typeof g.lon === "number") points.push([g.lat, g.lon]);
    }
    if (points.length < 2) continue;
    out.push({ osmId: el.id, points, direction, name: typeof tags.name === "string" ? tags.name : null });
  }
  return out;
};

/** Overpass QL for one-way roads in a bbox ([w, s, e, n]); Overpass wants (s, w, n, e). */
export const onewayQuery = (b: BBox): string => {
  const [w, s, e, n] = b.map((x) => x.toFixed(5));
  return `[out:json][timeout:25];way["highway"]["oneway"~"^(yes|true|1|-1|reverse)$"](${s},${w},${n},${e});out geom;`;
};
// #endregion

// #region bbox
/** Cache key of a bbox, rounded to about 10 m so a nudge of the same area hits the same key. */
export const bboxKey = (b: BBox): string => b.map((x) => x.toFixed(4)).join(",");

/**
 * The CC's day area, padded 300 m: its crew areas that day, else its lots,
 * else 500 m round the CC. The CC itself is always inside.
 */
export const ccOnewayBBox = (cc: CommandCenter, day: Day): BBox => {
  const pts: LatLng[] = [{ lat: cc.lat, lng: cc.lng }];
  const areas = dayAreas(day.id).filter((a) => a.ccId === cc.id && a.polygon);
  for (const a of areas) for (const ring of a.polygon?.coordinates ?? []) for (const p of ring) if (p.length >= 2) pts.push({ lng: p[0]!, lat: p[1]! });
  if (areas.length === 0) for (const l of lotsAt(cc.id, day.id)) pts.push({ lat: l.lat, lng: l.lng });
  const box = pts.length > 1 ? bboxOf(pts)! : bboxAround(cc, BARE_CC_M);
  return padBBox(box, ONEWAY_PAD_M);
};
// #endregion

// #region fetch and cache
export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

/** One Overpass query, form-encoded, with a contactable agent. Throws on a non-2xx answer. */
export const overpassJson = async (query: string, opts: { fetcher?: Fetcher; timeoutMs?: number } = {}): Promise<unknown> => {
  const doFetch: Fetcher = opts.fetcher ?? ((url, init) => fetch(url, init));
  const res = await doFetch(overpassUrl(), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json", "user-agent": USER_AGENT },
    body: new URLSearchParams({ data: query }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Overpass ${res.status}`);
  return res.json();
};

export const fetchOneway = async (b: BBox, opts: { fetcher?: Fetcher; timeoutMs?: number } = {}): Promise<OnewayInput[]> =>
  parseOverpass(await overpassJson(onewayQuery(b), opts));

/** Replaces the rows of one bbox key with these ways. */
export const storeOneway = (key: string, ways: readonly OnewayInput[], now = Date.now()): void => {
  db.transaction((tx) => {
    tx.delete(onewayWays).where(eq(onewayWays.bboxKey, key)).run();
    for (const w of ways) {
      const lats = w.points.map((p) => p[0]);
      const lngs = w.points.map((p) => p[1]);
      tx.insert(onewayWays)
        .values({
          bboxKey: key,
          osmId: w.osmId,
          geometry: w.points,
          direction: w.direction,
          name: w.name,
          minLat: Math.min(...lats),
          maxLat: Math.max(...lats),
          minLng: Math.min(...lngs),
          maxLng: Math.max(...lngs),
          fetchedAt: now,
        })
        .run();
    }
  });
};

export interface RetryOpts {
  retries?: number;
  retryDelayMs?: number;
}

/** The public Overpass answers 429 and 504 when busy; one more try a moment later usually gets through. */
export const withRetry = async <T>(run: () => Promise<T>, opts: RetryOpts = {}): Promise<{ ok: true; value: T } | { ok: false; error: string }> => {
  let error = "";
  for (let attempt = 0; attempt <= (opts.retries ?? 1); attempt++) {
    if (attempt > 0) await Bun.sleep(opts.retryDelayMs ?? 5_000);
    try {
      return { ok: true, value: await run() };
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }
  return { ok: false, error };
};

export interface OnewayLoad {
  key: string;
  ways: number;
  cached: boolean;
  /** Set when Overpass failed; the cache is left as it was. */
  error: string | null;
}

export const scopeOf = (ccId: number): { cc: CommandCenter; day: Day } | null => {
  const cc = db.select().from(commandCenters).where(eq(commandCenters.id, ccId)).get();
  const day = cc ? db.select().from(days).where(eq(days.id, cc.dayId)).get() : undefined;
  return cc && day ? { cc, day } : null;
};

/** Fetches the CC's one-way streets unless the bbox is cached and fresh. Never throws. */
export const loadOnewayForCc = async (
  ccId: number,
  opts: { force?: boolean; fetcher?: Fetcher; timeoutMs?: number; now?: number } & RetryOpts = {},
): Promise<OnewayLoad> => {
  const scope = scopeOf(ccId);
  if (!scope) return { key: "", ways: 0, cached: false, error: "Command center not found" };
  const box = ccOnewayBBox(scope.cc, scope.day);
  const key = bboxKey(box);
  const now = opts.now ?? Date.now();
  const have = db.select({ osmId: onewayWays.osmId, fetchedAt: onewayWays.fetchedAt }).from(onewayWays).where(eq(onewayWays.bboxKey, key)).all();
  if (!opts.force && have.length > 0 && have.every((w) => now - w.fetchedAt < FRESH_MS)) return { key, ways: have.length, cached: true, error: null };
  const r = await withRetry(() => fetchOneway(box, opts), opts);
  if (!r.ok) return { key, ways: have.length, cached: have.length > 0, error: r.error };
  storeOneway(key, r.value, now);
  return { key, ways: r.value.length, cached: false, error: null };
};

const pending = new Map<number, ReturnType<typeof setTimeout>>();

/**
 * Fetches a CC's one-way streets and alleys a few seconds from now, once per
 * burst of changes. Off under `bun test` and with OVERPASS_URL=off.
 */
export const scheduleOneway = (ccId: number): void => {
  if (process.env.NODE_ENV === "test" || process.env.OVERPASS_URL?.trim() === "off") return;
  const t = pending.get(ccId);
  if (t) clearTimeout(t);
  pending.set(
    ccId,
    setTimeout(() => {
      pending.delete(ccId);
      void (async () => {
        const r = await loadOnewayForCc(ccId);
        if (r.error) console.warn(`[oneway] CC ${ccId}: ${r.error}`);
        // Alleys share the CC's bbox (SPEC 19); imported here, not at the top, since alleys.ts reads this module.
        const { loadAlleysForCc } = await import("./alleys.ts");
        const a = await loadAlleysForCc(ccId);
        if (a.error) console.warn(`[alleys] CC ${ccId}: ${a.error}`);
      })();
    }, DEBOUNCE_MS),
  );
};

const lastTry = new Map<number, number>();
const RETRY_MS = 10 * 60_000;

/**
 * Called by the map queries: a CC whose bbox has no one-way rows yet (a day loaded by hand, a
 * fetch that failed) schedules the fetch, at most once per 10 minutes per CC. Filip, 2026-10-03:
 * Day 6 had no arrows east of Webb's old box because nothing ever fetched it.
 */
export const ensureOneway = (cc: CommandCenter, day: Day, now = Date.now()): void => {
  if (now - (lastTry.get(cc.id) ?? 0) < RETRY_MS) return;
  const key = bboxKey(ccOnewayBBox(cc, day));
  if (db.select({ id: onewayWays.id }).from(onewayWays).where(eq(onewayWays.bboxKey, key)).limit(1).get()) return;
  lastTry.set(cc.id, now);
  scheduleOneway(cc.id);
};

/** Every CC of a day, after its crew areas changed. */
export const scheduleOnewayForDay = (dayId: number): void => {
  for (const cc of db.select({ id: commandCenters.id }).from(commandCenters).where(eq(commandCenters.dayId, dayId)).all()) scheduleOneway(cc.id);
};

/** Every CC of the days these crews work, after their areas changed. */
export const scheduleOnewayForDays = (dayIds: readonly number[]): void => {
  for (const d of new Set(dayIds)) scheduleOnewayForDay(d);
};
// #endregion

// #region read
export interface OnewayView {
  id: number;
  points: Array<[number, number]>;
  direction: 1 | -1;
  name: string | null;
}

/** Cached one-way ways that touch a bbox, once each however many keys hold them. */
export const onewayInBBox = (b: BBox, limit = 3000): OnewayView[] => {
  const [w, s, e, n] = b;
  const rows = db
    .select()
    .from(onewayWays)
    .where(and(lte(onewayWays.minLat, n), gte(onewayWays.maxLat, s), lte(onewayWays.minLng, e), gte(onewayWays.maxLng, w)))
    .orderBy(onewayWays.osmId, onewayWays.fetchedAt)
    .all();
  const byId = new Map<number, OnewayView>();
  // Newest fetch of a way wins: rows come oldest first per way.
  for (const r of rows) byId.set(r.osmId, { id: r.osmId, points: r.geometry, direction: r.direction === -1 ? -1 : 1, name: r.name });
  return [...byId.values()].slice(0, limit);
};

// #endregion

// #region cli: bun run oneway <ccId> (one-way streets, then alleys)
if (import.meta.main) {
  const ccId = Number(process.argv[2]);
  if (!Number.isInteger(ccId) || ccId <= 0) {
    console.error("Usage: bun run oneway <ccId>");
    process.exit(2);
  }
  const r = await loadOnewayForCc(ccId, { force: true });
  if (r.error) console.error(`[oneway] CC ${ccId}: ${r.error}${r.cached ? `, ${r.ways} cached ways kept` : ""}`);
  else console.log(`[oneway] CC ${ccId}: ${r.ways} one-way ways (${r.key})`);
  const { loadAlleysForCc } = await import("./alleys.ts");
  const a = await loadAlleysForCc(ccId);
  if (a.error) console.error(`[alleys] CC ${ccId}: ${a.error}`);
  else console.log(`[alleys] CC ${ccId}: ${a.alleys} alleys`);
  process.exit(r.error || a.error ? 1 : 0);
}
// #endregion
