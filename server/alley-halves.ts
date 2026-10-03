/**
 * Alley halves for the Flag screen (SPEC 22, alleys). Pure: no database, no
 * network, shared by the server (the halves list and the shutter) and its tests.
 *
 * An OpenStreetMap alley way often runs several blocks. Filip, 2026-10-03: "we
 * usually like to break up an alley in two so split it halfway down the block".
 * So a way is cut into block-long pieces where it crosses a street, and each
 * block-long piece is cut at its middle into two halves. Each half is one
 * flaggable target.
 *
 * The cache holds alleys only, no streets, so the cross streets come from the
 * parcels backing onto the alley: every parcel carries the two cross streets of
 * its block (`cross_street_1`, `cross_street_2`). Projected onto the alley,
 * the parcels of one block share a pair; where the pair changes the alley
 * crosses a street, and the cut sits halfway between the last parcel of one
 * block and the first of the next. With no parcels (or no cross streets) the
 * whole way is one block.
 *
 * A half's key is `<osm way id>:<block index>:<half index>`, counted along the
 * way's node order. It survives an Overpass re-fetch of the same way, and the
 * shutter finds the lot of a half by it.
 */
import type { LotGeometry } from "./db/schema.ts";

// #region constants
const M_LAT = 111_320;
const RAD = Math.PI / 180;
/** Parcels with their centre this close to the alley back onto it (Detroit lots are about 35 m deep). */
export const BACKING_M = 45;
/** A block needs this many parcels with the same cross streets before it counts. */
const MIN_BLOCK_PARCELS = 2;
/** Street changes on the two sides of the alley this close together are one street. */
const SAME_STREET_M = 40;
/** No cut leaves a block shorter than this. */
const MIN_CUT_BLOCK_M = 30;
/** A piece of way shorter than this is a stub (a dogleg, an overhang past a street): no halves. */
export const MIN_BLOCK_M = 10;
/** Lot outline width round a half's centreline. */
export const ALLEY_WIDTH_M = 4;
// #endregion

// #region types
export interface SplitParcel {
  lat: number;
  lng: number;
  /** The street the parcel faces, "CALVERT" (no suffix). */
  streetName: string | null;
  crossStreet1: string | null;
  crossStreet2: string | null;
}

export type HalfSide = "north" | "south" | "east" | "west";

export interface AlleyHalf {
  /** `<osm id>:<block>:<half>` */
  key: string;
  osmId: number;
  block: number;
  half: 0 | 1;
  /** [[lat, lng], ...] along the way's node order. */
  line: Array<[number, number]>;
  /** Which way this half lies from the middle of its block, by compass: "west" half. */
  side: HalfSide;
  lengthM: number;
}
// #endregion

// #region geometry
interface Frame {
  lat0: number;
  lng0: number;
  kx: number;
}

const frameAt = (lat: number, lng: number): Frame => ({ lat0: lat, lng0: lng, kx: M_LAT * Math.cos(lat * RAD) });
const toXY = (f: Frame, lat: number, lng: number): [number, number] => [(lng - f.lng0) * f.kx, (lat - f.lat0) * M_LAT];
const toLatLng = (f: Frame, x: number, y: number): [number, number] => [f.lat0 + y / M_LAT, f.lng0 + x / f.kx];

/** Cumulative arc length at each vertex. */
const arcs = (xy: ReadonlyArray<readonly [number, number]>): number[] => {
  const out = [0];
  for (let i = 1; i < xy.length; i++) out.push(out[i - 1]! + Math.hypot(xy[i]![0] - xy[i - 1]![0], xy[i]![1] - xy[i - 1]![1]));
  return out;
};

/** Where a point falls on the polyline: arc position, distance off it, past an end or not, and which side (1 left, -1 right). */
export const projectOnLine = (xy: ReadonlyArray<readonly [number, number]>, at: readonly [number, number]): { s: number; d: number; end: boolean; side: number } => {
  const cum = arcs(xy);
  let best = { s: 0, d: Infinity, end: true, side: 0 };
  for (let i = 1; i < xy.length; i++) {
    const a = xy[i - 1]!;
    const b = xy[i]!;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    const raw = len2 === 0 ? 0 : ((at[0] - a[0]) * dx + (at[1] - a[1]) * dy) / len2;
    const t = Math.max(0, Math.min(1, raw));
    const d = Math.hypot(at[0] - (a[0] + dx * t), at[1] - (a[1] + dy * t));
    const side = Math.sign(dx * (at[1] - a[1]) - dy * (at[0] - a[0]));
    if (d < best.d) best = { s: cum[i - 1]! + t * Math.sqrt(len2), d, end: (i === 1 && raw < 0) || (i === xy.length - 1 && raw > 1), side };
  }
  return best;
};

/** The point at arc position `s`. */
const pointAt = (xy: ReadonlyArray<readonly [number, number]>, cum: readonly number[], s: number): [number, number] => {
  for (let i = 1; i < xy.length; i++) {
    if (s <= cum[i]! || i === xy.length - 1) {
      const seg = cum[i]! - cum[i - 1]!;
      const t = seg === 0 ? 0 : Math.max(0, Math.min(1, (s - cum[i - 1]!) / seg));
      const a = xy[i - 1]!;
      const b = xy[i]!;
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    }
  }
  return [xy[0]![0], xy[0]![1]];
};

/** The piece of the polyline between arc positions `a` and `b` (a < b). */
const slice = (xy: ReadonlyArray<readonly [number, number]>, cum: readonly number[], a: number, b: number): Array<[number, number]> => {
  const out: Array<[number, number]> = [pointAt(xy, cum, a)];
  for (let i = 0; i < xy.length; i++) if (cum[i]! > a + 1e-6 && cum[i]! < b - 1e-6) out.push([xy[i]![0], xy[i]![1]]);
  out.push(pointAt(xy, cum, b));
  return out;
};
// #endregion

// #region blocks
const SUFFIXES = new Set(["ST", "AVE", "AV", "BLVD", "CT", "DR", "RD", "PL", "LN", "WAY", "PKWY", "HWY", "TER", "CIR", "FWY"]);

/** "LINWOOD" from "Linwood St": a cross street in the words `streetName` uses. */
export const streetWord = (s: string | null): string => {
  const words = (s ?? "").trim().toUpperCase().replace(/\./g, "").split(/\s+/).filter(Boolean);
  if (words.length > 1 && SUFFIXES.has(words.at(-1)!)) words.pop();
  return words.join(" ");
};

/** Cross streets as one sorted key, or null when the parcel does not name both. */
const crossPair = (p: SplitParcel): [string, string] | null => {
  const pair = [p.crossStreet1, p.crossStreet2].map(streetWord).filter((c) => c !== "");
  return pair.length === 2 ? [pair[0]!, pair[1]!].sort() as [string, string] : null;
};

/**
 * Arc positions where the alley crosses a street, from the parcels backing onto
 * it. On each side of the alley, walking along it, the parcels of one block
 * share a cross-street pair; where the pair changes there is a street, halfway
 * between the two parcels. A pair held by one parcel alone is noise and left
 * out. Changes on the two sides within 40 m of each other are the same street
 * and give one cut at their mean. Cuts that would leave a block under 30 m go.
 *
 * A corner lot facing the cross street names the alley's own street as one of
 * its cross streets ("LINWOOD between Collingwood and Calvert" behind Calvert).
 * Those pairs say nothing about blocks and are left out: on each side, a pair
 * holding the street most parcels on that side face.
 */
export const blockCuts = (xy: ReadonlyArray<readonly [number, number]>, frame: Frame, parcels: readonly SplitParcel[]): number[] => {
  const length = arcs(xy).at(-1) ?? 0;
  const backing: Array<{ s: number; side: number; pair: [string, string] | null; street: string }> = [];
  for (const p of parcels) {
    const pr = projectOnLine(xy, toXY(frame, p.lat, p.lng));
    if (pr.end || pr.d > BACKING_M) continue;
    backing.push({ s: pr.s, side: pr.side, pair: crossPair(p), street: streetWord(p.streetName) });
  }
  const changes: number[] = [];
  for (const side of [1, -1]) {
    const here = backing.filter((b) => b.side === side);
    const faced = new Map<string, number>();
    for (const b of here) if (b.street) faced.set(b.street, (faced.get(b.street) ?? 0) + 1);
    const top = [...faced].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    const row = here
      .filter((b) => b.pair && b.pair[0] !== top && b.pair[1] !== top)
      .sort((a, b) => a.s - b.s)
      .map((b) => ({ s: b.s, key: b.pair!.join("|") }));
    // Runs of one pair along this side; single-parcel runs dropped, then neighbours of one pair joined.
    const runs: Array<{ key: string; lo: number; hi: number; n: number }> = [];
    for (const r of row) {
      const last = runs.at(-1);
      if (last && last.key === r.key) {
        last.hi = r.s;
        last.n++;
      } else runs.push({ key: r.key, lo: r.s, hi: r.s, n: 1 });
    }
    const kept: typeof runs = [];
    for (const r of runs.filter((x) => x.n >= MIN_BLOCK_PARCELS)) {
      const last = kept.at(-1);
      if (last && last.key === r.key) last.hi = r.hi;
      else kept.push({ ...r });
    }
    for (let i = 1; i < kept.length; i++) changes.push((kept[i - 1]!.hi + kept[i]!.lo) / 2);
  }
  changes.sort((a, b) => a - b);
  const clusters: number[][] = [];
  for (const c of changes) {
    const last = clusters.at(-1);
    if (last && c - last[0]! <= SAME_STREET_M) last.push(c);
    else clusters.push([c]);
  }
  const cuts: number[] = [];
  for (const c of clusters.map((g) => g.reduce((t, x) => t + x, 0) / g.length)) {
    if (c < MIN_CUT_BLOCK_M || c > length - MIN_CUT_BLOCK_M) continue;
    if (cuts.length > 0 && c - cuts.at(-1)! < MIN_CUT_BLOCK_M) continue;
    cuts.push(c);
  }
  return cuts;
};
// #endregion

// #region halves
/** "west": which way `p` lies from `o`, on the axis it differs most along. */
const sideOf = (o: readonly [number, number], p: readonly [number, number]): HalfSide => {
  const dx = p[0] - o[0];
  const dy = p[1] - o[1];
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? "east" : "west";
  return dy >= 0 ? "north" : "south";
};

/**
 * The flaggable halves of one alley way: cut at the cross streets the parcels
 * name, then each block at its middle. Stubs under 10 m get no halves.
 */
export const splitAlley = (osmId: number, centerline: ReadonlyArray<readonly [number, number]>, parcels: readonly SplitParcel[]): AlleyHalf[] => {
  if (centerline.length < 2) return [];
  const frame = frameAt(centerline[0]![0], centerline[0]![1]);
  const xy = centerline.map(([lat, lng]) => toXY(frame, lat, lng));
  const cum = arcs(xy);
  const length = cum.at(-1) ?? 0;
  const edges = [0, ...blockCuts(xy, frame, parcels), length];
  const out: AlleyHalf[] = [];
  let block = 0;
  for (let i = 1; i < edges.length; i++) {
    const a = edges[i - 1]!;
    const b = edges[i]!;
    if (b - a < MIN_BLOCK_M) continue;
    const m = (a + b) / 2;
    const mid = pointAt(xy, cum, m);
    for (const [half, from, to] of [[0, a, m], [1, m, b]] as const) {
      const piece = slice(xy, cum, from, to);
      out.push({
        key: `${osmId}:${block}:${half}`,
        osmId,
        block,
        half,
        line: piece.map(([x, y]) => toLatLng(frame, x, y)),
        side: sideOf(mid, pointAt(xy, cum, (from + to) / 2)),
        lengthM: to - from,
      });
    }
    block++;
  }
  return out;
};

/** `{ osmId, block, half }` from a half's key, or null when it is not one. */
export const parseHalfKey = (key: string): { osmId: number; block: number; half: 0 | 1 } | null => {
  const m = /^(\d+):(\d+):([01])$/.exec(key);
  return m ? { osmId: Number(m[1]), block: Number(m[2]), half: m[3] === "0" ? 0 : 1 } : null;
};

/**
 * A half's lot outline: the centreline buffered `width / 2` each side with
 * mitred corners (capped at twice the offset) and square ends, as a closed
 * [lng, lat] ring.
 */
export const alleyOutline = (line: ReadonlyArray<readonly [number, number]>, width = ALLEY_WIDTH_M): LotGeometry => {
  const frame = frameAt(line[0]![0], line[0]![1]);
  const xy = line.map(([lat, lng]) => toXY(frame, lat, lng)).filter((p, i, all) => i === 0 || Math.hypot(p[0] - all[i - 1]![0], p[1] - all[i - 1]![1]) > 1e-3);
  const h = width / 2;
  const dirs: Array<[number, number]> = [];
  for (let i = 1; i < xy.length; i++) {
    const dx = xy[i]![0] - xy[i - 1]![0];
    const dy = xy[i]![1] - xy[i - 1]![1];
    const l = Math.hypot(dx, dy) || 1;
    dirs.push([dx / l, dy / l]);
  }
  const left: Array<[number, number]> = [];
  const right: Array<[number, number]> = [];
  for (let i = 0; i < xy.length; i++) {
    const a = dirs[Math.max(0, i - 1)]!;
    const b = dirs[Math.min(dirs.length - 1, i)]!;
    // Normal of the averaged direction, stretched by the miter factor.
    let nx = -(a[1] + b[1]);
    let ny = a[0] + b[0];
    const nl = Math.hypot(nx, ny) || 1;
    nx /= nl;
    ny /= nl;
    const cos = nx * -b[1] + ny * b[0];
    const k = Math.min(2, 1 / Math.max(cos, 0.5));
    const p = xy[i]!;
    left.push([p[0] + nx * h * k, p[1] + ny * h * k]);
    right.push([p[0] - nx * h * k, p[1] - ny * h * k]);
  }
  const ring = [...left, ...right.reverse()];
  ring.push(ring[0]!);
  return { type: "Polygon", coordinates: [ring.map(([x, y]) => {
    const [lat, lng] = toLatLng(frame, x, y);
    return [lng, lat];
  })] };
};

/** The point halfway along a half, [lat, lng]. */
export const halfMiddle = (line: ReadonlyArray<readonly [number, number]>): [number, number] => {
  const frame = frameAt(line[0]![0], line[0]![1]);
  const xy = line.map(([lat, lng]) => toXY(frame, lat, lng));
  const cum = arcs(xy);
  const [x, y] = pointAt(xy, cum, (cum.at(-1) ?? 0) / 2);
  return toLatLng(frame, x, y);
};
// #endregion
