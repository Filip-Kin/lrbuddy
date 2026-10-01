/**
 * Labels declutter with zoom (SPEC 20): rectangle name pills and crew name
 * labels show from zoom 16; from 14 to under 16 only the pills of the six
 * largest areas; under 14 none. Crew dots stay and lose their text. One rule
 * for the driver, green, admin and plan maps: the map container carries
 * `lrb-labels-all`, `-big` or `-none`, and CSS hides the rest.
 */
import type L from "leaflet";

export type LabelLevel = "all" | "big" | "none";

export const LABELS_ALL_ZOOM = 16;
export const LABELS_BIG_ZOOM = 14;
/** Pills still shown between zoom 14 and 16. */
export const BIG_AREAS = 6;

export const labelLevel = (zoom: number): LabelLevel => (zoom >= LABELS_ALL_ZOOM ? "all" : zoom >= LABELS_BIG_ZOOM ? "big" : "none");

/** Whether an area's pill shows at this level. */
export const showPill = (level: LabelLevel, big: boolean): boolean => level === "all" || (level === "big" && big);

/** Crew name labels show only at the closest level; the dot always shows. */
export const showCrewName = (level: LabelLevel): boolean => level === "all";

/** Area of a [lng, lat] ring in square metres (shoelace in local metres). */
export const ringAreaM2 = (ring: ReadonlyArray<ReadonlyArray<number>>): number => {
  const pts = ring.filter((p) => p[0] !== undefined && p[1] !== undefined).map((p) => [p[0]!, p[1]!] as const);
  if (pts.length < 3) return 0;
  const lat0 = pts.reduce((n, p) => n + p[1], 0) / pts.length;
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180);
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    s += a[0] * kx * b[1] * 111320 - b[0] * kx * a[1] * 111320;
  }
  return Math.abs(s / 2);
};

/** Ids of the `n` largest areas; ties go to the lower id so the set never flickers. */
export const largestAreaIds = (areas: ReadonlyArray<{ id: number; ring: ReadonlyArray<ReadonlyArray<number>> }>, n = BIG_AREAS): Set<number> =>
  new Set(
    areas
      .map((a) => ({ id: a.id, m2: ringAreaM2(a.ring) }))
      .sort((a, b) => b.m2 - a.m2 || a.id - b.id)
      .slice(0, n)
      .map((a) => a.id),
  );

/** Class names for a pill: `lrb-pill`, plus `lrb-pill-big` for one of the largest areas. */
export const pillClass = (big: boolean): string => (big ? "lrb-pill lrb-pill-big" : "lrb-pill");

const CSS = `
.lrb-labels-big .lrb-crew-tag, .lrb-labels-none .lrb-crew-tag { display: none; }
.lrb-labels-big .lrb-pill:not(.lrb-pill-big), .lrb-labels-none .lrb-pill { display: none; }
`;
let injected = false;
const inject = (): void => {
  if (injected || typeof document === "undefined") return;
  injected = true;
  const el = document.createElement("style");
  el.dataset.lrb = "declutter";
  el.textContent = CSS;
  document.head.appendChild(el);
};

/** Keeps the map container's label class in step with its zoom. Returns the detach. */
export const attachLabelDeclutter = (map: L.Map): (() => void) => {
  inject();
  const el = map.getContainer();
  const apply = (): void => {
    const level = labelLevel(map.getZoom());
    // The zoom, readable from the page (the release gate taps a parcel at zoom 17).
    el.dataset.zoom = String(Math.round(map.getZoom() * 100) / 100);
    for (const l of ["all", "big", "none"] as const) el.classList.toggle(`lrb-labels-${l}`, l === level);
  };
  apply();
  map.on("zoomend", apply);
  return () => {
    map.off("zoomend", apply);
  };
};
