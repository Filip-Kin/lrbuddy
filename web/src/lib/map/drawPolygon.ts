/**
 * Draw lot (SPEC 24): tap points to outline a polygon on a Leaflet map. Taps
 * add points (a drag still pans), the first point or Close finishes, every
 * point can be dragged, Undo point takes the last one back. The same tool
 * edits a drawn lot's outline (`closed` from the start).
 */
import L from "leaflet";
import { useEffect, useRef } from "react";

export interface LatLng {
  lat: number;
  lng: number;
}

/** Hit box of a point: 44 px on a touch screen, 30 px with a mouse; the dot inside stays 14 px. */
const hitPx = (): number => (typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches ? 44 : 30);

const vertexIcon = (first: boolean): L.DivIcon => {
  const hit = hitPx();
  return L.divIcon({
    className: `lrb-orect-h lrb-orect-corner${first ? " lrb-draw-first" : ""}`,
    html: "<span></span>",
    iconSize: [hit, hit],
    iconAnchor: [hit / 2, hit / 2],
  });
};

export interface DrawPolygonOptions {
  /** The tool is on: taps add points (unless closed), points show and drag. */
  active: boolean;
  points: readonly LatLng[];
  closed: boolean;
  onPoints: (points: LatLng[]) => void;
  /** A tap on the first point with three or more down. */
  onClose: () => void;
}

/** A polygon as GeoJSON: one closed ring of [lng, lat]. */
export const polygonOf = (points: readonly LatLng[]): { type: "Polygon"; coordinates: Array<Array<[number, number]>> } => ({
  type: "Polygon",
  coordinates: [[...points, points[0]!].map((p): [number, number] => [p.lng, p.lat])],
});

/** Metres across the widest pair of points, for the 10 m minimum. */
export const acrossM = (points: readonly LatLng[]): number => {
  let best = 0;
  for (const a of points) {
    for (const b of points) {
      const kx = 111_320 * Math.cos((a.lat * Math.PI) / 180);
      best = Math.max(best, Math.hypot((a.lng - b.lng) * kx, (a.lat - b.lat) * 111_320));
    }
  }
  return best;
};

export const useDrawPolygon = (map: L.Map | null, opts: DrawPolygonOptions): void => {
  const ref = useRef(opts);
  ref.current = opts;

  // Taps on the map add a point while drawing.
  useEffect(() => {
    if (!map || !opts.active || opts.closed) return;
    const click = (e: L.LeafletMouseEvent): void => {
      ref.current.onPoints([...ref.current.points, { lat: e.latlng.lat, lng: e.latlng.lng }]);
    };
    const wasDbl = map.doubleClickZoom.enabled();
    map.doubleClickZoom.disable();
    map.on("click", click);
    return () => {
      map.off("click", click);
      if (wasDbl) map.doubleClickZoom.enable();
    };
  }, [map, opts.active, opts.closed]);

  // The outline and its points; redrawn from the props, dragged without React until the drag ends.
  useEffect(() => {
    if (!map || !opts.active || opts.points.length === 0) return;
    const group = L.layerGroup().addTo(map);
    const pts = opts.points.map((p): L.LatLngTuple => [p.lat, p.lng]);
    const outline = opts.closed || pts.length >= 3 ? L.polygon(pts, { className: "lrb-draw-shape", weight: 2.5, interactive: false }) : L.polyline(pts, { className: "lrb-draw-shape", weight: 2.5, interactive: false });
    if (!opts.closed && pts.length >= 3) outline.setStyle({ dashArray: "6 5" });
    group.addLayer(outline);
    opts.points.forEach((p, i) => {
      const m = L.marker([p.lat, p.lng], { icon: vertexIcon(i === 0 && !opts.closed), draggable: true, keyboard: false, zIndexOffset: 1000 });
      m.on("click", (e: L.LeafletMouseEvent) => {
        L.DomEvent.stopPropagation(e);
        const r = ref.current;
        if (r.closed) return;
        if (i === 0 && r.points.length >= 3) r.onClose();
        // A point's hit box is 44 px on a phone; a tap on it that is not the closing tap is a new point there.
        else r.onPoints([...r.points, { lat: e.latlng.lat, lng: e.latlng.lng }]);
      });
      m.on("drag", () => {
        const at = m.getLatLng();
        const next = pts.slice();
        next[i] = [at.lat, at.lng];
        outline.setLatLngs(next);
      });
      m.on("dragend", () => {
        const at = m.getLatLng();
        const next = ref.current.points.slice();
        next[i] = { lat: at.lat, lng: at.lng };
        ref.current.onPoints(next);
      });
      group.addLayer(m);
      m.getElement()?.setAttribute("data-draw-vertex", String(i));
    });
    return () => {
      group.remove();
    };
  }, [map, opts.active, opts.points, opts.closed]);
};
