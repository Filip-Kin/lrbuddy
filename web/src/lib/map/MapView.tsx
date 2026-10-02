import L from "leaflet";
import { removeMap } from "./removeMap.ts";
import { ErrorBoundary } from "../../components/ErrorBoundary.tsx";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { DEFAULT_CENTER, DEFAULT_ZOOM, MAX_ZOOM } from "./basemap.ts";
import { addBasemap } from "./basemapLayers.ts";
import type { LotGeometry } from "../../../../server/db/schema.ts";
import { attachLabelDeclutter } from "./declutter.ts";
import { cameraBadgeIcon, ccIcon, crewIcon, lotIcon, lotShape, meIcon, requestIcon, routeLine, selectLine, stopIcon, truckIcon, type LotStatus } from "./markers.ts";
import { media } from "../safe.ts";

// #region types
interface Base {
  /** Stable key; markers are diffed by it. */
  id: string;
  lat: number;
  lng: number;
  onClick?: () => void;
  /** Short hover or long-press label. */
  title?: string;
  /** Leave out of the automatic fit, for context markers far from the action. */
  noFit?: boolean;
}

export type MapMarker =
  | (Base & { kind: "me"; accuracy?: number | null })
  | (Base & { kind: "crew"; label: string; muted?: boolean })
  | (Base & { kind: "truck"; name: string; highlight?: boolean })
  /** `onDragEnd` makes the flag draggable (admin day map). */
  | (Base & { kind: "cc"; name: string; letter?: string | null; onDragEnd?: (lat: number, lng: number) => void })
  /** Drawn as its parcel outline when `geometry` is set, else a small square. `selected` adds a heavy ink outline. */
  | (Base & { kind: "lot"; status: LotStatus; mine?: boolean; selected?: boolean; geometry?: LotGeometry | null; parcelId?: string | null })
  | (Base & { kind: "request"; urgent?: boolean })
  /** Camera badge: a Before and no After on the lot. */
  | (Base & { kind: "camera" })
  | (Base & { kind: "stop"; n: number; active?: boolean });

export interface MapLine {
  id: string;
  points: Array<[number, number]>;
  /** `route` is the thick driving line; `select` is a thin dashed outline for a drawn rectangle. */
  style?: "route" | "select";
}

export interface MapViewProps {
  markers: readonly MapMarker[];
  lines?: readonly MapLine[];
  /** Change this to refit the view to every marker; unchanged keeps the user's pan and zoom. */
  fitKey?: string | number;
  onMapClick?: (lat: number, lng: number) => void;
  className?: string;
  /** Accessible name for the map region. */
  label?: string;
  /** The Leaflet map once it exists, and null when it goes, for tools that draw on it (oriented rectangle, block sides). */
  onReady?: (map: L.Map | null) => void;
}
// #endregion

// #region colour scheme
const darkQuery = media("(prefers-color-scheme: dark)");
export const usePrefersDark = (): boolean => useSyncExternalStore(darkQuery.subscribe, darkQuery.matches, () => false);
// #endregion

const layerFor = (m: MapMarker): L.Layer => {
  const at: L.LatLngExpression = [m.lat, m.lng];
  let layer: L.Layer;
  switch (m.kind) {
    case "me": {
      const group = L.featureGroup();
      if (m.accuracy && m.accuracy > 10 && m.accuracy < 500) {
        L.circle(at, { radius: m.accuracy, color: "#2f80ed", weight: 1, fillColor: "#2f80ed", fillOpacity: 0.12, interactive: false }).addTo(group);
      }
      L.marker(at, { icon: meIcon(), keyboard: false, zIndexOffset: 1000, interactive: false }).addTo(group);
      layer = group;
      break;
    }
    case "crew":
      layer = L.marker(at, { icon: crewIcon(m.label, m.muted), zIndexOffset: m.muted ? -100 : 200, title: m.title, alt: m.title });
      break;
    case "truck":
      layer = L.marker(at, { icon: truckIcon(m.name, m.highlight), zIndexOffset: 600, title: m.title ?? m.name, alt: m.name });
      break;
    case "cc": {
      const drag = m.onDragEnd;
      const marker = L.marker(at, { icon: ccIcon(m.name, m.letter), zIndexOffset: 400, title: m.title ?? m.name, alt: m.name, draggable: !!drag, autoPan: !!drag });
      if (drag) {
        marker.on("dragend", () => {
          const p = marker.getLatLng();
          drag(p.lat, p.lng);
        });
      }
      layer = marker;
      break;
    }
    case "lot":
      layer = m.geometry
        ? lotShape(m.geometry, m.status, m.mine ?? true, m.selected ?? false)
        : L.marker(at, { icon: lotIcon(m.status, m.mine ?? true, m.selected ?? false), zIndexOffset: -200, title: m.title, alt: m.title });
      break;
    case "request":
      layer = L.marker(at, { icon: requestIcon(m.urgent ?? false), zIndexOffset: 150, interactive: !!m.onClick, keyboard: false });
      break;
    case "camera":
      layer = L.marker(at, { icon: cameraBadgeIcon(), zIndexOffset: 100, interactive: !!m.onClick, keyboard: false, title: m.title, alt: m.title });
      break;
    case "stop":
      layer = L.marker(at, { icon: stopIcon(m.n, m.active), zIndexOffset: 700, title: m.title, alt: m.title });
      break;
  }
  if (m.onClick) {
    const click = m.onClick;
    layer.on("click", (e: L.LeafletEvent) => {
      L.DomEvent.stopPropagation(e as L.LeafletMouseEvent);
      click();
    });
  }
  return layer;
};

/**
 * Fits the view to the points at the exact zoom that holds them, not the next
 * half step down: on a phone a half step leaves a third of the frame empty.
 * Padding is smaller on a narrow map, where every pixel counts.
 */
const applyFit = (m: L.Map, pts: L.LatLngExpression[]): void => {
  if (pts.length === 1) {
    m.setView(pts[0]!, 16);
    return;
  }
  // Markers carry a label below them and a halo around them, so the fit needs
  // room for the whole marker, not just its anchor point. 14 px clipped "CC East"
  // to "C East" at the frame edge on a phone.
  const pad = m.getSize().x < 600 ? 44 : 60;
  const snap = m.options.zoomSnap;
  m.options.zoomSnap = 0;
  m.fitBounds(L.latLngBounds(pts), { padding: [pad, pad], maxZoom: 17 });
  m.options.zoomSnap = snap;
};

/**
 * Leaflet map with the Esri canvas basemap, light or dark to match the
 * system. Markers and lines are redrawn when their arrays change; the view is
 * fitted to every marker on first data and whenever `fitKey` changes.
 */
const MapViewInner = ({ markers, lines = [], fitKey, onMapClick, className, label = "Map", onReady }: MapViewProps) => {
  const holder = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const tiles = useRef<L.Layer[]>([]);
  const markerLayer = useRef<L.LayerGroup | null>(null);
  const lineLayer = useRef<L.LayerGroup | null>(null);
  const fitted = useRef<string | number | undefined | null>(null);
  const lastFit = useRef<L.LatLngExpression[] | null>(null);
  const userMoved = useRef(false);
  const clickRef = useRef(onMapClick);
  clickRef.current = onMapClick;
  const readyRef = useRef(onReady);
  readyRef.current = onReady;
  const dark = usePrefersDark();

  useEffect(() => {
    if (!holder.current || map.current) return;
    const m = L.map(holder.current, { zoomControl: true, maxZoom: MAX_ZOOM, attributionControl: true, zoomSnap: 0.5, zoomDelta: 1 }).setView(DEFAULT_CENTER, DEFAULT_ZOOM);
    m.attributionControl.setPrefix(false);
    const detachLabels = attachLabelDeclutter(m);
    lineLayer.current = L.layerGroup().addTo(m);
    markerLayer.current = L.layerGroup().addTo(m);
    m.on("click", (e: L.LeafletMouseEvent) => clickRef.current?.(e.latlng.lat, e.latlng.lng));
    map.current = m;
    // Any touch, click, wheel or drag means the view is the user's now; a resize no longer refits it.
    const el = holder.current;
    const touched = (): void => {
      userMoved.current = true;
    };
    for (const ev of ["pointerdown", "wheel", "keydown"] as const) el.addEventListener(ev, touched, { passive: true });
    // A map mounted inside a sheet or a flex child can measure 0 at first, or change size once the
    // page around it lays out. Refit then, so the first view is not fitted to a sliver.
    const ro = new ResizeObserver(() => {
      m.invalidateSize();
      const view = lastFit.current;
      if (view && !userMoved.current) applyFit(m, view);
    });
    ro.observe(el);
    readyRef.current?.(m);
    return () => {
      for (const ev of ["pointerdown", "wheel", "keydown"] as const) el.removeEventListener(ev, touched);
      ro.disconnect();
      detachLabels();
      readyRef.current?.(null);
      removeMap(m);
      map.current = null;
      tiles.current = [];
      fitted.current = null;
    };
  }, []);

  useEffect(() => {
    const m = map.current;
    if (!m) return;
    for (const t of tiles.current) m.removeLayer(t);
    tiles.current = addBasemap(m, { dark });
  }, [dark]);

  useEffect(() => {
    const m = map.current;
    const group = markerLayer.current;
    if (!m || !group) return;
    group.clearLayers();
    for (const mk of markers) {
      const layer = layerFor(mk);
      group.addLayer(layer);
      // The camera badge names its lot, so a test can find the badge of one lot.
      if (mk.kind === "camera" && layer instanceof L.Marker && mk.id.startsWith("cam-")) layer.getElement()?.setAttribute("data-cam-lot", mk.id.slice(4));
      // Lot outlines carry their parcel id, so a parcel can be found again after it becomes a lot,
      // and their lot id (`lot-<id>` markers), which Paint uses to colour a stroke as it goes.
      if (mk.kind === "lot") {
        const pid = mk.parcelId;
        const lotId = mk.id.startsWith("lot-") ? mk.id.slice(4) : null;
        if (layer instanceof L.GeoJSON) {
          layer.eachLayer((l) => {
            if (!(l instanceof L.Path)) return;
            const el = l.getElement();
            if (!el || el.classList.contains("lrb-lot-hatch")) return;
            if (pid) el.setAttribute("data-lot-parcel", pid);
            if (lotId) el.setAttribute("data-lot-id", lotId);
          });
        } else if (layer instanceof L.Marker && lotId) {
          layer.getElement()?.setAttribute("data-lot-id", lotId);
        }
      }
    }
  }, [markers]);

  useEffect(() => {
    const group = lineLayer.current;
    if (!group) return;
    group.clearLayers();
    for (const l of lines) if (l.points.length > 1) group.addLayer(l.style === "select" ? selectLine(l.points) : routeLine(l.points));
  }, [lines]);

  useEffect(() => {
    const m = map.current;
    if (!m || markers.length === 0) return;
    const key = fitKey ?? "__first";
    if (fitted.current === key) return;
    fitted.current = key;
    const pts: L.LatLngExpression[] = markers.filter((mk) => !mk.noFit).map((mk) => [mk.lat, mk.lng]);
    for (const l of lines) for (const p of l.points) pts.push(p);
    if (pts.length === 0) return;
    lastFit.current = pts;
    userMoved.current = false;
    applyFit(m, pts);
  }, [markers, lines, fitKey]);

  return <div ref={holder} role="region" aria-label={label} className={className ?? "h-full w-full"} />;
};

/** The map with its own error boundary: a Leaflet crash shows the error panel in the map's box, not a blank screen. */
export const MapView = (props: MapViewProps) => (
  <ErrorBoundary label="Map failed" inset>
    <MapViewInner {...props} />
  </ErrorBoundary>
);
