/**
 * Drive mode rules, kept free of React and the browser so they can be tested:
 * which way the car points, which parcels sit on each side of the road ahead,
 * and what a tap on Left or Right means.
 */
import { bearing, distanceM, headingFrame, type LatLng } from "./geo.ts";

export type Grade = "high" | "low" | "clear";
export type Side = "left" | "right";

// #region heading
/** GPS heading is trusted above this speed (m/s); below it, the bearing between fixes. */
export const GPS_HEADING_SPEED = 2;
/** Fixes closer than this (m) are GPS jitter, not movement, and do not set a bearing. */
export const MIN_BEARING_MOVE_M = 3;

export interface Fix extends LatLng {
  accuracy: number | null;
  heading: number | null;
  speed: number | null;
  at: number;
}

/**
 * The heading after a new fix. GPS heading when the speed is over 2 m/s;
 * otherwise the bearing from the last fix that was at least 3 m away (the
 * anchor) to this one; otherwise the heading we had.
 * Returns the heading and the anchor to keep for the next fix.
 */
export const nextHeading = (fix: Fix, anchor: LatLng | null, current: number | null): { heading: number | null; anchor: LatLng } => {
  const moved = anchor ? distanceM(anchor, fix) : 0;
  if (fix.speed !== null && fix.speed > GPS_HEADING_SPEED && fix.heading !== null && Number.isFinite(fix.heading)) {
    return { heading: ((fix.heading % 360) + 360) % 360, anchor: fix };
  }
  if (anchor && moved >= MIN_BEARING_MOVE_M) return { heading: bearing(anchor, fix), anchor: fix };
  return { heading: current, anchor: anchor ?? fix };
};
// #endregion

// #region sides
/** Parcels further than this from the road centreline (m) are not on the street being driven. */
export const MAX_LATERAL_M = 40;
/** How far behind (m) a parcel still counts as the one beside the car. */
export const BEHIND_M = 15;
/** How far ahead (m) parcels are considered. */
export const AHEAD_M = 60;
/** A parcel behind the car counts this much further away than one the same distance ahead. */
export const BEHIND_WEIGHT = 1.5;
/** Highlighted parcels per side. */
export const PER_SIDE = 2;

export interface DriveParcel extends LatLng {
  parcelId: string;
  address: string | null;
  streetName: string | null;
}

export interface Candidate<P extends DriveParcel> {
  parcel: P;
  along: number;
  lateral: number;
  distance: number;
}

/**
 * The parcels on each side of the road ahead, nearest first, up to two per
 * side; a parcel just passed ranks a little behind one coming up. The road centreline is the line through the car along the heading. A
 * parcel's side is the side its centre falls on. When most nearby parcels
 * front one street, parcels on other streets (corner lots on the cross street)
 * drop out, unless that leaves a side empty.
 */
export const pickSides = <P extends DriveParcel>(parcels: Iterable<P>, at: LatLng, heading: number): Record<Side, Array<Candidate<P>>> => {
  const near: Array<Candidate<P>> = [];
  for (const p of parcels) {
    const { along, lateral } = headingFrame(at, heading, p);
    if (Math.abs(lateral) > MAX_LATERAL_M || along < -BEHIND_M || along > AHEAD_M) continue;
    near.push({ parcel: p, along, lateral, distance: Math.hypot(along < 0 ? along * BEHIND_WEIGHT : along, lateral) });
  }
  near.sort((a, b) => a.distance - b.distance);
  const counts = new Map<string, number>();
  for (const c of near) if (c.parcel.streetName) counts.set(c.parcel.streetName, (counts.get(c.parcel.streetName) ?? 0) + 1);
  let street: string | null = null;
  let best = 0;
  for (const [name, n] of counts) {
    if (n > best) {
      best = n;
      street = name;
    }
  }
  if (street && best * 2 < near.length) street = null;
  const side = (s: Side): Array<Candidate<P>> => {
    const all = near.filter((c) => (s === "left" ? c.lateral < 0 : c.lateral > 0));
    const onStreet = street ? all.filter((c) => c.parcel.streetName === street) : all;
    return (onStreet.length > 0 ? onStreet : all).slice(0, PER_SIDE);
  };
  return { left: side("left"), right: side("right") };
};
// #endregion

// #region taps
/** A second tap within this long (ms) upgrades the first tap's parcel to high. */
export const DOUBLE_TAP_MS = 3000;
/** Press longer than this (ms) opens the grade sheet. */
export const LONG_PRESS_MS = 550;

export interface LastTap {
  side: Side;
  parcelId: string;
  grade: Grade;
  at: number;
}

/**
 * What a tap on Left or Right does. One tap tags the nearest parcel on that
 * side low. A second tap on the same side within 3 s makes the parcel the
 * first tap tagged high, even if the car has moved past it since. A third
 * quick tap tags the next parcel low, and never downgrades the one just
 * made high.
 */
export const decideTap = (side: Side, now: number, last: LastTap | null, nearest: string | null): { parcelId: string; grade: Grade } | null => {
  const quick = last !== null && last.side === side && now - last.at <= DOUBLE_TAP_MS;
  if (quick && last.grade === "low") return { parcelId: last.parcelId, grade: "high" };
  if (!nearest) return null;
  if (quick && last.parcelId === nearest) return null;
  return { parcelId: nearest, grade: "low" };
};
// #endregion
