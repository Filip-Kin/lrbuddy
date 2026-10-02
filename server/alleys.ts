/**
 * OpenStreetMap alleys as a hint (SPEC 24). Ways tagged `highway=service` and
 * `service=alley` in a CC's day area (the one-way bbox: day area padded 300 m),
 * cached per way as the centreline. No status and no crew: work in an alley is
 * a drawn lot. Fails soft. `streetsBeside` names a drawn lot from the parcels
 * on each side of it.
 */
import { and, gte, lte } from "drizzle-orm";
import { db } from "./db/index.ts";
import { osmAlleys, type ParcelRow } from "./db/schema.ts";
import { titleCase } from "./lots-import.ts";
import { ccOnewayBBox, isRecord, overpassJson, scopeOf, withRetry, type Fetcher, type RetryOpts } from "./oneway.ts";
import type { BBox } from "./geo.ts";

// #region constants
/** Parcels this close to the alley's middle name its streets and cross streets. */
const NAME_RADIUS_M = 80;
const M_PER_DEG = 111320;
// #endregion

// #region parse and shape
export interface AlleyInput {
  osmId: number;
  /** [[lat, lng], ...] in node order. */
  points: Array<[number, number]>;
}

/** Alley ways from an Overpass `out geom;` answer, at least two points each. */
export const parseAlleys = (json: unknown): AlleyInput[] => {
  if (!isRecord(json) || !Array.isArray(json.elements)) return [];
  const out: AlleyInput[] = [];
  for (const el of json.elements) {
    if (!isRecord(el) || el.type !== "way" || typeof el.id !== "number" || !Array.isArray(el.geometry)) continue;
    const tags = isRecord(el.tags) ? el.tags : {};
    if (tags.highway !== "service" || tags.service !== "alley") continue;
    const points: Array<[number, number]> = [];
    for (const g of el.geometry) if (isRecord(g) && typeof g.lat === "number" && typeof g.lon === "number") points.push([g.lat, g.lon]);
    if (points.length >= 2) out.push({ osmId: el.id, points });
  }
  return out;
};

export const alleyQuery = (b: BBox): string => {
  const [w, s, e, n] = b.map((x) => x.toFixed(5));
  return `[out:json][timeout:25];way["highway"="service"]["service"="alley"](${s},${w},${n},${e});out geom;`;
};

const mostCommon = (values: ReadonlyArray<string | null | undefined>): string | null => {
  const counts = new Map<string, number>();
  for (const v of values) {
    const t = v?.trim();
    if (t) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  let best: string | null = null;
  let n = 0;
  for (const [k, c] of counts) if (c > n) [best, n] = [k, c];
  return best;
};

export interface AlleyNames {
  betweenStreet1: string | null;
  betweenStreet2: string | null;
  fromCross: string | null;
  toCross: string | null;
}

/**
 * Best effort: the streets of the parcels backing onto the alley on each side
 * (left of the drawing first), and the cross streets most of them carry,
 * sorted. Null where the cached parcels do not say.
 */
export const alleyNames = (points: ReadonlyArray<readonly [number, number]>, parcels: ReadonlyArray<Pick<ParcelRow, "lat" | "lng" | "streetName" | "crossStreet1" | "crossStreet2">>): AlleyNames => {
  const a = points[0]!;
  const b = points[points.length - 1]!;
  const mid = { lat: (a[0] + b[0]) / 2, lng: (a[1] + b[1]) / 2 };
  const kx = M_PER_DEG * Math.cos((mid.lat * Math.PI) / 180);
  const dx = (b[1] - a[1]) * kx;
  const dy = (b[0] - a[0]) * M_PER_DEG;
  const near = parcels.filter((p) => Math.hypot((p.lng - mid.lng) * kx, (p.lat - mid.lat) * M_PER_DEG) <= NAME_RADIUS_M);
  const side = (p: { lat: number; lng: number }): number => Math.sign(dx * ((p.lat - a[0]) * M_PER_DEG) - dy * ((p.lng - a[1]) * kx));
  const leftStreet = mostCommon(near.filter((p) => side(p) > 0).map((p) => p.streetName));
  const rightStreet = mostCommon(near.filter((p) => side(p) < 0).map((p) => p.streetName));
  const crosses = mostCommon(
    near.map((p) => {
      const pair = [p.crossStreet1, p.crossStreet2].map((c) => c?.trim() ?? "").filter((c) => c !== "");
      return pair.length === 2 ? pair.sort().join("|") : null;
    }),
  );
  const [from, to] = crosses ? crosses.split("|") : [null, null];
  return {
    betweenStreet1: leftStreet ? titleCase(leftStreet) : null,
    betweenStreet2: rightStreet && rightStreet !== leftStreet ? titleCase(rightStreet) : null,
    fromCross: from ? titleCase(from) : null,
    toCross: to ? titleCase(to) : null,
  };
};
// #endregion

// #region fetch and store
export interface AlleyLoad {
  alleys: number;
  error: string | null;
}

const boundsOf = (pts: ReadonlyArray<readonly [number, number]>) => ({
  minLat: Math.min(...pts.map((p) => p[0])),
  maxLat: Math.max(...pts.map((p) => p[0])),
  minLng: Math.min(...pts.map((p) => p[1])),
  maxLng: Math.max(...pts.map((p) => p[1])),
});

/** Fetches the alleys round a CC's day area and upserts them by OSM way. Never throws; Overpass down keeps the cache. */
export const loadAlleysForCc = async (ccId: number, opts: { fetcher?: Fetcher; timeoutMs?: number; now?: number } & RetryOpts = {}): Promise<AlleyLoad> => {
  const scope = scopeOf(ccId);
  if (!scope) return { alleys: 0, error: "Command center not found" };
  const box = ccOnewayBBox(scope.cc, scope.day);
  const r = await withRetry(async () => parseAlleys(await overpassJson(alleyQuery(box), opts)), opts);
  if (!r.ok) return { alleys: alleysIn(box).length, error: r.error };
  const now = opts.now ?? Date.now();
  db.transaction((tx) => {
    for (const w of r.value) {
      const row = { centerline: w.points, ...boundsOf(w.points), fetchedAt: now };
      tx.insert(osmAlleys)
        .values({ osmId: w.osmId, ...row })
        .onConflictDoUpdate({ target: osmAlleys.osmId, set: row })
        .run();
    }
  });
  return { alleys: alleysIn(box).length, error: null };
};
// #endregion

// #region read
export interface AlleyLine {
  id: number;
  /** [[lat, lng], ...] */
  centerline: Array<[number, number]>;
}

/** Cached alley centrelines touching the box [west, south, east, north]. */
export const alleysIn = (b: BBox): AlleyLine[] =>
  db
    .select({ id: osmAlleys.id, centerline: osmAlleys.centerline })
    .from(osmAlleys)
    .where(and(lte(osmAlleys.minLat, b[3]), gte(osmAlleys.maxLat, b[1]), lte(osmAlleys.minLng, b[2]), gte(osmAlleys.maxLng, b[0])))
    .all();
// #endregion
