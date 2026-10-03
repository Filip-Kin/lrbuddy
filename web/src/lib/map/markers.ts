import L from "leaflet";
import type { LotGeometry, LotStatus } from "../../../../server/db/schema.ts";
import { hatchLines } from "./hatch.ts";

export type { LotStatus };

export const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

const TRUCK_SVG =
  '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M3 6h11v9H3zM14 9h4l3 3v3h-7z"/><circle cx="7" cy="17" r="2" fill="currentColor"/><circle cx="17" cy="17" r="2" fill="currentColor"/></svg>';
const FLAG_SVG =
  '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M5 3h2v18H5zM7 4h11l-2 4 2 4H7z"/></svg>';

/** Blue dot; the accuracy halo is drawn by MapView. */
export const meIcon = (): L.DivIcon =>
  L.divIcon({ className: "lrb-me", html: '<span class="lrb-me-dot"></span>', iconSize: [22, 22], iconAnchor: [11, 11] });

/** Red dot with a name tag; muted is a small grey dot for context (other crews of the company). */
export const crewIcon = (label: string, muted = false): L.DivIcon =>
  muted
    ? L.divIcon({ className: "lrb-crew lrb-crew-muted", html: '<span class="lrb-crew-dot"></span>', iconSize: [16, 16], iconAnchor: [8, 8] })
    : L.divIcon({
        className: "lrb-crew",
        html: `<span class="lrb-crew-dot"></span><span class="lrb-tag lrb-crew-tag">${escapeHtml(label)}</span>`,
        iconSize: [28, 28],
        iconAnchor: [14, 14],
      });

/** Yellow rounded square with the truck name under it. */
export const truckIcon = (name: string, highlight = false): L.DivIcon =>
  L.divIcon({
    className: `lrb-truck${highlight ? " lrb-truck-hl" : ""}`,
    html: `<span class="lrb-truck-body">${TRUCK_SVG}</span><span class="lrb-tag">${escapeHtml(name)}</span>`,
    iconSize: [34, 34],
    iconAnchor: [17, 17],
  });

/** What a CC marker carries: its letter for the day when it has one (SPEC 19), else `fallback` (an icon). */
export const ccBody = (letter: string | null | undefined, fallback: string): string =>
  letter ? `<span class="lrb-cc-body lrb-cc-letter">${escapeHtml(letter)}</span>` : `<span class="lrb-cc-body">${fallback}</span>`;

/** Yellow circle with the CC's letter in teal, or a teal flag when it has none. */
export const ccIcon = (name: string, letter?: string | null): L.DivIcon =>
  L.divIcon({
    className: "lrb-cc",
    html: `${ccBody(letter, FLAG_SVG)}<span class="lrb-tag">${escapeHtml(name)}</span>`,
    iconSize: [36, 36],
    iconAnchor: [18, 18],
  });

/** Pulsing ring drawn around a crew with an open request. */
export const requestIcon = (urgent: boolean): L.DivIcon =>
  L.divIcon({
    className: `lrb-req${urgent ? " lrb-req-urgent" : ""}`,
    html: "<span></span>",
    iconSize: [40, 40],
    iconAnchor: [20, 20],
  });

/** Numbered route stop. */
export const stopIcon = (n: number, active = false): L.DivIcon =>
  L.divIcon({
    className: `lrb-stop${active ? " lrb-stop-active" : ""}`,
    html: `<span>${n}</span>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });

const CAMERA_SVG =
  '<svg viewBox="0 0 24 24" width="11" height="11" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8.5A1.5 1.5 0 0 1 5 7h2.5L9 4.5h6L16.5 7H19a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5zM12 16.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z"/></svg>';

/**
 * Camera badge at a lot with a Before and no After (Wrap up): an ink camera in a 16 px white
 * circle, so it reads as "photo missing" and never as a crew dot or the blue dot. `style` keeps it
 * upright on a turned map (the driver map passes its counter-rotation).
 */
export const cameraBadgeIcon = (style = ""): L.DivIcon =>
  L.divIcon({
    className: "lrb-cam",
    html: `<span class="lrb-cam-body"${style ? ` style="${style}"` : ""}>${CAMERA_SVG}</span>`,
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  });

/** A tire seen from the side: dark rubber with tread notches and a grey hub (SPEC 29). Also the legend's swatch. */
export const TIRE_SVG =
  '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><circle cx="12" cy="12" r="11" fill="#1d1f21" stroke="#fff" stroke-width="1.5"/><g stroke="#8a9599" stroke-width="1.6" stroke-linecap="round"><path d="M12 2.6v2.2M12 19.2v2.2M2.6 12h2.2M19.2 12h2.2M5.4 5.4l1.5 1.5M17.1 17.1l1.5 1.5M5.4 18.6l1.5-1.5M17.1 6.9l1.5-1.5"/></g><circle cx="12" cy="12" r="4.6" fill="#b9c3c6" stroke="#1d1f21" stroke-width="1.2"/><circle cx="12" cy="12" r="1.5" fill="#1d1f21"/></svg>';

/**
 * Tire pile (SPEC 29): a dark tire in a 40 px tap target, never a dot or a square. `badge` adds the
 * camera badge (Wrap up: no photo yet), `picked` a yellow ring, `pin` a lift for the pile being placed.
 * `style` keeps it upright on a turned map.
 */
export const tireIcon = (opts: { badge?: boolean; picked?: boolean; pin?: boolean; style?: string } = {}): L.DivIcon =>
  L.divIcon({
    className: `lrb-tire${opts.picked ? " lrb-tire-picked" : ""}${opts.pin ? " lrb-tire-pin" : ""}`,
    html: `<span class="lrb-tire-body"${opts.style ? ` style="${opts.style}"` : ""}>${TIRE_SVG}${opts.badge ? `<span class="lrb-cam-body lrb-tire-cam">${CAMERA_SVG}</span>` : ""}</span>`,
    iconSize: [40, 40],
    iconAnchor: [20, 20],
  });

/** Small square in the status colour inside a 28 px tap target. */
export const lotIcon = (status: LotStatus, mine = true, selected = false): L.DivIcon =>
  L.divIcon({
    className: `lrb-lot lrb-lot-${status}${mine ? "" : " lrb-lot-other"}${selected ? " lrb-lot-selected" : ""}`,
    html: "<span></span>",
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });

/**
 * Parcel outline: 2 px stroke in the status colour, filled at 30 %. Colours come from CSS.
 * `opts` passes a pane or renderer through to the outline (the driver map draws lots in their own pane).
 */
export const lotShape = (geometry: LotGeometry, status: LotStatus, mine = true, selected = false, opts: Pick<L.PathOptions, "pane" | "renderer"> = {}): L.GeoJSON => {
  const shape = L.geoJSON(geometry, {
    ...opts,
    style: () => ({
      className: `lrb-lot-shape lrb-lot-shape-${status}${mine ? "" : " lrb-lot-shape-other"}${selected ? " lrb-lot-shape-selected" : ""}`,
      weight: status === "not_todo" ? 1 : 2,
      fillOpacity: 0.3,
    }),
  });
  // Do not touch is hatched on every map (SPEC 21), with plain lines so print and canvas maps draw it too.
  if (status === "do_not_touch") {
    for (const seg of lotHatch(geometry)) shape.addLayer(L.polyline(seg, { ...opts, className: "lrb-lot-hatch", weight: 1.5, interactive: false }));
  }
  return shape;
};

/** Hatch segments across each outer ring of a parcel, 3 m apart (a parcel is about 10 m wide). */
export const lotHatch = (geometry: LotGeometry): Array<[[number, number], [number, number]]> => {
  const rings = geometry.type === "Polygon" ? [geometry.coordinates[0] ?? []] : geometry.coordinates.map((p) => p[0] ?? []);
  return rings.flatMap((r) => hatchLines(r, 3));
};

/**
 * A cached parcel with no lot (Not todo, SPEC 21): a thin outline that takes a tap.
 * The fill is there only so the whole parcel, not just its edge, is the tap target.
 */
export const parcelShape = (geometry: LotGeometry, opts: Pick<L.PathOptions, "pane" | "renderer"> = {}): L.GeoJSON =>
  L.geoJSON(geometry, { ...opts, style: () => ({ className: "lrb-parcel-shape", weight: 1, fillOpacity: 0.01 }) });

/** Route polyline in the ink colour (set by the `lrb-route` class so it follows the scheme). */
export const routeLine = (points: Array<[number, number]>): L.Polyline =>
  L.polyline(points, { className: "lrb-route", weight: 5, opacity: 0.85, lineJoin: "round", interactive: false });

/** Thin dashed ink outline for a rectangle drawn on the map. */
export const selectLine = (points: Array<[number, number]>): L.Polyline =>
  L.polyline(points, { className: "lrb-select", weight: 2, dashArray: "6 5", interactive: false });
