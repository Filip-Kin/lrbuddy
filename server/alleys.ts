/**
 * Alleys as work units (SPEC 19). OpenStreetMap ways tagged `highway=service`
 * and `service=alley` in a CC's day area (the one-way bbox: day area padded
 * 300 m), stored per CC as the centreline buffered 3 m each side. A refetch
 * updates the shape and names and keeps the status and crew. Fails soft.
 */
import { and, eq, inArray, isNull, notInArray } from "drizzle-orm";
import { db } from "./db/index.ts";
import { alleys, type Alley, type AlleyStatus, type AreaPolygon, type ParcelRow } from "./db/schema.ts";
import { ccOnewayBBox, isRecord, overpassJson, scopeOf, withRetry, type Fetcher, type RetryOpts } from "./oneway.ts";
import { cachedParcelsInBBox } from "./parcels.ts";
import type { BBox } from "./geo.ts";

// #region constants
/** Half the width of the drawn alley. */
export const ALLEY_HALF_WIDTH_M = 3;
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

/**
 * The line buffered `halfM` metres each side, as a GeoJSON Polygon ([lng, lat]).
 * Corners are mitred (the offset is along the average of the two segment
 * normals, stretched so the edges stay parallel); ends are square.
 */
export const bufferLine = (points: ReadonlyArray<readonly [number, number]>, halfM = ALLEY_HALF_WIDTH_M): AreaPolygon => {
  const lat0 = points.reduce((n, p) => n + p[0], 0) / points.length;
  const kx = M_PER_DEG * Math.cos((lat0 * Math.PI) / 180);
  const xy = points.map((p) => ({ x: p[1] * kx, y: p[0] * M_PER_DEG })).filter((p, i, a) => i === 0 || Math.hypot(p.x - a[i - 1]!.x, p.y - a[i - 1]!.y) > 0);
  const normals: Array<{ x: number; y: number }> = [];
  for (let i = 1; i < xy.length; i++) {
    const dx = xy[i]!.x - xy[i - 1]!.x;
    const dy = xy[i]!.y - xy[i - 1]!.y;
    const len = Math.hypot(dx, dy);
    normals.push({ x: -dy / len, y: dx / len });
  }
  const left: Array<{ x: number; y: number }> = [];
  const right: Array<{ x: number; y: number }> = [];
  xy.forEach((p, i) => {
    const a = normals[Math.max(0, i - 1)]!;
    const b = normals[Math.min(normals.length - 1, i)]!;
    let nx = a.x + b.x;
    let ny = a.y + b.y;
    const nl = Math.hypot(nx, ny);
    // A U-turn has no average normal: fall back to the incoming one.
    if (nl < 1e-9) {
      nx = a.x;
      ny = a.y;
    } else {
      nx /= nl;
      ny /= nl;
    }
    const cos = Math.max(0.25, nx * a.x + ny * a.y);
    const d = halfM / cos;
    left.push({ x: p.x + nx * d, y: p.y + ny * d });
    right.push({ x: p.x - nx * d, y: p.y - ny * d });
  });
  const ring = [...left, ...right.reverse()].map((p) => [p.x / kx, p.y / M_PER_DEG]);
  if (ring.length > 0) ring.push([...ring[0]!]);
  return { type: "Polygon", coordinates: [ring] };
};

const title = (s: string): string => s.toLowerCase().replace(/\b([a-z])/g, (c) => c.toUpperCase());

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
    betweenStreet1: leftStreet ? title(leftStreet) : null,
    betweenStreet2: rightStreet && rightStreet !== leftStreet ? title(rightStreet) : null,
    fromCross: from ? title(from) : null,
    toCross: to ? title(to) : null,
  };
};
// #endregion

// #region fetch and store
export interface AlleyLoad {
  alleys: number;
  error: string | null;
}

/**
 * Fetches the CC's alleys and upserts them on (cc, OSM way). Alleys gone from
 * OSM go too when nobody touched them (still open, no crew). Never throws.
 */
export const loadAlleysForCc = async (ccId: number, opts: { fetcher?: Fetcher; timeoutMs?: number; now?: number } & RetryOpts = {}): Promise<AlleyLoad> => {
  const scope = scopeOf(ccId);
  if (!scope) return { alleys: 0, error: "Command center not found" };
  const box = ccOnewayBBox(scope.cc, scope.day);
  const r = await withRetry(async () => parseAlleys(await overpassJson(alleyQuery(box), opts)), opts);
  if (!r.ok) return { alleys: db.select({ id: alleys.id }).from(alleys).where(eq(alleys.ccId, ccId)).all().length, error: r.error };
  const now = opts.now ?? Date.now();
  const parcels = cachedParcelsInBBox(box, 50_000);
  db.transaction((tx) => {
    for (const w of r.value) {
      const names = alleyNames(w.points, parcels);
      const shape = { polygon: bufferLine(w.points), centerline: w.points, ...names, fetchedAt: now };
      tx.insert(alleys)
        .values({ eventId: scope.day.eventId, dayId: scope.day.id, ccId, osmId: w.osmId, ...shape })
        .onConflictDoUpdate({ target: [alleys.ccId, alleys.osmId], set: shape })
        .run();
    }
    // Gone from OSM: removed when untouched; one with a status or a crew stays.
    const kept = r.value.map((w) => w.osmId);
    tx.delete(alleys)
      .where(and(eq(alleys.ccId, ccId), eq(alleys.status, "open"), isNull(alleys.crewId), kept.length ? notInArray(alleys.osmId, kept) : undefined))
      .run();
  });
  return { alleys: db.select({ id: alleys.id }).from(alleys).where(eq(alleys.ccId, ccId)).all().length, error: null };
};
// #endregion

// #region read and write
export interface AlleyView {
  id: number;
  ccId: number;
  polygon: AreaPolygon;
  status: AlleyStatus;
  crewId: number | null;
  /** "Alley, Webb St and Burlingame St" or "Alley" when the parcels did not say. */
  label: string;
  /** "Dexter Ave to Wildemere St" or null. */
  span: string | null;
}

export const alleyView = (a: Alley): AlleyView => {
  const streets = [a.betweenStreet1, a.betweenStreet2].filter((s): s is string => !!s);
  return {
    id: a.id,
    ccId: a.ccId,
    polygon: a.polygon,
    status: a.status,
    crewId: a.crewId,
    label: streets.length ? `Alley, ${streets.join(" and ")}` : "Alley",
    span: a.fromCross && a.toCross ? `${a.fromCross} to ${a.toCross}` : null,
  };
};

/** Alleys of these CCs. */
export const alleysOf = (ccIds: readonly number[]): AlleyView[] =>
  ccIds.length === 0 ? [] : db.select().from(alleys).where(inArray(alleys.ccId, [...ccIds])).orderBy(alleys.id).all().map(alleyView);

export const setAlleyStatus = (id: number, status: AlleyStatus, now = Date.now()): AlleyView | null => {
  const row = db.update(alleys).set({ status, statusAt: now }).where(eq(alleys.id, id)).returning().get();
  return row ? alleyView(row) : null;
};

export const alleyById = (id: number): Alley | null => db.select().from(alleys).where(eq(alleys.id, id)).get() ?? null;
// #endregion
