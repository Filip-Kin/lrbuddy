import L from "leaflet";
import { useEffect, useRef } from "react";
import type { LotGeometry } from "../../../../../server/db/schema.ts";
import { ESRI_BASE, ESRI_LABELS, MAX_NATIVE_ZOOM, MAX_ZOOM, TILE_ATTRIB } from "../../../lib/map/basemap.ts";
import { hatchLines } from "../../../lib/map/hatch.ts";
import { escapeHtml } from "../../../lib/map/markers.ts";
import { distance } from "../../../lib/format.ts";
import { BLUE, DNT, INK, LOT_FILL, PAPER, WORK, YELLOW, GREY } from "./paper.ts";

// #region types
export type LatLngPair = [number, number];

/**
 * What a printed map draws. Lots: `work` is any lot needing work (overview),
 * `high` and `low` are a crew's lots by survey grade (detail). Areas: `mine`
 * is the crew the sheet is for, `other` a neighbour, `crew` any crew on the CC
 * sheet, `company` one of the company sheet's own areas (thick blue, its name
 * in a pill on the top edge) and `faint` another company's on that sheet.
 * `tint` is the day's area, several rings filled as one.
 */
export type PrintLayer =
  | { kind: "lot"; key: string; geometry: LotGeometry | null; lat: number; lng: number; tone: "work" | "high" | "low" | "dnt"; label?: string; badge?: string }
  | { kind: "area"; key: string; ring: LatLngPair[]; tone: "mine" | "other" | "crew" | "company" | "faint"; label?: string; hatch?: boolean }
  | { kind: "tint"; key: string; rings: LatLngPair[][] };

/** The CC on a printed map: its letter in a circle when it has one, else a star; `blue` is the company sheet's marker. */
export interface PrintCc {
  lat: number;
  lng: number;
  name: string;
  letter?: string | null;
  blue?: boolean;
}

export interface PrintMapProps {
  /** Reported to `onReady` so the page can wait for every map. */
  readyKey: string;
  onReady: (key: string, ready: boolean) => void;
  /** Points the view is fitted to, exactly. */
  fit: readonly LatLngPair[];
  layers: readonly PrintLayer[];
  /** Star or lettered circle when inside the view, else an arrow on the map edge with the distance. */
  cc?: PrintCc | null;
  /** Pixels kept clear around the fit. */
  padding?: number;
  className: string;
  label: string;
}
// #endregion

// #region drawing
/** Labels are measured on a canvas, so the font here and in `.lrb-pm-label` must match. */
export const LABEL_FONT = '700 10px ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const LABEL_H = 15;
/** The company sheet's area names: bigger, in a pill. Must match `.lrb-pm-pill`. */
export const PILL_FONT = '800 12px ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const PILL_H = 20;
const PILL_PAD = 8;
/** The company sheet's CC circle (SPEC 19). */
const CC_BLUE_D = 28;
const CC_DOT_D = 24;
const LABEL_PAD = 3;
const BADGE_W = 12;
/** Grid step in pixels when a label has to search the whole frame for room. */
const SCAN_STEP = 4;

const STAR_SVG = `<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path d="M12 1.8l3 6.6 7.2.8-5.4 4.9 1.5 7.1L12 17.6l-6.3 3.6 1.5-7.1L1.8 9.2 9 8.4z" fill="#000" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
const ARROW_SVG = `<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><path d="M2 8.5h11V3l9 9-9 9v-5.5H2z" fill="#000" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>`;

let measureCtx: CanvasRenderingContext2D | null = null;
const textWidth = (s: string, font = LABEL_FONT): number => {
  measureCtx ??= document.createElement("canvas").getContext("2d");
  if (!measureCtx) return s.length * 7;
  measureCtx.font = font;
  return measureCtx.measureText(s).width;
};

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
const overlaps = (a: Box, b: Box): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const inside = (b: Box, size: L.Point, m: number): boolean => b.x >= m && b.y >= m && b.x + b.w <= size.x - m && b.y + b.h <= size.y - m;

/**
 * First spot next to the anchor box where the label fits the frame and clears
 * every label and lot already placed, in rings further out on each miss
 * (`far` then wants a leader line). `inner` is an area the label may sit
 * inside, along its top edge first. With every ring taken, the free spot
 * nearest the anchor anywhere in the frame; null when the frame has none, and
 * the label is left off rather than drawn over another.
 */
const placeBox = (a: Box, w: number, h: number, taken: readonly Box[], size: L.Point, inner?: Box): { box: Box; far: boolean } | null => {
  const cx = a.x + a.w / 2;
  const cy = a.y + a.h / 2;
  const spots: Array<[number, number, boolean]> = [];
  if (inner && inner.w >= w + 12 && inner.h >= h + 12) {
    const left = inner.x + 6;
    const right = inner.x + inner.w - 6 - w;
    const top = inner.y + 6;
    const bottom = inner.y + inner.h - 6 - h;
    spots.push([inner.x + (inner.w - w) / 2, top, false], [left, top, false], [right, top, false], [left, bottom, false], [right, bottom, false]);
  }
  for (const d of [3, 14, 28, 46]) {
    const far = d > 3;
    spots.push(
      [a.x + a.w + d, cy - h / 2, far],
      [a.x - d - w, cy - h / 2, far],
      [cx - w / 2, a.y - d - h, far],
      [cx - w / 2, a.y + a.h + d, far],
      [a.x + a.w + d, a.y - d - h, far],
      [a.x + a.w + d, a.y + a.h + d, far],
      [a.x - d - w, a.y - d - h, far],
      [a.x - d - w, a.y + a.h + d, far],
    );
  }
  for (const [x, y, far] of spots) {
    const box = { x, y, w, h };
    if (inside(box, size, 2) && !taken.some((t) => overlaps(t, box))) return { box, far };
  }
  let best: Box | null = null;
  let bestD = Infinity;
  for (let y = 2; y + h <= size.y - 2; y += SCAN_STEP) {
    for (let x = 2; x + w <= size.x - 2; x += SCAN_STEP) {
      const d = (x + w / 2 - cx) ** 2 + (y + h / 2 - cy) ** 2;
      if (d >= bestD) continue;
      const box = { x, y, w, h };
      if (taken.some((t) => overlaps(t, box))) continue;
      best = box;
      bestD = d;
    }
  }
  return best ? { box: best, far: true } : null;
};

const around = (p: L.Point, r: number): Box => ({ x: p.x - r, y: p.y - r, w: 2 * r, h: 2 * r });

/** Label marker whose box sits at `box` in container pixels while the marker stays on `at`. */
const labelMarker = (m: L.Map, at: L.Point, box: Box, html: string, cls: string): L.Marker =>
  L.marker(m.containerPointToLatLng(at), {
    interactive: false,
    keyboard: false,
    icon: L.divIcon({ className: `lrb-pm-label ${cls}`, html, iconSize: [box.w, box.h], iconAnchor: [at.x - box.x, at.y - box.y] }),
  });

/** Thin line from what a label names to the nearest edge of the label, for one pushed away from it. */
const leader = (m: L.Map, from: Box, box: Box, color = INK): L.Polyline => {
  const c = L.point(box.x + box.w / 2, box.y + box.h / 2);
  const a = L.point(Math.min(Math.max(c.x, from.x), from.x + from.w), Math.min(Math.max(c.y, from.y), from.y + from.h));
  const x = Math.min(Math.max(a.x, box.x), box.x + box.w);
  const y = Math.min(Math.max(a.y, box.y), box.y + box.h);
  return L.polyline([m.containerPointToLatLng(a), m.containerPointToLatLng(L.point(x, y))], { color, weight: 1, opacity: 0.8, interactive: false });
};

const metres = (a: L.LatLng, b: L.LatLng): number => {
  const r = 6371000;
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(h));
};

const lotStyle = (tone: "work" | "high" | "low" | "dnt"): L.PathOptions =>
  tone === "dnt"
    ? { color: DNT, weight: 1.2, fillColor: DNT, fillOpacity: 0.12, interactive: false }
    : {
        color: INK,
        weight: tone === "work" ? 1 : 1.5,
        dashArray: tone === "work" ? undefined : "4 3",
        fillColor: WORK,
        fillOpacity: LOT_FILL[tone],
        interactive: false,
      };

const labelHtml = (text: string, badge?: string): string =>
  `<span class="lrb-pm-text">${escapeHtml(text)}</span>${badge ? `<b class="lrb-pm-badge">${escapeHtml(badge)}</b>` : ""}`;

const labelWidth = (text: string, badge?: string): number => Math.ceil(textWidth(text)) + LABEL_PAD * 2 + (badge ? BADGE_W + 3 : 0);

/** Draws every overlay for the current view. Labels are placed in pixels, so this reruns on resize. */
const drawOverlays = (m: L.Map, group: L.LayerGroup, layers: readonly PrintLayer[], cc: PrintMapProps["cc"]): void => {
  group.clearLayers();
  const size = m.getSize();
  const taken: Box[] = [];
  const pt = (lat: number, lng: number): L.Point => m.latLngToContainerPoint([lat, lng]);

  // The day's area first, under everything: one path, nonzero fill, so overlapping rings tint once.
  for (const t of layers) {
    if (t.kind !== "tint" || t.rings.length === 0) continue;
    L.polygon(t.rings, { stroke: false, fillColor: YELLOW, fillOpacity: 0.15, fillRule: "nonzero", interactive: false }).addTo(group);
  }
  // Areas under lots: halo, then ink. Other companies' areas under this company's.
  for (const a of [...layers].sort((x, y) => Number(x.kind === "area" && x.tone === "company") - Number(y.kind === "area" && y.tone === "company"))) {
    if (a.kind !== "area" || a.ring.length < 3) continue;
    if (a.tone === "company" || a.tone === "faint") {
      L.polygon(a.ring, {
        color: a.tone === "company" ? BLUE : GREY,
        weight: a.tone === "company" ? 4 : 1.2,
        opacity: a.tone === "company" ? 1 : 0.9,
        fill: false,
        interactive: false,
        lineJoin: "miter",
      }).addTo(group);
    } else if (a.tone === "mine") {
      L.polygon(a.ring, { color: YELLOW, weight: 11, opacity: 1, fill: false, interactive: false, lineJoin: "round" }).addTo(group);
      L.polygon(a.ring, { color: INK, weight: 4, opacity: 1, fill: false, interactive: false, lineJoin: "round" }).addTo(group);
    } else {
      L.polygon(a.ring, { color: a.tone === "other" ? GREY : INK, weight: a.tone === "other" ? 1.5 : 2.5, opacity: 1, fill: false, interactive: false }).addTo(group);
    }
    // Do not touch (SPEC 19 Marks): hatched in the outline's own colour, so it survives greyscale.
    if (a.hatch) {
      const color = a.tone === "company" ? BLUE : a.tone === "faint" || a.tone === "other" ? GREY : INK;
      for (const seg of hatchLines(a.ring.map(([lat, lng]) => [lng, lat]))) L.polyline(seg, { color, weight: 1.2, opacity: 0.9, interactive: false }).addTo(group);
    }
  }
  const anchors: Array<{ box: Box; at: L.Point; text: string; badge?: string }> = [];
  for (const l of layers) {
    if (l.kind !== "lot") continue;
    let box: Box;
    if (l.geometry) {
      const b = L.geoJSON(l.geometry, { style: () => lotStyle(l.tone), interactive: false }).addTo(group).getBounds();
      // Do not touch prints hatched (SPEC 21), the same 3 m stripes as the screen maps.
      if (l.tone === "dnt") {
        const rings = l.geometry.type === "Polygon" ? [l.geometry.coordinates[0] ?? []] : l.geometry.coordinates.map((p) => p[0] ?? []);
        for (const r of rings) for (const seg of hatchLines(r, 3)) L.polyline(seg, { color: DNT, weight: 1, opacity: 0.9, interactive: false }).addTo(group);
      }
      const nw = pt(b.getNorth(), b.getWest());
      const se = pt(b.getSouth(), b.getEast());
      box = { x: nw.x, y: nw.y, w: Math.max(se.x - nw.x, 4), h: Math.max(se.y - nw.y, 4) };
    } else {
      L.circleMarker([l.lat, l.lng], { ...lotStyle(l.tone), radius: 4 }).addTo(group);
      box = around(pt(l.lat, l.lng), 5);
    }
    // Unlabelled lots (overview dots) may sit under a label; a lot off the frame gets none.
    if (!l.label || box.x + box.w < 0 || box.y + box.h < 0 || box.x > size.x || box.y > size.y) continue;
    taken.push(box);
    anchors.push({ box, at: L.point(box.x + box.w / 2, box.y + box.h / 2), text: l.label, badge: l.badge });
  }

  // CC: a lettered circle (or a star) inside the view, else an arrow on the edge pointing at it.
  if (cc) {
    const p = pt(cc.lat, cc.lng);
    const margin = 16;
    const box = { x: margin, y: margin, w: size.x - 2 * margin, h: size.y - 2 * margin };
    if (p.x >= box.x && p.x <= box.x + box.w && p.y >= box.y && p.y <= box.y + box.h) {
      const d = cc.blue ? CC_BLUE_D : CC_DOT_D;
      // The company sheet's marker is always the blue circle, empty when the CC has no letter yet.
      const circle = !!cc.letter || !!cc.blue;
      const icon = circle
        ? L.divIcon({ className: cc.blue ? "lrb-pm-ccb" : "lrb-pm-ccl", html: escapeHtml(cc.letter ?? ""), iconSize: [d, d], iconAnchor: [d / 2, d / 2] })
        : L.divIcon({ className: "lrb-pm-star", html: STAR_SVG, iconSize: [24, 24], iconAnchor: [12, 12] });
      L.marker([cc.lat, cc.lng], { interactive: false, keyboard: false, zIndexOffset: 1000, icon }).addTo(group);
      const r = circle ? d / 2 : 12;
      taken.push({ x: p.x - r, y: p.y - r, w: 2 * r, h: 2 * r });
      // The company sheet names its CC in the header, so its circle carries no tag.
      if (!cc.blue) {
        const text = `CC ${cc.name}`;
        const placed = placeBox(around(p, r), labelWidth(text), LABEL_H, taken, size);
        if (placed) {
          taken.push(placed.box);
          if (placed.far) leader(m, around(p, r), placed.box).addTo(group);
          labelMarker(m, p, placed.box, labelHtml(text), "lrb-pm-cc").addTo(group);
        }
      }
    } else {
      const c = L.point(size.x / 2, size.y / 2);
      const dx = p.x - c.x;
      const dy = p.y - c.y;
      const tx = dx > 0 ? (size.x - margin - c.x) / dx : dx < 0 ? (margin - c.x) / dx : Infinity;
      const ty = dy > 0 ? (size.y - margin - c.y) / dy : dy < 0 ? (margin - c.y) / dy : Infinity;
      const t = Math.min(tx, ty);
      const e = L.point(c.x + dx * t, c.y + dy * t);
      const deg = (Math.atan2(dy, dx) * 180) / Math.PI;
      L.marker(m.containerPointToLatLng(e), {
        interactive: false,
        keyboard: false,
        zIndexOffset: 1000,
        icon: L.divIcon({ className: "lrb-pm-arrow", html: `<span style="transform: rotate(${deg.toFixed(1)}deg)">${ARROW_SVG}</span>`, iconSize: [26, 26], iconAnchor: [13, 13] }),
      }).addTo(group);
      taken.push({ x: e.x - 13, y: e.y - 13, w: 26, h: 26 });
      const text = `CC ${cc.name} ${distance(metres(m.containerPointToLatLng(c), L.latLng(cc.lat, cc.lng)))}`;
      const placed = placeBox(around(e, 13), labelWidth(text), LABEL_H, taken, size);
      if (placed) {
        taken.push(placed.box);
        if (placed.far) leader(m, around(e, 13), placed.box).addTo(group);
        labelMarker(m, e, placed.box, labelHtml(text), "lrb-pm-cc").addTo(group);
      }
    }
  }

  // Company sheet (SPEC 19): each area's name in a pill centred on its top edge,
  // slid along the edge when another label is there, else the nearest free spot
  // with a leader line. Never over another label, never past the frame.
  const pills = layers.filter((a): a is Extract<PrintLayer, { kind: "area" }> => a.kind === "area" && a.tone === "company" && !!a.label && a.ring.length >= 3);
  const tops = pills
    .map((a) => {
      const ps = a.ring.map(([lat, lng]) => pt(lat, lng));
      if (ps.length > 1 && ps[0]!.distanceTo(ps[ps.length - 1]!) < 0.5) ps.pop();
      let best: [L.Point, L.Point] = [ps[0]!, ps[1] ?? ps[0]!];
      let bestY = Infinity;
      for (let i = 0; i < ps.length; i++) {
        const p = ps[i]!;
        const q = ps[(i + 1) % ps.length]!;
        const y = (p.y + q.y) / 2;
        // A near-tie goes to the longer edge, the one the eye reads as the top.
        if (y < bestY - 2 || (Math.abs(y - bestY) <= 2 && p.distanceTo(q) > best[0].distanceTo(best[1]))) {
          best = [p, q];
          bestY = Math.min(y, bestY);
        }
      }
      return { a, edge: best };
    })
    .sort((x, y) => (x.edge[0].y + x.edge[1].y) / 2 - (y.edge[0].y + y.edge[1].y) / 2);
  for (const { a, edge } of tops) {
    const text = a.label ?? "";
    const w = Math.ceil(textWidth(text, PILL_FONT)) + PILL_PAD * 2;
    const h = PILL_H;
    const [p, q] = edge;
    let placed: { box: Box; far: boolean } | null = null;
    for (const t of [0.5, 0.42, 0.58, 0.34, 0.66, 0.25, 0.75, 0.15, 0.85]) {
      const box = { x: p.x + (q.x - p.x) * t - w / 2, y: p.y + (q.y - p.y) * t - h / 2, w, h };
      if (inside(box, size, 2) && !taken.some((o) => overlaps(o, box))) {
        placed = { box, far: false };
        break;
      }
    }
    const mid = L.point((p.x + q.x) / 2, (p.y + q.y) / 2);
    placed ??= placeBox(around(mid, 3), w, h, taken, size);
    if (!placed) continue;
    taken.push(placed.box);
    if (placed.far) leader(m, around(mid, 3), placed.box, BLUE).addTo(group);
    labelMarker(m, mid, placed.box, `<span class="lrb-pm-text">${escapeHtml(text)}</span>`, "lrb-pm-pill").addTo(group);
  }

  // Area names: this crew's first, inside the area where there is room.
  // Other names keep off this crew's outline (its halo, every few pixels along
  // each edge) and are dropped when there is no room for them elsewhere.
  const guard: Box[] = [];
  for (const a of layers) {
    if (a.kind !== "area" || a.tone !== "mine" || a.ring.length < 3) continue;
    const ps = a.ring.map(([lat, lng]) => pt(lat, lng));
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i]!;
      const q = ps[(i + 1) % ps.length]!;
      const steps = Math.max(1, Math.ceil(p.distanceTo(q) / 4));
      for (let k = 0; k <= steps; k++) guard.push(around(L.point(p.x + ((q.x - p.x) * k) / steps, p.y + ((q.y - p.y) * k) / steps), 6));
    }
  }
  const areas = layers
    .filter((a): a is Extract<PrintLayer, { kind: "area" }> => a.kind === "area" && a.tone !== "company" && a.tone !== "faint" && !!a.label && a.ring.length >= 3)
    .sort((a, b) => Number(b.tone === "mine") - Number(a.tone === "mine"));
  for (const a of areas) {
    const b = L.latLngBounds(a.ring);
    const nw = pt(b.getNorth(), b.getWest());
    const se = pt(b.getSouth(), b.getEast());
    const area = { x: nw.x, y: nw.y, w: se.x - nw.x, h: se.y - nw.y };
    const at = L.point(nw.x + area.w / 2, nw.y + area.h / 2);
    const text = a.label ?? "";
    const mine = a.tone === "mine";
    const placed = placeBox(area, labelWidth(text), LABEL_H, mine ? taken : [...taken, ...guard], size, area);
    if (!placed || (!mine && guard.some((g) => overlaps(g, placed.box)))) continue;
    taken.push(placed.box);
    if (placed.far) leader(m, area, placed.box).addTo(group);
    labelMarker(m, at, placed.box, labelHtml(text), a.tone === "other" ? "lrb-pm-other" : "lrb-pm-area").addTo(group);
  }

  // Lot labels, left to right so neighbours fan out the same way.
  anchors.sort((a, b) => a.at.x - b.at.x || a.at.y - b.at.y);
  for (const a of anchors) {
    const placed = placeBox(a.box, labelWidth(a.text, a.badge), LABEL_H, taken, size);
    if (!placed) continue;
    taken.push(placed.box);
    if (placed.far) leader(m, a.box, placed.box).addTo(group);
    labelMarker(m, a.at, placed.box, labelHtml(a.text, a.badge), "").addTo(group);
  }
};
// #endregion

/** Tiles that never finish (offline, a blocked host) stop holding up Print after this long. */
const TILE_TIMEOUT_MS = 20_000;

/**
 * A still Leaflet map for paper: light basemap whatever the screen scheme,
 * no controls, no panning, every mark in SVG. Reports ready once both tile
 * layers have fired `load` for the fitted view.
 */
export const PrintMap = ({ readyKey, onReady, fit, layers, cc, padding = 18, className, label }: PrintMapProps) => {
  const holder = useRef<HTMLDivElement>(null);
  const readyRef = useRef(onReady);
  readyRef.current = onReady;

  useEffect(() => {
    const el = holder.current;
    if (!el || fit.length === 0) return;
    const report = (ready: boolean): void => readyRef.current(readyKey, ready);
    report(false);
    const m = L.map(el, {
      zoomControl: false,
      attributionControl: true,
      dragging: false,
      touchZoom: false,
      doubleClickZoom: false,
      scrollWheelZoom: false,
      boxZoom: false,
      keyboard: false,
      zoomSnap: 0,
      fadeAnimation: false,
      zoomAnimation: false,
      markerZoomAnimation: false,
      maxZoom: MAX_ZOOM,
    });
    m.attributionControl.setPrefix(false);
    const bounds = L.latLngBounds(fit.map((p) => L.latLng(p[0], p[1])));
    const fitView = (): void => {
      if (fit.length === 1 || bounds.getNorthEast().equals(bounds.getSouthWest())) m.setView(bounds.getCenter(), 17);
      else m.fitBounds(bounds, { padding: [padding, padding], maxZoom: 18, animate: false });
    };
    fitView();
    const group = L.layerGroup().addTo(m);
    drawOverlays(m, group, layers, cc);

    const loading = new Set<L.TileLayer>();
    let done = false;
    const settle = (): void => {
      if (loading.size === 0 && !done) {
        done = true;
        report(true);
      }
    };
    const opts: L.TileLayerOptions = { maxNativeZoom: MAX_NATIVE_ZOOM, maxZoom: MAX_ZOOM };
    for (const url of [ESRI_BASE, ESRI_LABELS]) {
      const layer = L.tileLayer(url, url === ESRI_BASE ? { ...opts, attribution: TILE_ATTRIB } : opts);
      loading.add(layer);
      layer.on("loading", () => {
        loading.add(layer);
        done = false;
        report(false);
      });
      layer.on("load", () => {
        loading.delete(layer);
        settle();
      });
      layer.addTo(m);
      layer.bringToBack();
    }
    const timer = window.setTimeout(() => {
      loading.clear();
      settle();
    }, TILE_TIMEOUT_MS);

    // Same size on screen and on paper; a narrower screen redraws for its own width.
    let lastW = el.clientWidth;
    let lastH = el.clientHeight;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === lastW && el.clientHeight === lastH) return;
      lastW = el.clientWidth;
      lastH = el.clientHeight;
      m.invalidateSize({ pan: false });
      fitView();
      drawOverlays(m, group, layers, cc);
    });
    ro.observe(el);
    return () => {
      window.clearTimeout(timer);
      ro.disconnect();
      m.remove();
      readyRef.current(readyKey, false);
    };
  }, [readyKey, fit, layers, cc, padding]);

  return <div ref={holder} role="img" aria-label={label} className={`lrb-pm ${className}`} style={{ background: PAPER }} />;
};
