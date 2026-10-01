/**
 * Diagonal hatch lines across a convex ring (a crew area), for the Do not
 * touch mark (SPEC 19). Drawn as plain polylines so the same lines show on
 * Leaflet maps and printed sheets without an SVG pattern.
 */
type LngLat = ReadonlyArray<number>;

/** Segments as [lat, lng] pairs, one every `spacingM` metres, at 45 degrees. Empty for a ring under 3 points. */
export const hatchLines = (ring: ReadonlyArray<LngLat>, spacingM = 14): Array<[[number, number], [number, number]]> => {
  const pts = ring.filter((p) => p[0] !== undefined && p[1] !== undefined).map((p) => [p[0]!, p[1]!] as const);
  if (pts.length < 3) return [];
  const lat0 = pts.reduce((n, p) => n + p[1], 0) / pts.length;
  const lng0 = pts.reduce((n, p) => n + p[0], 0) / pts.length;
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const xy = pts.map((p) => ({ x: (p[0] - lng0) * kx, y: (p[1] - lat0) * 111320 }));
  // Lines x - y = c; each crosses a convex ring at two points (or touches it).
  const cs = xy.map((p) => p.x - p.y);
  const lo = Math.min(...cs);
  const hi = Math.max(...cs);
  const out: Array<[[number, number], [number, number]]> = [];
  const back = (x: number, y: number): [number, number] => [lat0 + y / 111320, lng0 + x / kx];
  for (let c = lo + spacingM / 2; c < hi; c += spacingM) {
    const hits: Array<{ x: number; y: number }> = [];
    for (let i = 0; i < xy.length; i++) {
      const a = xy[i]!;
      const b = xy[(i + 1) % xy.length]!;
      const fa = a.x - a.y - c;
      const fb = b.x - b.y - c;
      if ((fa < 0 && fb < 0) || (fa > 0 && fb > 0) || fa === fb) continue;
      const t = fa / (fa - fb);
      hits.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
    if (hits.length < 2) continue;
    hits.sort((p, q) => p.x - q.x);
    const p = hits[0]!;
    const q = hits[hits.length - 1]!;
    if (Math.hypot(q.x - p.x, q.y - p.y) < 1) continue;
    out.push([back(p.x, p.y), back(q.x, q.y)]);
  }
  return out;
};
