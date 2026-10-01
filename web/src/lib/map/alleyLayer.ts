/**
 * Alleys on any Leaflet map (SPEC 19): from zoom 15 up, each alley the server
 * knows in the view as its 3 m buffered outline, ink dashed and filled with its
 * status colour at 15 %. A tap calls `onAlley`. Below zoom 15 the layer is empty.
 */
import L from "leaflet";
import { useEffect, useRef, useState } from "react";
import { trpc, type RouterOutputs } from "../trpc.ts";

export type AlleyItem = RouterOutputs["alleys"]["inView"][number];

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

/** Draws the alleys and returns them, so a sheet can show the one tapped. */
export const useAlleyLayer = (map: L.Map | null, onAlley: (a: AlleyItem) => void): AlleyItem[] => {
  const [view, setView] = useState<View | null>(null);
  const tap = useRef(onAlley);
  tap.current = onAlley;

  useEffect(() => {
    if (!map) return;
    const update = (): void => {
      const next = map.getZoom() >= ALLEY_MIN_ZOOM ? snapped(map.getBounds()) : null;
      setView((prev) => (sameView(prev, next) ? prev : next));
    };
    update();
    map.on("moveend zoomend", update);
    return () => {
      map.off("moveend zoomend", update);
    };
  }, [map]);

  const q = trpc.alleys.inView.useQuery(view ?? { w: 0, s: 0, e: 0, n: 0 }, {
    enabled: view !== null,
    // Other phones change statuses too; there is no live event for alleys.
    refetchInterval: 30_000,
    placeholderData: (prev) => prev,
  });
  const items = view ? (q.data ?? []) : [];

  useEffect(() => {
    if (!map || items.length === 0) return;
    if (!map.getPane(PANE)) map.createPane(PANE).style.zIndex = "385";
    const renderer = L.svg({ pane: PANE });
    const layer = L.layerGroup();
    for (const a of items) {
      const ring = (a.polygon.coordinates[0] ?? []).map((p): [number, number] => [p[1] ?? 0, p[0] ?? 0]);
      const shape = L.polygon(ring, { renderer, pane: PANE, className: `lrb-alley lrb-alley-${a.status}`, weight: 1.5, fillOpacity: 0.15 });
      shape.on("click", (e: L.LeafletMouseEvent) => {
        L.DomEvent.stopPropagation(e);
        tap.current(a);
      });
      layer.addLayer(shape);
    }
    layer.addTo(map);
    return () => {
      layer.remove();
    };
  }, [map, items]);

  return items;
};
