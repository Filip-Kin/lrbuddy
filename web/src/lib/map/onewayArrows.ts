/**
 * Where the one-way arrows go along a way (SPEC 20): one every 60 m, centred
 * so both ends get the same margin, each pointing the way traffic flows.
 * Pure, so it is tested without Leaflet.
 */
export const ARROW_SPACING_M = 60;

export interface Arrow {
  lat: number;
  lng: number;
  /** Degrees clockwise from north, in the travel direction. */
  bearing: number;
}

const M_PER_DEG = 111320;

/** Metres between two [lat, lng] points, flat-earth (fine across a street). */
export const segmentM = (a: readonly [number, number], b: readonly [number, number]): number => {
  const k = Math.cos((((a[0] + b[0]) / 2) * Math.PI) / 180);
  return Math.hypot((b[0] - a[0]) * M_PER_DEG, (b[1] - a[1]) * M_PER_DEG * k);
};

/** Bearing from a to b, degrees clockwise from north in [0, 360). */
export const bearingOf = (a: readonly [number, number], b: readonly [number, number]): number => {
  const k = Math.cos((((a[0] + b[0]) / 2) * Math.PI) / 180);
  const deg = (Math.atan2((b[1] - a[1]) * k, b[0] - a[0]) * 180) / Math.PI;
  return (deg + 360) % 360;
};

/**
 * Arrows along a way. `direction` -1 means traffic runs against the point
 * order (OSM `oneway=-1`). A way shorter than the spacing gets one arrow at
 * its middle; a way of zero length gets none.
 */
export const arrowsAlong = (points: ReadonlyArray<readonly [number, number]>, direction: 1 | -1, spacingM = ARROW_SPACING_M): Arrow[] => {
  const ordered = direction === 1 ? [...points] : [...points].reverse();
  // Doubled nodes make zero-length segments with no bearing.
  const pts = ordered.filter((p, i) => i === 0 || segmentM(ordered[i - 1]!, p) > 0);
  const lengths: number[] = [];
  for (let i = 1; i < pts.length; i++) lengths.push(segmentM(pts[i - 1]!, pts[i]!));
  const total = lengths.reduce((n, d) => n + d, 0);
  if (total <= 0) return [];
  const n = Math.max(1, Math.floor(total / spacingM));
  const first = (total - (n - 1) * spacingM) / 2;
  const out: Arrow[] = [];
  let seg = 0;
  let segStart = 0;
  for (let k = 0; k < n; k++) {
    const at = first + k * spacingM;
    while (seg < lengths.length - 1 && segStart + lengths[seg]! < at) {
      segStart += lengths[seg]!;
      seg++;
    }
    const a = pts[seg]!;
    const b = pts[seg + 1]!;
    const t = Math.min(1, Math.max(0, (at - segStart) / lengths[seg]!));
    out.push({ lat: a[0] + (b[0] - a[0]) * t, lng: a[1] + (b[1] - a[1]) * t, bearing: bearingOf(a, b) });
  }
  return out;
};
