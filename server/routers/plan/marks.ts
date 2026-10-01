import type { BBox, LatLng } from "../../geo.ts";
import { inBBox, padBBox } from "../../geo.ts";
import { blockSides, cachedParcelsInBBox, outlinePoints, parseKey, workParcelsOnSides } from "../../parcels.ts";

/** Metres the mark sits off the street centreline, onto the side's own half of the street (SPEC 19, Marks). */
export const MARK_OFFSET_M = 6;
/** How far the other side of the street may be from this side's middle and still count as across from it. */
const ACROSS_M = 100;

const M_PER_DEG = 111320;

/**
 * The sharpie line for one block side: along the street, `offsetM` off the
 * centreline on this side, from the first to the last parcel needing work.
 *
 * Direction: city lots are deeper than they are wide and run back from the
 * street, so the street runs across the long axis of this side's parcel
 * outlines (averaged over the side). When the outlines are close to square,
 * the main direction of the two rows of parcel centres (this side and the one
 * across) is used instead. The centreline is half way between the two rows;
 * with nobody cached across the street the line runs along this row's centres.
 * Null when there is no direction to draw along or no work.
 */
export const markLine = (
  input: { side: readonly LatLng[]; across: readonly LatLng[]; work: readonly LatLng[]; outlines?: ReadonlyArray<readonly LatLng[]> },
  offsetM = MARK_OFFSET_M,
): [LatLng, LatLng] | null => {
  const { side, across, work, outlines = [] } = input;
  if (side.length === 0 || work.length === 0) return null;
  const lat0 = side.reduce((n, p) => n + p.lat, 0) / side.length;
  const lng0 = side.reduce((n, p) => n + p.lng, 0) / side.length;
  const kx = M_PER_DEG * Math.cos((lat0 * Math.PI) / 180);
  const toXY = (p: LatLng): [number, number] => [(p.lng - lng0) * kx, (p.lat - lat0) * M_PER_DEG];
  const toLL = (x: number, y: number): LatLng => ({ lat: lat0 + y / M_PER_DEG, lng: lng0 + x / kx });

  // Depth direction of the parcels, as a doubled angle so opposite directions add up rather than cancel.
  let dA = 0;
  let dB = 0;
  let dN = 0;
  for (const ring of outlines) {
    if (ring.length < 3) continue;
    const pts = ring.map(toXY);
    const mx = pts.reduce((t, p) => t + p[0], 0) / pts.length;
    const my = pts.reduce((t, p) => t + p[1], 0) / pts.length;
    let a = 0;
    let b = 0;
    let c = 0;
    for (const [x, y] of pts) {
      a += (x - mx) ** 2;
      b += (y - my) ** 2;
      c += (x - mx) * (y - my);
    }
    const tr = a + b;
    if (tr <= 0) continue;
    dA += (a - b) / tr;
    dB += (2 * c) / tr;
    dN++;
  }
  // Principal axis of each row about its own mean, so the gap between the rows does not tilt it.
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  let n = 0;
  for (const row of [side, across]) {
    if (row.length < 2) continue;
    const pts = row.map(toXY);
    const mx = pts.reduce((t, p) => t + p[0], 0) / pts.length;
    const my = pts.reduce((t, p) => t + p[1], 0) / pts.length;
    for (const [x, y] of pts) {
      sxx += (x - mx) ** 2;
      syy += (y - my) ** 2;
      sxy += (x - mx) * (y - my);
      n++;
    }
  }
  // Outlines clearly longer one way (a 10 by 30 m lot scores 0.8) set the direction; else the rows do.
  const depthStrength = dN > 0 ? Math.hypot(dA, dB) / dN : 0;
  let theta: number;
  if (depthStrength > 0.3) theta = 0.5 * Math.atan2(dB, dA) + Math.PI / 2;
  else if (n > 0) theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  else return null;
  const ux = Math.cos(theta);
  const uy = Math.sin(theta);
  const nx = -uy;
  const ny = ux;

  const along = (p: [number, number]): number => p[0] * ux + p[1] * uy;
  const across1 = (p: [number, number]): number => p[0] * nx + p[1] * ny;
  const a = side.map(toXY).reduce((t, p) => t + across1(p), 0) / side.length;
  let off = a;
  if (across.length > 0) {
    const b = across.map(toXY).reduce((t, p) => t + across1(p), 0) / across.length;
    const c = (a + b) / 2;
    off = c + Math.sign(a - c || 1) * offsetM;
  }
  const ts = work.map((p) => along(toXY(p)));
  const t0 = Math.min(...ts);
  const t1 = Math.max(...ts);
  if (!Number.isFinite(t0) || !Number.isFinite(t1)) return null;
  return [toLL(ux * t0 + nx * off, uy * t0 + ny * off), toLL(ux * t1 + nx * off, uy * t1 + ny * off)];
};

export interface SideMark {
  key: string;
  /** Two points, [lat, lng] each, the way the printed maps take them. */
  line: [[number, number], [number, number]];
}

/** A mark for every block side with work whose middle is inside the box. */
export const sideMarks = (eventId: number, bbox: BBox): SideMark[] => {
  const sides = blockSides(eventId).filter((b) => b.workCount > 0 && inBBox(b.center, bbox));
  if (sides.length === 0) return [];
  const keys = new Set(sides.map((b) => b.key));
  const rows = new Map<string, LatLng[]>();
  const shapes = new Map<string, LatLng[][]>();
  for (const p of cachedParcelsInBBox(padBBox(bbox, ACROSS_M + 150), 60_000)) {
    if (!p.blockSideKey) continue;
    rows.set(p.blockSideKey, [...(rows.get(p.blockSideKey) ?? []), { lat: p.lat, lng: p.lng }]);
    if (keys.has(p.blockSideKey)) shapes.set(p.blockSideKey, [...(shapes.get(p.blockSideKey) ?? []), outlinePoints(p.geometry)]);
  }
  const work = new Map<string, LatLng[]>();
  for (const p of workParcelsOnSides(eventId, sides.map((b) => b.key))) {
    if (!p.blockSideKey) continue;
    work.set(p.blockSideKey, [...(work.get(p.blockSideKey) ?? []), ...outlinePoints(p.geometry)]);
  }
  const near = (c: LatLng, p: LatLng): boolean => Math.abs(p.lat - c.lat) * M_PER_DEG < ACROSS_M && Math.abs(p.lng - c.lng) * M_PER_DEG * Math.cos((c.lat * Math.PI) / 180) < ACROSS_M;
  const out: SideMark[] = [];
  for (const b of sides) {
    const k = parseKey(b.key);
    const other = k.parity === "odd" ? "even" : "odd";
    // Across the street: the same block's other parity, else any of the street's other parity close by.
    let across = rows.get(`${b.key.slice(0, b.key.lastIndexOf("|"))}|${other}`) ?? [];
    if (across.length === 0) {
      for (const [key, pts] of rows) {
        if (!key.startsWith(`${k.street}|`) || !key.endsWith(`|${other}`)) continue;
        across = [...across, ...pts.filter((p) => near(b.center, p))];
      }
    }
    const line = markLine({ side: rows.get(b.key) ?? [], across, work: work.get(b.key) ?? [], outlines: shapes.get(b.key) ?? [] });
    if (line) out.push({ key: b.key, line: [[line[0].lat, line[0].lng], [line[1].lat, line[1].lng]] });
  }
  return out;
};
