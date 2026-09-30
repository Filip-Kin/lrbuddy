export interface LatLng {
  lat: number;
  lng: number;
}

/** [xmin (west lng), ymin (south lat), xmax (east lng), ymax (north lat)] */
export type BBox = [number, number, number, number];

const R = 6371008.8;
const rad = (d: number): number => (d * Math.PI) / 180;

/** Great-circle distance in metres. */
export const haversine = (a: LatLng, b: LatLng): number => {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
};

export const normalizeBBox = (b: BBox): BBox => [
  Math.min(b[0], b[2]),
  Math.min(b[1], b[3]),
  Math.max(b[0], b[2]),
  Math.max(b[1], b[3]),
];

export const inBBox = (p: LatLng, b: BBox): boolean => {
  const [w, s, e, n] = normalizeBBox(b);
  return p.lng >= w && p.lng <= e && p.lat >= s && p.lat <= n;
};

/** Smallest bbox around the points, or null when there are none. */
export const bboxOf = (pts: readonly LatLng[]): BBox | null => {
  if (pts.length === 0) return null;
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (const p of pts) {
    w = Math.min(w, p.lng);
    e = Math.max(e, p.lng);
    s = Math.min(s, p.lat);
    n = Math.max(n, p.lat);
  }
  return [w, s, e, n];
};

/** Grows a bbox by `m` metres on every side. */
export const padBBox = (b: BBox, m: number): BBox => {
  const [w, s, e, n] = normalizeBBox(b);
  const dLat = m / 111320;
  const midLat = (s + n) / 2;
  const dLng = m / (111320 * Math.max(0.01, Math.cos(rad(midLat))));
  return [w - dLng, s - dLat, e + dLng, n + dLat];
};

/** Bbox of a circle, for a coarse SQL prefilter before an exact haversine. */
export const bboxAround = (p: LatLng, m: number): BBox => padBBox([p.lng, p.lat, p.lng, p.lat], m);

/** Cost in metres of visiting `x` between `a` and `b` instead of going straight. */
export const detour = (a: LatLng, x: LatLng, b: LatLng | null): number =>
  b ? haversine(a, x) + haversine(x, b) - haversine(a, b) : haversine(a, x);

/** Google Maps directions deep link; opens the app on a phone. */
export const directionsUrl = (p: LatLng): string =>
  `https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}`;
