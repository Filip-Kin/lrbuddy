/**
 * Turn guidance for the driver map, free of React so it can be tested: where
 * the truck is along the route line, which OSRM manoeuvre comes next, and the
 * words and arrow angle for it. The fallback engine has no manoeuvres; the
 * banner then shows the straight-line bearing and distance to the stop.
 */
import type { Manoeuvre } from "../../../../server/db/schema.ts";
import { bearing, distanceM, type LatLng } from "../../pages/plan/survey/geo.ts";

export type { Manoeuvre };

/** A manoeuvre this close behind the truck's spot on the line counts as done. */
export const PASSED_M = 8;
/** How far past the last manoeuvre of the leg the truck may be snapped to the line. */
const LEG_END_SLACK_M = 60;

const R = 6371008.8;
const rad = (d: number): number => (d * Math.PI) / 180;

// #region line position
/** Cumulative metres at each vertex of a [[lat, lng], ...] line. */
export const cumulative = (line: ReadonlyArray<readonly [number, number]>): number[] => {
  const out = [0];
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1]!;
    const b = line[i]!;
    out.push(out[i - 1]! + distanceM({ lat: a[0], lng: a[1] }, { lat: b[0], lng: b[1] }));
  }
  return out;
};

export interface OnLine {
  /** Segment index (vertex i to i + 1). */
  seg: number;
  /** Metres along the line to the nearest point. */
  along: number;
  /** Metres from the point to the line. */
  off: number;
}

/**
 * Nearest point on the line to `p`, searching segments `from` to `to`
 * (inclusive). Local equirectangular metres, exact enough over a city.
 */
export const project = (
  line: ReadonlyArray<readonly [number, number]>,
  cum: readonly number[],
  p: LatLng,
  from = 0,
  to = line.length - 2,
): OnLine | null => {
  if (line.length === 0) return null;
  if (line.length === 1) return { seg: 0, along: 0, off: distanceM(p, { lat: line[0]![0], lng: line[0]![1] }) };
  const kx = rad(1) * R * Math.cos(rad(p.lat));
  const ky = rad(1) * R;
  let best: OnLine | null = null;
  for (let i = Math.max(0, from); i <= Math.min(to, line.length - 2); i++) {
    const a = line[i]!;
    const b = line[i + 1]!;
    const ax = (a[1] - p.lng) * kx;
    const ay = (a[0] - p.lat) * ky;
    const dx = (b[1] - a[1]) * kx;
    const dy = (b[0] - a[0]) * ky;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.min(1, Math.max(0, -(ax * dx + ay * dy) / len2));
    const off = Math.hypot(ax + t * dx, ay + t * dy);
    if (!best || off < best.off - 0.01) best = { seg: i, along: cum[i]! + t * (cum[i + 1]! - cum[i]!), off };
  }
  return best;
};
// #endregion

// #region next manoeuvre
export interface Upcoming {
  step: Manoeuvre;
  /** Metres along the road from the truck to the manoeuvre. */
  distanceM: number;
}

/**
 * The next manoeuvre of the leg ahead of the truck. Each manoeuvre is placed on
 * the line in order (each search starts where the last one landed, so a road
 * driven twice keeps its order), and the truck is snapped to the part of the
 * line that belongs to this leg, so a later leg back along the same street
 * never reads as progress.
 */
export const nextManoeuvre = (line: ReadonlyArray<readonly [number, number]>, steps: readonly Manoeuvre[], at: LatLng): Upcoming | null => {
  if (steps.length === 0 || line.length < 2) return null;
  const cum = cumulative(line);
  const placed: Array<{ step: Manoeuvre; along: number }> = [];
  let seg = 0;
  for (const step of steps) {
    const hit = project(line, cum, step, seg);
    if (!hit) return null;
    seg = hit.seg;
    placed.push({ step, along: hit.along });
  }
  const end = placed[placed.length - 1]!.along + LEG_END_SLACK_M;
  let lastSeg = 0;
  while (lastSeg < line.length - 2 && cum[lastSeg + 1]! < end) lastSeg++;
  const me = project(line, cum, at, 0, lastSeg);
  if (!me) return null;
  for (const p of placed) {
    if (p.along > me.along + PASSED_M || p.step.type === "arrive") {
      return { step: p.step, distanceM: Math.max(0, p.along - me.along) };
    }
  }
  return null;
};
// #endregion

// #region words and arrows
const SIDE: Record<string, string> = {
  left: "Left",
  "slight left": "Slight left",
  "sharp left": "Sharp left",
  right: "Right",
  "slight right": "Slight right",
  "sharp right": "Sharp right",
  straight: "Straight",
  uturn: "U-turn",
};

/** "Left", "Keep right", "Roundabout", "Arrive". */
export const manoeuvreLabel = (m: Pick<Manoeuvre, "type" | "modifier">): string => {
  const side = m.modifier ? SIDE[m.modifier] : undefined;
  switch (m.type) {
    case "arrive":
      return "Arrive";
    case "roundabout":
    case "rotary":
    case "roundabout turn":
    case "exit roundabout":
    case "exit rotary":
      return "Roundabout";
    case "fork":
      return m.modifier?.includes("left") ? "Keep left" : m.modifier?.includes("right") ? "Keep right" : "Fork";
    case "merge":
      return "Merge";
    case "on ramp":
      return "Ramp";
    case "off ramp":
      return "Exit";
    default:
      return side ?? "Continue";
  }
};

const ANGLE: Record<string, number> = {
  straight: 0,
  "slight right": 45,
  right: 90,
  "sharp right": 135,
  uturn: 180,
  "sharp left": -135,
  left: -90,
  "slight left": -45,
};

/** Arrow rotation in degrees, 0 straight up; null for an arrival (drawn as a pin). */
export const manoeuvreAngle = (m: Pick<Manoeuvre, "type" | "modifier">): number | null =>
  m.type === "arrive" ? null : (ANGLE[m.modifier ?? "straight"] ?? 0);

const WINDS = ["North", "Northeast", "East", "Southeast", "South", "Southwest", "West", "Northwest"];

/** "Northeast" for a compass bearing. */
export const compass = (deg: number): string => WINDS[Math.round((((deg % 360) + 360) % 360) / 45) % 8]!;

/**
 * Straight-line guidance for the fallback engine: distance, compass word, and
 * the arrow angle on screen. The map turns with the heading, so the arrow is
 * the bearing less the heading; with no heading the map is north up.
 */
export const straightLine = (at: LatLng, to: LatLng, heading: number | null): { distanceM: number; bearing: number; angle: number } => {
  const b = bearing(at, to);
  return { distanceM: distanceM(at, to), bearing: b, angle: heading === null ? b : b - heading };
};
// #endregion
