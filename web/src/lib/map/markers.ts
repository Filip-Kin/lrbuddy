import L from "leaflet";
import type { LotGeometry } from "../../../../server/db/schema.ts";

export type LotStatus = "open" | "in_progress" | "done" | "skipped";

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
        html: `<span class="lrb-crew-dot"></span><span class="lrb-tag">${escapeHtml(label)}</span>`,
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

/** Teal flag on yellow. */
export const ccIcon = (name: string): L.DivIcon =>
  L.divIcon({
    className: "lrb-cc",
    html: `<span class="lrb-cc-body">${FLAG_SVG}</span><span class="lrb-tag">${escapeHtml(name)}</span>`,
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

/** Small square in the status colour inside a 28 px tap target. */
export const lotIcon = (status: LotStatus, mine = true): L.DivIcon =>
  L.divIcon({
    className: `lrb-lot lrb-lot-${status}${mine ? "" : " lrb-lot-other"}`,
    html: "<span></span>",
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });

/** Parcel outline: 2 px stroke in the status colour, filled at 30 %. Colours come from CSS. */
export const lotShape = (geometry: LotGeometry, status: LotStatus, mine = true): L.GeoJSON =>
  L.geoJSON(geometry, {
    style: () => ({
      className: `lrb-lot-shape lrb-lot-shape-${status}${mine ? "" : " lrb-lot-shape-other"}`,
      weight: 2,
      fillOpacity: 0.3,
    }),
  });

/** Route polyline in the ink colour (set by the `lrb-route` class so it follows the scheme). */
export const routeLine = (points: Array<[number, number]>): L.Polyline =>
  L.polyline(points, { className: "lrb-route", weight: 5, opacity: 0.85, lineJoin: "round", interactive: false });
