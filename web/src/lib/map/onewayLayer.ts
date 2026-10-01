/**
 * One-way street arrows on any Leaflet map (SPEC 20). From zoom 15 up the
 * layer asks the server for the cached one-way ways in view and draws a small
 * white arrow with an ink outline every 60 m, pointing the way traffic flows.
 * Arrows sit in their own pane under the route line and markers and take no
 * taps. Below zoom 15 the layer is empty.
 *
 * Use: `useOnewayLayer(map)` with the map from `MapView`'s `onReady`.
 */
import L from "leaflet";
import { useEffect, useState } from "react";
import { trpc } from "../trpc.ts";
import { arrowsAlong } from "./onewayArrows.ts";

export const ONEWAY_MIN_ZOOM = 15;
const PANE = "lrb-oneway";
/** View bounds are snapped outward to this grid so a small pan reuses the same query. */
const GRID = 0.01;
/** Arrow outline: the light theme's ink in both themes, so the white arrow reads on either basemap. */
const INK = "#0e3038";

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

/** An arrow pointing north, turned to the bearing. 18 px so it sits inside a street at zoom 15 to 19. */
export const onewayArrowSvg = (bearing: number): string =>
  `<svg viewBox="0 0 18 18" width="18" height="18" style="transform:rotate(${bearing.toFixed(1)}deg)" aria-hidden="true">` +
  `<path d="M9 1.5 15 10H11V16.5H7V10H3Z" fill="#fff" stroke="${INK}" stroke-width="1.5" stroke-linejoin="round"/></svg>`;

const arrowIcon = (bearing: number): L.DivIcon =>
  L.divIcon({ className: "lrb-oneway", html: onewayArrowSvg(bearing), iconSize: [18, 18], iconAnchor: [9, 9] });

/** Small legend swatch markup for React legends: the same arrow, pointing right. */
export const onewayLegendSvg = onewayArrowSvg(90);

export const useOnewayLayer = (map: L.Map | null): void => {
  const [view, setView] = useState<View | null>(null);

  useEffect(() => {
    if (!map) return;
    const update = (): void => {
      const next = map.getZoom() >= ONEWAY_MIN_ZOOM ? snapped(map.getBounds()) : null;
      setView((prev) => (sameView(prev, next) ? prev : next));
    };
    update();
    map.on("moveend zoomend", update);
    return () => {
      map.off("moveend zoomend", update);
    };
  }, [map]);

  const ways = trpc.oneway.inView.useQuery(view ?? { w: 0, s: 0, e: 0, n: 0 }, {
    enabled: view !== null,
    staleTime: 10 * 60_000,
    placeholderData: (prev) => prev,
  });

  useEffect(() => {
    if (!map || !view || !ways.data) return;
    if (!map.getPane(PANE)) {
      const pane = map.createPane(PANE);
      pane.style.zIndex = "390";
      pane.style.pointerEvents = "none";
    }
    const layer = L.layerGroup();
    for (const w of ways.data) {
      for (const a of arrowsAlong(w.points, w.direction)) {
        L.marker([a.lat, a.lng], { icon: arrowIcon(a.bearing), pane: PANE, interactive: false, keyboard: false }).addTo(layer);
      }
    }
    layer.addTo(map);
    return () => {
      layer.remove();
    };
  }, [map, view, ways.data]);
};
