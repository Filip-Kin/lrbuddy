/**
 * Which parcel the phone is standing at and facing (SPEC 22): a ray from the
 * GPS fix along the compass heading, 4 to 30 m ahead, and the first parcel it
 * enters; with no heading, the parcel under the fix or the nearest centre
 * within 25 m. Pure functions on [lng, lat] GeoJSON outlines, in local metres.
 *
 * Alleys (SPEC 22, alleys): standing at the mouth of an alley and pointing the
 * phone down it picks the alley half it points into. The alley wins when the
 * bearing runs along it (within 25 degrees, either way) and the phone is
 * within 15 m of its centreline or its end; otherwise the parcels as above.
 */
import type { LotGeometry } from "../../../../../server/db/schema.ts";

export interface LatLng {
  lat: number;
  lng: number;
}

export interface Candidate extends LatLng {
  key: string;
  geometry: LotGeometry | null;
  /** A drawn lot (SPEC 24): it wins over a parcel when the point is inside both. */
  drawn?: boolean;
}

/** The drawn one of several hits, else the first. */
const preferDrawn = <T extends Candidate>(hits: readonly T[]): T | null => hits.find((c) => c.drawn) ?? hits[0] ?? null;

export const RAY_FROM_M = 4;
export const RAY_TO_M = 30;
export const RAY_STEP_M = 1;
export const NEAREST_M = 25;

const RAD = Math.PI / 180;
const M_LAT = 111_320;

const xyOf = (o: LatLng, lng: number, lat: number): [number, number] => [(lng - o.lng) * M_LAT * Math.cos(o.lat * RAD), (lat - o.lat) * M_LAT];

/** Point inside a ring of [x, y] (ray casting). */
const inRingXY = (x: number, y: number, ring: ReadonlyArray<readonly [number, number]>): boolean => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};

/** The outline's polygons as rings of local metres around `o`: outer ring first, holes after. */
const polygonsXY = (o: LatLng, g: LotGeometry): Array<Array<Array<[number, number]>>> => {
  const polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
  return polys.map((rings) => rings.map((r) => r.map((p) => xyOf(o, p[0] ?? 0, p[1] ?? 0))));
};

/** True when the point (metres from `o`) is inside the outline. */
const insideXY = (polys: ReadonlyArray<ReadonlyArray<ReadonlyArray<readonly [number, number]>>>, x: number, y: number): boolean =>
  polys.some((rings) => rings.length > 0 && inRingXY(x, y, rings[0]!) && !rings.slice(1).some((h) => inRingXY(x, y, h)));

/** Metres between two points (flat, fine at 30 m). */
export const metres = (a: LatLng, b: LatLng): number => {
  const [x, y] = xyOf(a, b.lng, b.lat);
  return Math.hypot(x, y);
};

/**
 * The candidate the ray from `at` along `heading` (degrees clockwise from
 * north) enters first between 4 and 30 m. Null when it enters none.
 */
export const pickByRay = <T extends Candidate>(at: LatLng, heading: number, items: readonly T[]): T | null => {
  const near = items.filter((c) => c.geometry && metres(at, c) <= RAY_TO_M + 60);
  const shapes = near.map((c) => ({ c, polys: polygonsXY(at, c.geometry!) }));
  const dx = Math.sin(heading * RAD);
  const dy = Math.cos(heading * RAD);
  for (let d = RAY_FROM_M; d <= RAY_TO_M; d += RAY_STEP_M) {
    const x = dx * d;
    const y = dy * d;
    const hit = preferDrawn(shapes.filter((s) => insideXY(s.polys, x, y)).map((s) => s.c));
    if (hit) return hit;
  }
  return null;
};

/** The candidate under the fix, else the nearest centre within 25 m. */
export const pickNearest = <T extends Candidate>(at: LatLng, items: readonly T[]): T | null => {
  const under = preferDrawn(items.filter((c) => c.geometry && metres(at, c) <= 80 && insideXY(polygonsXY(at, c.geometry), 0, 0)));
  if (under) return under;
  let best: { c: T; d: number } | null = null;
  for (const c of items) {
    const d = metres(at, c);
    if (d <= NEAREST_M && (!best || d < best.d)) best = { c, d };
  }
  return best?.c ?? null;
};

/** SPEC 22: the ray when there is a heading and it hits something, else the nearest. */
export const pickParcel = <T extends Candidate>(at: LatLng | null, heading: number | null, items: readonly T[]): T | null => {
  if (!at) return null;
  if (heading !== null) {
    const hit = pickByRay(at, heading, items);
    if (hit) return hit;
  }
  return pickNearest(at, items);
};

// #region alleys
export const ALLEY_ALONG_DEG = 25;
export const ALLEY_NEAR_M = 15;

/** An alley half: its centreline as [[lat, lng], ...] along the way. */
export interface AlleyCandidate {
  line: ReadonlyArray<readonly [number, number]>;
}

/** Nearest point of a polyline (local metres) to the origin: distance, arc position, length, and the direction there. */
const nearestOnLine = (xy: ReadonlyArray<readonly [number, number]>): { d: number; s: number; length: number; u: [number, number]; p: [number, number] } => {
  let best = { d: Infinity, s: 0, u: [0, 0] as [number, number], p: [0, 0] as [number, number] };
  let acc = 0;
  for (let i = 1; i < xy.length; i++) {
    const a = xy[i - 1]!;
    const b = xy[i]!;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    if (len === 0) continue;
    const t = Math.max(0, Math.min(1, (-a[0] * dx - a[1] * dy) / (len * len)));
    const d = Math.hypot(a[0] + dx * t, a[1] + dy * t);
    if (d < best.d) best = { d, s: acc + t * len, u: [dx / len, dy / len], p: [a[0] + dx * t, a[1] + dy * t] };
    acc += len;
  }
  return { ...best, length: acc };
};

/**
 * The alley half the phone points into, or null. A half qualifies when the
 * phone is within 15 m of it (or its end lies up to 30 m straight ahead, across
 * the cross street), the bearing runs along it within 25 degrees, and
 * the part of it ahead of the phone along the bearing is at least 10 m (or half
 * its length if shorter). The nearest such half wins. Standing a few metres
 * inside the end of the alley behind the phone (GPS on the cross street at the
 * mouth) therefore never picks that alley (Filip, 2026-10-03, at 14th St).
 */
export const ALLEY_AHEAD_M = 10;
export const ALLEY_ACROSS_M = 30;
export const pickAlley = <T extends AlleyCandidate>(at: LatLng, heading: number, halves: readonly T[]): T | null => {
  const h: [number, number] = [Math.sin(heading * RAD), Math.cos(heading * RAD)];
  const cosMax = Math.cos(ALLEY_ALONG_DEG * RAD);
  let best: { c: T; d: number } | null = null;
  for (const c of halves) {
    if (c.line.length < 2) continue;
    const near = nearestOnLine(c.line.map(([lat, lng]) => xyOf(at, lng, lat)));
    // Within 15 m, or an end up to 30 m away straight ahead (across the cross street from the mouth).
    const aheadOfPhone = near.d > 0 ? (h[0] * near.p[0] + h[1] * near.p[1]) / near.d : 1;
    if (near.d > ALLEY_NEAR_M && !(near.d <= ALLEY_ACROSS_M && aheadOfPhone >= Math.cos(15 * RAD))) continue;
    const along = h[0] * near.u[0] + h[1] * near.u[1];
    if (Math.abs(along) < cosMax) continue;
    const ahead = along > 0 ? near.length - near.s : near.s;
    if (ahead < Math.min(ALLEY_AHEAD_M, near.length / 2)) continue;
    if (!best || near.d < best.d) best = { c, d: near.d };
  }
  return best?.c ?? null;
};

/** SPEC 22: an alley half pointed down wins; otherwise the parcel pick. */
export const pickFlag = <T extends Candidate, A extends AlleyCandidate>(at: LatLng | null, heading: number | null, halves: readonly A[], items: readonly T[]): T | A | null => {
  if (at && heading !== null) {
    const alley = pickAlley(at, heading, halves);
    if (alley) return alley;
  }
  return pickParcel(at, heading, items);
};
// #endregion

/** "NE": the heading as one of eight compass points. */
export const compassPoint = (heading: number): string => {
  const names = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;
  return names[Math.round((((heading % 360) + 360) % 360) / 45) % 8]!;
};
