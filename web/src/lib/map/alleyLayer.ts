/**
 * OpenStreetMap alleys as a hint (SPEC 24): from zoom 15 up, each alley in
 * the view as a thin dashed centreline that takes no taps. Shown only while
 * the map's OSM alleys toggle is on; work in an alley is a drawn lot.
 */
import L from "leaflet";
import { useEffect, useState } from "react";
import { trpc } from "../trpc.ts";

export const ALLEY_MIN_ZOOM = 15;
const PANE = "lrb-alleys";
const GRID = 0.01;

interface View {
  w: number;
  s: number;
  e: number;
  n: number;
}

const snapped = (b: L.LatLngBounds): View => ({
  w: Math.floor(b.getWest() / GRID) * GRID,
  s: Math.floor(b.getSouth() / GRID) * GRID,
  e: Math.ceil(b.getEast() / GRID) * GRID,
  n: Math.ceil(b.getNorth() / GRID) * GRID,
});

const sameView = (a: View | null, b: View | null): boolean =>
  a === b || (a !== null && b !== null && a.w === b.w && a.s === b.s && a.e === b.e && a.n === b.n);

export const useOsmAlleys = (map: L.Map | null, visible: boolean): void => {
  const [view, setView] = useState<View | null>(null);

  useEffect(() => {
    if (!map || !visible) {
      setView(null);
      return;
    }
    const update = (): void => {
      const next = map.getZoom() >= ALLEY_MIN_ZOOM ? snapped(map.getBounds()) : null;
      setView((prev) => (sameView(prev, next) ? prev : next));
    };
    update();
    map.on("moveend zoomend", update);
    return () => {
      map.off("moveend zoomend", update);
    };
  }, [map, visible]);

  const q = trpc.alleys.inView.useQuery(view ?? { w: 0, s: 0, e: 0, n: 0 }, { enabled: view !== null, staleTime: 600_000, placeholderData: (prev) => prev });
  const items = view ? (q.data ?? []) : [];

  useEffect(() => {
    if (!map || items.length === 0) return;
    if (!map.getPane(PANE)) {
      const pane = map.createPane(PANE);
      pane.style.zIndex = "385";
      pane.style.pointerEvents = "none";
    }
    const renderer = L.svg({ pane: PANE });
    const layer = L.layerGroup();
    for (const a of items) layer.addLayer(L.polyline(a.centerline, { renderer, pane: PANE, className: "lrb-osm-alley", weight: 1.5, interactive: false }));
    layer.addTo(map);
    return () => {
      layer.remove();
    };
  }, [map, items]);
};
