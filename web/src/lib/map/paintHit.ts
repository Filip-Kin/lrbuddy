import type { LotGeometry, LotStatus } from "../../../../server/db/schema.ts";

/** Something Paint can hit: a lot (by id) or a bare parcel (by parcel id). */
export interface PaintTarget {
  /** `l:<lot id>` or `p:<parcel id>`, the same keys as the pending map of `useSetLot`. */
  key: string;
  lotId: number | null;
  parcelId: string | null;
  /** Null for a bare parcel (Not todo). */
  status: LotStatus | null;
  crewId: number | null;
  lat: number;
  lng: number;
  geometry: LotGeometry | null;
}

export interface Candidate extends PaintTarget {
  /** [west, south, east, north] of the outline; a point for a lot without one. */
  box: [number, number, number, number];
}

const boxOf = (t: PaintTarget): [number, number, number, number] => {
  const g = t.geometry;
  if (!g) return [t.lng, t.lat, t.lng, t.lat];
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  const polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
  for (const poly of polys) {
    for (const p of poly[0] ?? []) {
      const x = p[0] ?? 0;
      const y = p[1] ?? 0;
      if (x < w) w = x;
      if (x > e) e = x;
      if (y < s) s = y;
      if (y > n) n = y;
    }
  }
  return [w, s, e, n];
};

export const candidates = (targets: readonly PaintTarget[]): Candidate[] => targets.map((t) => ({ ...t, box: boxOf(t) }));

/** Ray casting on one ring of [lng, lat] points. */
const inRing = (lng: number, lat: number, ring: ReadonlyArray<ReadonlyArray<number>>): boolean => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i]![0] ?? 0;
    const yi = ring[i]![1] ?? 0;
    const xj = ring[j]![0] ?? 0;
    const yj = ring[j]![1] ?? 0;
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};

/** True when the point is inside the outline (holes respected). */
export const inGeometry = (lng: number, lat: number, g: LotGeometry): boolean => {
  const polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
  return polys.some((poly) => {
    const outer = poly[0];
    if (!outer || !inRing(lng, lat, outer)) return false;
    return !poly.slice(1).some((hole) => inRing(lng, lat, hole));
  });
};

/**
 * The target under a point. Outlines are tested by polygon; a lot without
 * one (a 28 px square on the map) by distance, `nearDeg` being about 14 px at
 * the current zoom. Lots win over bare parcels, and a drawn lot (no parcel
 * id) over a parcel lot, so a shape drawn across parcels takes the stroke.
 */
export const hitAt = (cands: readonly Candidate[], lng: number, lat: number, nearDeg: number): Candidate | null => {
  let best: Candidate | null = null;
  let rank = -1;
  for (const c of cands) {
    const [w, s, e, n] = c.box;
    if (c.geometry) {
      if (lng < w || lng > e || lat < s || lat > n) continue;
      if (!inGeometry(lng, lat, c.geometry)) continue;
    } else if (Math.abs(lng - c.lng) > nearDeg || Math.abs(lat - c.lat) > nearDeg) continue;
    const r = c.lotId === null ? 0 : c.parcelId === null ? 2 : 1;
    if (r > rank) {
      best = c;
      rank = r;
    }
  }
  return best;
};
