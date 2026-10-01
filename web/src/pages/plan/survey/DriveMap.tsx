import L from "leaflet";
import { useEffect, useRef, useState } from "react";
import type { LotGeometry } from "../../../../../server/db/schema.ts";
import { DEFAULT_CENTER, ESRI_BASE, ESRI_DARK_BASE, ESRI_DARK_LABELS, ESRI_LABELS, MAX_NATIVE_ZOOM, MAX_ZOOM } from "../../../lib/map/basemap.ts";
import { escapeHtml } from "../../../lib/map/markers.ts";
import { ahead, metresPerPixel, turn, type LatLng } from "./geo.ts";
import { gradeColour, toLatLngs, usePalette, usePrefersDark, type Grade } from "./style.ts";

export interface DriveShape {
  parcelId: string;
  lat: number;
  lng: number;
  geometry: LotGeometry | null;
  grade: Grade | null;
  /** 1 for the parcel a tap tags, 2 for the next one on that side. */
  rank: 1 | 2 | null;
  label: string | null;
}

/** Share of the visible height the car sits below the centre, so more road ahead shows. */
const LOOK_AHEAD = 0.22;

/** The car: a blue dot with a heading cone, drawn in map space so the map's rotation turns it upright. */
const carIcon = (heading: number | null): L.DivIcon =>
  L.divIcon({
    className: "lrb-me",
    iconSize: [64, 64],
    iconAnchor: [32, 32],
    html:
      (heading === null
        ? ""
        : `<svg viewBox="0 0 64 64" width="64" height="64" aria-hidden="true" style="position:absolute;left:0;top:0;transform:rotate(${heading}deg)"><path d="M32 32 L18 3 A30 30 0 0 1 46 3 Z" fill="#2f80ed" fill-opacity="0.28" stroke="#2f80ed" stroke-opacity="0.6"/></svg>`) +
      '<span style="position:absolute;left:21px;top:21px"><span class="lrb-me-dot"></span></span>',
  });

/** House number tag on a highlighted parcel; counter-rotated so it reads upright on a turned map. */
const labelIcon = (text: string): L.DivIcon =>
  L.divIcon({
    className: "",
    iconSize: [0, 0],
    iconAnchor: [0, 0],
    html: `<span style="display:block;transform:translate(-50%,-50%) rotate(var(--lrb-unrot,0deg))" class="w-max rounded-md bg-brand px-1.5 py-0.5 text-sm font-bold text-on-brand shadow ring-1 ring-black/30">${escapeHtml(text)}</span>`,
  });

/**
 * Drive mode map, heading up. Leaflet cannot rotate, so the map sits in a
 * square as wide as the frame's diagonal and the square turns by minus the
 * heading with a CSS transform; the corners never show blank. Labels turn back
 * the other way through `--lrb-unrot`. The map does not pan or zoom by touch;
 * it follows the car.
 */
export const DriveMap = ({ fix, heading, shapes, zoom }: { fix: LatLng | null; heading: number | null; shapes: readonly DriveShape[]; zoom: number }) => {
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const tiles = useRef<L.Layer[]>([]);
  const shapeLayer = useRef<L.LayerGroup | null>(null);
  const carLayer = useRef<L.LayerGroup | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const rot = useRef(0);
  const dark = usePrefersDark();
  const pal = usePalette();

  useEffect(() => {
    const el = outer.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!inner.current || map.current) return;
    const m = L.map(inner.current, {
      zoomControl: false,
      attributionControl: false,
      dragging: false,
      touchZoom: false,
      scrollWheelZoom: false,
      doubleClickZoom: false,
      boxZoom: false,
      keyboard: false,
      zoomSnap: 0,
      maxZoom: MAX_ZOOM,
    }).setView(DEFAULT_CENTER, zoom);
    shapeLayer.current = L.layerGroup().addTo(m);
    carLayer.current = L.layerGroup().addTo(m);
    map.current = m;
    return () => {
      m.remove();
      map.current = null;
      tiles.current = [];
    };
  }, []);

  useEffect(() => {
    const m = map.current;
    if (!m) return;
    for (const t of tiles.current) m.removeLayer(t);
    const opts = { maxNativeZoom: MAX_NATIVE_ZOOM, maxZoom: MAX_ZOOM };
    tiles.current = [L.tileLayer(dark ? ESRI_DARK_BASE : ESRI_BASE, opts).addTo(m), L.tileLayer(dark ? ESRI_DARK_LABELS : ESRI_LABELS, opts).addTo(m)];
    for (const t of tiles.current) (t as L.TileLayer).bringToBack();
  }, [dark]);

  const d = Math.ceil(Math.hypot(size.w, size.h));

  useEffect(() => {
    map.current?.invalidateSize({ pan: false });
  }, [d]);

  // Follow the car: turn the square to the heading, centre a little ahead of the car.
  useEffect(() => {
    const m = map.current;
    const el = inner.current;
    if (!m || !el) return;
    if (heading !== null) rot.current += turn(rot.current, -heading);
    el.style.transform = `rotate(${rot.current}deg)`;
    el.style.setProperty("--lrb-unrot", `${-rot.current}deg`);
    if (!fix) return;
    const shift = heading === null ? 0 : LOOK_AHEAD * size.h * metresPerPixel(fix.lat, zoom);
    const c = heading === null ? fix : ahead(fix, heading, shift);
    if (Math.abs(m.getZoom() - zoom) > 0.01) m.setView([c.lat, c.lng], zoom, { animate: false });
    else m.panTo([c.lat, c.lng], { animate: true, duration: 0.6, easeLinearity: 1 });
  }, [fix, heading, zoom, size.h, d]);

  useEffect(() => {
    const g = carLayer.current;
    if (!g) return;
    g.clearLayers();
    if (fix) L.marker([fix.lat, fix.lng], { icon: carIcon(heading), interactive: false, keyboard: false, zIndexOffset: 1000 }).addTo(g);
  }, [fix, heading]);

  useEffect(() => {
    const g = shapeLayer.current;
    if (!g) return;
    g.clearLayers();
    const ranked: DriveShape[] = [];
    for (const s of shapes) {
      if (s.rank !== null) {
        ranked.push(s);
        continue;
      }
      const c = gradeColour(pal, s.grade);
      const style = { color: s.grade ? c : pal.muted, weight: 1.5, opacity: 0.8, fillColor: c, fillOpacity: s.grade && s.grade !== "clear" ? 0.45 : 0.08, interactive: false };
      if (s.geometry) L.polygon(toLatLngs(s.geometry), style).addTo(g);
    }
    for (const s of ranked) {
      const c = gradeColour(pal, s.grade);
      if (s.geometry) {
        if (s.rank === 1) L.polygon(toLatLngs(s.geometry), { color: pal.brand, weight: 10, opacity: 0.85, fill: false, interactive: false }).addTo(g);
        L.polygon(toLatLngs(s.geometry), {
          color: pal.ink,
          weight: s.rank === 1 ? 3 : 2,
          dashArray: s.rank === 1 ? undefined : "6 5",
          fillColor: c,
          fillOpacity: s.grade && s.grade !== "clear" ? 0.5 : 0.15,
          interactive: false,
        }).addTo(g);
      }
      if (s.rank === 1 && s.label) L.marker([s.lat, s.lng], { icon: labelIcon(s.label), interactive: false, keyboard: false, zIndexOffset: 500 }).addTo(g);
    }
  }, [shapes, pal]);

  return (
    <div ref={outer} role="region" aria-label="Drive map" className="absolute inset-0 overflow-hidden bg-surface-2">
      <div
        ref={inner}
        className="absolute transition-transform duration-500 ease-linear motion-reduce:transition-none"
        style={{ width: d || "100%", height: d || "100%", left: (size.w - d) / 2, top: (size.h - d) / 2 }}
      />
    </div>
  );
};
