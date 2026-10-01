/** Small geodesy for drive mode: local metres, bearings, a point ahead. */

export interface LatLng {
  lat: number;
  lng: number;
}

const R = 6371008.8;
const rad = (d: number): number => (d * Math.PI) / 180;
const deg = (r: number): number => (r * 180) / Math.PI;

export const distanceM = (a: LatLng, b: LatLng): number => {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
};

/** Compass bearing from a to b, 0 to 360, clockwise from north. */
export const bearing = (a: LatLng, b: LatLng): number => {
  const y = Math.sin(rad(b.lng - a.lng)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lng - a.lng));
  return (deg(Math.atan2(y, x)) + 360) % 360;
};

/** The point `m` metres from p along `headingDeg`. */
export const ahead = (p: LatLng, headingDeg: number, m: number): LatLng => {
  const d = m / R;
  const h = rad(headingDeg);
  const lat1 = rad(p.lat);
  const lng1 = rad(p.lng);
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(h));
  const lng2 = lng1 + Math.atan2(Math.sin(h) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
  return { lat: deg(lat2), lng: deg(lng2) };
};

/**
 * Offset of q from p in the frame of a heading: `along` is metres ahead
 * (negative behind), `lateral` metres to the right (negative left).
 * Equirectangular, which is exact enough over a block.
 */
export const headingFrame = (p: LatLng, headingDeg: number, q: LatLng): { along: number; lateral: number } => {
  const x = rad(q.lng - p.lng) * Math.cos(rad((p.lat + q.lat) / 2)) * R;
  const y = rad(q.lat - p.lat) * R;
  const h = rad(headingDeg);
  return { along: x * Math.sin(h) + y * Math.cos(h), lateral: x * Math.cos(h) - y * Math.sin(h) };
};

/** Shortest signed turn from a to b in degrees, -180 to 180. */
export const turn = (a: number, b: number): number => ((((b - a) % 360) + 540) % 360) - 180;

/** Ground metres per screen pixel at a Web Mercator zoom. */
export const metresPerPixel = (lat: number, zoom: number): number => (156543.03392 * Math.cos(rad(lat))) / 2 ** zoom;
