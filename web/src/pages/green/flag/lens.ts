/**
 * The wide lens on the Flag camera (SPEC 22): either the back camera's zoom
 * goes below 1 (one logical camera covering the ultra-wide), or the browser
 * lists the ultra-wide as a camera of its own. Pure functions on what
 * `getCapabilities` and `enumerateDevices` return.
 */

export type Lens = "wide" | "normal";

export interface ZoomRange {
  min: number;
  max: number;
}

/** The `zoom` range in a track's capabilities, or null when it has none. */
export const zoomRangeOf = (caps: unknown): ZoomRange | null => {
  if (typeof caps !== "object" || caps === null || !("zoom" in caps)) return null;
  const z: unknown = (caps as { zoom: unknown }).zoom;
  if (typeof z !== "object" || z === null) return null;
  const min: unknown = (z as { min?: unknown }).min;
  const max: unknown = (z as { max?: unknown }).max;
  if (typeof min !== "number" || typeof max !== "number" || !Number.isFinite(min) || !Number.isFinite(max) || min > max) return null;
  return { min, max };
};

export interface CameraInfo {
  deviceId: string;
  kind: string;
  label: string;
}

const FRONT = /front|user|selfie|face ?time/i;
const TELE = /tele/i;
const RANKS: readonly RegExp[] = [/ultra/i, /0[.,]5/, /\bwide\b/i];

/**
 * The ultra-wide back camera's device id, by label ("ultra", then "0.5",
 * then "wide"), never the camera already open, a front camera or a
 * telephoto. Null when no label says so (Android Chrome's "camera2 2,
 * facing back" says nothing about the field of view).
 */
export const wideCameraId = (devices: readonly CameraInfo[], currentId: string | null): string | null => {
  const back = devices.filter((d) => d.kind === "videoinput" && d.deviceId !== "" && d.deviceId !== currentId && !FRONT.test(d.label) && !TELE.test(d.label));
  for (const re of RANKS) {
    const hit = back.find((d) => re.test(d.label));
    if (hit) return hit.deviceId;
  }
  return null;
};
