import L from "leaflet";
import { removeMap } from "../../../lib/map/removeMap.ts";
import { useEffect, useRef } from "react";
import type { LotGeometry } from "../../../../../server/db/schema.ts";
import { DEFAULT_CENTER, DEFAULT_ZOOM, MAX_ZOOM } from "../../../lib/map/basemap.ts";
import { addBasemap } from "../../../lib/map/basemapLayers.ts";
import { bandStroke, gradeColour, toLatLngs, usePalette, type Band, type Grade } from "./style.ts";
import { usePrefersDark } from "../../../lib/map/MapView.tsx";

export interface MapParcel {
  parcelId: string;
  lat: number;
  lng: number;
  geometry: LotGeometry | null;
  grade: Grade | null;
  address: string | null;
}

export interface MapSide {
  key: string;
  band: Band;
  outline: Array<[number, number]>;
}

export interface SurveyMapProps {
  /** Surveyed parcels, filled by grade. */
  parcels: readonly MapParcel[];
  /** Cached parcels in view that nobody has surveyed, drawn as thin outlines so they can be graded too. */
  context: readonly MapParcel[];
  sides: readonly MapSide[];
  selectedId: string | null;
  onParcel: (parcelId: string) => void;
  /** True while a drawing tool owns the clicks: a click on a parcel passes through to the map. */
  passive?: boolean;
  /** The Leaflet map once it exists, and null when it goes, for the oriented rectangle. */
  onReady?: (map: L.Map | null) => void;
  /** Fires after every move with [west, south, east, north] and the zoom. */
  onView?: (bbox: [number, number, number, number], zoom: number) => void;
  /** Change to pan to a point. */
  focus: { lat: number; lng: number; n: number } | null;
  /** Change to fit every surveyed parcel. */
  fitKey: string;
}

/**
 * Survey map for a laptop: block side outlines under the parcels, surveyed
 * parcels filled by grade, unsurveyed ones in view as outlines. Thousands of
 * parcels, so shapes go through the map's one canvas renderer.
 */
export const SurveyMap = ({ parcels, context, sides, selectedId, onParcel, passive = false, onReady, onView, focus, fitKey }: SurveyMapProps) => {
  const holder = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layers = useRef<{ tiles: L.Layer[]; sides: L.LayerGroup; context: L.LayerGroup; parcels: L.LayerGroup; select: L.LayerGroup } | null>(null);
  const fitted = useRef<string | null>(null);
  const passiveRef = useRef(passive);
  passiveRef.current = passive;
  const readyRef = useRef(onReady);
  readyRef.current = onReady;
  const parcelRef = useRef(onParcel);
  parcelRef.current = onParcel;
  const viewRef = useRef(onView);
  viewRef.current = onView;
  const dark = usePrefersDark();
  const pal = usePalette();

  useEffect(() => {
    if (!holder.current || map.current) return;
    // One canvas for every shape: a second canvas on top would swallow the clicks meant for the first.
    const m = L.map(holder.current, { zoomControl: true, maxZoom: MAX_ZOOM, zoomSnap: 0.5, preferCanvas: true, renderer: L.canvas({ padding: 0.3, tolerance: 2 }) }).setView(
      DEFAULT_CENTER,
      DEFAULT_ZOOM,
    );
    m.attributionControl.setPrefix(false);
    layers.current = {
      tiles: [],
      sides: L.layerGroup().addTo(m),
      context: L.layerGroup().addTo(m),
      parcels: L.layerGroup().addTo(m),
      select: L.layerGroup().addTo(m),
    };
    const report = (): void => {
      const b = m.getBounds();
      viewRef.current?.([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()], m.getZoom());
    };
    m.on("moveend", report);
    map.current = m;
    const ro = new ResizeObserver(() => m.invalidateSize());
    ro.observe(holder.current);
    report();
    readyRef.current?.(m);
    return () => {
      ro.disconnect();
      readyRef.current?.(null);
      removeMap(m);
      map.current = null;
      layers.current = null;
      fitted.current = null;
    };
  }, []);

  useEffect(() => {
    const m = map.current;
    const l = layers.current;
    if (!m || !l) return;
    for (const t of l.tiles) m.removeLayer(t);
    l.tiles = addBasemap(m, { dark, streets: false });
  }, [dark]);

  const shape = (p: MapParcel, style: L.PathOptions): L.Path => {
    const s = p.geometry ? L.polygon(toLatLngs(p.geometry), style) : L.circleMarker([p.lat, p.lng], { ...style, radius: 5 });
    s.on("click", (e: L.LeafletMouseEvent) => {
      if (passiveRef.current) return;
      L.DomEvent.stopPropagation(e);
      parcelRef.current(p.parcelId);
    });
    if (p.address) s.bindTooltip(p.address, { sticky: true, direction: "top", opacity: 0.95 });
    return s;
  };

  useEffect(() => {
    const l = layers.current;
    if (!l) return;
    l.sides.clearLayers();
    for (const s of sides) {
      if (s.outline.length < 2) continue;
      L.polygon(
        s.outline.map(([lng, lat]) => [lat, lng] as [number, number]),
        { ...bandStroke(pal, s.band), fill: false, interactive: false },
      ).addTo(l.sides);
    }
  }, [sides, pal]);

  useEffect(() => {
    const l = layers.current;
    if (!l) return;
    l.context.clearLayers();
    for (const p of context) shape(p, { color: pal.muted, weight: 1, opacity: 0.7, fillColor: pal.muted, fillOpacity: 0.04 }).addTo(l.context);
  }, [context, pal]);

  useEffect(() => {
    const l = layers.current;
    if (!l) return;
    l.parcels.clearLayers();
    for (const p of parcels) {
      const c = gradeColour(pal, p.grade);
      shape(p, { color: c, weight: 1.5, opacity: 0.95, fillColor: c, fillOpacity: p.grade === "clear" ? 0.18 : 0.5 }).addTo(l.parcels);
    }
  }, [parcels, pal]);

  useEffect(() => {
    const l = layers.current;
    if (!l) return;
    l.select.clearLayers();
    const p = selectedId ? (parcels.find((x) => x.parcelId === selectedId) ?? context.find((x) => x.parcelId === selectedId)) : undefined;
    if (!p) return;
    if (p.geometry) {
      L.polygon(toLatLngs(p.geometry), { color: pal.brand, weight: 9, opacity: 0.9, fill: false, interactive: false }).addTo(l.select);
      L.polygon(toLatLngs(p.geometry), { color: pal.ink, weight: 3, fill: false, interactive: false }).addTo(l.select);
    } else {
      L.circleMarker([p.lat, p.lng], { radius: 9, color: pal.ink, weight: 3, fill: false, interactive: false }).addTo(l.select);
    }
  }, [selectedId, parcels, context, pal]);

  useEffect(() => {
    const m = map.current;
    if (!m || parcels.length === 0 || fitted.current === fitKey) return;
    fitted.current = fitKey;
    const b = L.latLngBounds(parcels.map((p) => [p.lat, p.lng] as [number, number]));
    m.fitBounds(b, { padding: [30, 30], maxZoom: 17 });
  }, [parcels, fitKey]);

  useEffect(() => {
    const m = map.current;
    if (!m || !focus) return;
    m.setView([focus.lat, focus.lng], Math.max(m.getZoom(), 18));
  }, [focus]);

  return <div ref={holder} role="region" aria-label="Survey map" className="absolute inset-0" />;
};
