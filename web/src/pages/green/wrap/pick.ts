/**
 * Which lot Wrap up's camera is on (SPEC 28): the Flag screen's ray along the camera's compass
 * bearing among the CC's work lots, else the nearest lot still needing its After within 40 m.
 * After a shot or Not done, the nearest lot still needing its After, at any distance.
 */
import { metres, pickByRay, type Candidate, type LatLng } from "../flag/pick.ts";

/** The fallback pick reaches this far from the phone. */
export const NEAR_NEEDS_AFTER_M = 40;

/** The nearest item to `at` within `maxM`, leaving out `skip`. */
export const nearest = <T extends LatLng & { id: number }>(at: LatLng, items: readonly T[], maxM = Number.POSITIVE_INFINITY, skip: number | null = null): T | null => {
  let best: { t: T; d: number } | null = null;
  for (const t of items) {
    if (t.id === skip) continue;
    const d = metres(at, t);
    if (d <= maxM && (!best || d < best.d)) best = { t, d };
  }
  return best?.t ?? null;
};

/** The lot the camera faces, else the nearest lot needing its After within 40 m. */
export const pickWrap = <T extends Candidate & { id: number }>(at: LatLng | null, heading: number | null, work: readonly T[], needsAfter: (t: T) => boolean): T | null => {
  if (!at) return null;
  if (heading !== null) {
    const hit = pickByRay(at, heading, work);
    if (hit) return hit;
  }
  return nearest(at, work.filter(needsAfter), NEAR_NEEDS_AFTER_M);
};

/** "2 m" to the metre up close, then the app's usual distance. */
export const spotDistance = (m: number): string => (m < 950 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`);
