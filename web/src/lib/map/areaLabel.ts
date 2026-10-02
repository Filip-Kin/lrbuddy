/**
 * Area names on maps, the parts with no Leaflet in them (tested in areaLabel.test.ts): the short
 * name and where on the outline it goes. `areaNames.ts` draws them.
 */
// #region label text
const NAMED = /^(.*\S)\s+(\d+)$/;

/**
 * The name a crew area carries on a map (Filip, 2026-10-02: "make them smaller and along the border
 * of the group"). The joined sheet name collapses when every crew is one company: "PISTONS 1-13" for
 * a run of three or more, else "GM 9, 10 & 11". Anything else (an override, several companies) stays
 * as it is. Print sheets keep the full joined name.
 */
export const shortAreaLabel = (label: string): string => {
  const parts = label
    .split(/, | & /)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length < 2) return label;
  const items: Array<{ prefix: string; n: number }> = [];
  for (const p of parts) {
    const m = NAMED.exec(p);
    if (!m || m[1] === undefined || m[2] === undefined) return label;
    items.push({ prefix: m[1], n: Number(m[2]) });
  }
  const prefix = items[0]!.prefix;
  if (items.some((i) => i.prefix !== prefix)) return label;
  const ns = items.map((i) => i.n).sort((a, b) => a - b);
  const run = ns.every((n, i) => i === 0 || n === ns[i - 1]! + 1);
  if (run && ns.length >= 3) return `${prefix} ${ns[0]}-${ns[ns.length - 1]}`;
  const list = ns.map(String);
  return `${prefix} ${list.slice(0, -1).join(", ")} & ${list[list.length - 1]}`;
};
// #endregion

// #region placement
export interface EdgePlacement {
  /** Index of the vertex the label starts at, in the open ring. */
  from: number;
  /** Degrees, in the map's own pixel frame, from `from` towards the other end of the edge. */
  angle: number;
  /** Edge length in pixels. */
  length: number;
  /** True when the inside of the area is on the label's lower side (clockwise normal). */
  insideBelow: boolean;
}

/**
 * Where a name goes on an area outline given in pixels: the edge whose middle is highest on screen
 * (after the map's CSS turn, for the driver map), the longer one on a near tie. The label runs left to
 * right on screen, so it starts at whichever end keeps the text upright.
 */
export const placeOnTopEdge = (pts: ReadonlyArray<{ x: number; y: number }>, turnDeg = 0): EdgePlacement | null => {
  if (pts.length < 3) return null;
  const t = (turnDeg * Math.PI) / 180;
  const screenY = (p: { x: number; y: number }): number => p.x * Math.sin(t) + p.y * Math.cos(t);
  let best: { i: number; y: number; len: number } | null = null;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 1) continue;
    const y = screenY({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    if (!best || y < best.y - 2 || (Math.abs(y - best.y) <= 2 && len > best.len)) best = { i, y, len };
  }
  if (!best) return null;
  let from = best.i;
  let to = (best.i + 1) % pts.length;
  let a = pts[from]!;
  let b = pts[to]!;
  let angle = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
  // Upright on screen: the edge's screen direction must point right.
  if (Math.cos(((angle + turnDeg) * Math.PI) / 180) < 0) {
    [from, to] = [to, from];
    [a, b] = [b, a];
    angle = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
  }
  const cx = pts.reduce((n, p) => n + p.x, 0) / pts.length;
  const cy = pts.reduce((n, p) => n + p.y, 0) / pts.length;
  // Clockwise normal of a to b in screen pixels (y down): the label's "below".
  const nx = -(b.y - a.y);
  const ny = b.x - a.x;
  return { from, angle, length: best.len, insideBelow: (cx - a.x) * nx + (cy - a.y) * ny > 0 };
};
// #endregion

