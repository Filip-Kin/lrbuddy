/**
 * Which parcel the phone is standing at and facing (SPEC 22): a ray from the
 * GPS fix along the compass heading, 4 to 30 m ahead, and the first parcel it
 * enters; with no heading, the parcel under the fix or the nearest centre
 * within 25 m. Pure functions on [lng, lat] GeoJSON outlines, in local metres.
 */
import type { LotGeometry } from "../../../../../server/db/schema.ts";

export interface LatLng {
  lat: number;
  lng: number;
}

export interface Candidate extends LatLng {
  key: string;
  geometry: LotGeometry | null;
}

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
    const hit = shapes.find((s) => insideXY(s.polys, x, y));
    if (hit) return hit.c;
  }
  return null;
};

/** The candidate under the fix, else the nearest centre within 25 m. */
export const pickNearest = <T extends Candidate>(at: LatLng, items: readonly T[]): T | null => {
  const under = items.find((c) => c.geometry && metres(at, c) <= 80 && insideXY(polygonsXY(at, c.geometry), 0, 0));
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

/** "NE": the heading as one of eight compass points. */
export const compassPoint = (heading: number): string => {
  const names = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;
  return names[Math.round((((heading % 360) + 360) % 360) / 45) % 8]!;
};
