import L from "leaflet";
import { useEffect, useRef, useState } from "react";
import type { LotGeometry, LotStatus } from "../../../../server/db/schema.ts";
import { lotShape, parcelShape } from "./markers.ts";

export interface BareParcel {
  parcelId: string;
  lat: number;
  lng: number;
  geometry: LotGeometry;
}

/** Bare parcels sit over the block sides (390) and under the lot outlines (overlay pane, 400). */
const PANE = "lrb-parcels";
/** Below this zoom the outlines are noise, and a tap could not pick one parcel anyway. */
export const PARCEL_MIN_ZOOM = 16;

/**
 * Cached parcels with no lot (SPEC 21, Not todo) as thin tappable outlines.
 * A parcel with a status pending from a tap draws in that status until the
 * refetch brings its lot. Hidden under zoom 16 and while `visible` is false.
 */
export const useParcelLayer = (
  map: L.Map | null,
  parcels: readonly BareParcel[] | undefined,
  visible: boolean,
  onTap: (parcelId: string) => void,
  /** Pending statuses from `useSetLot`, keyed `p:<parcel id>`. */
  pending?: ReadonlyMap<string, LotStatus>,
): void => {
  const group = useRef<L.LayerGroup | null>(null);
  const renderer = useRef<L.Renderer | null>(null);
  const tap = useRef(onTap);
  tap.current = onTap;
  const [zoomOk, setZoomOk] = useState(false);

  useEffect(() => {
    if (!map) return;
    const pane = map.getPane(PANE) ?? map.createPane(PANE);
    pane.style.zIndex = "395";
    renderer.current = L.svg({ pane: PANE });
    const g = L.layerGroup().addTo(map);
    group.current = g;
    const check = (): void => setZoomOk(map.getZoom() >= PARCEL_MIN_ZOOM);
    check();
    map.on("zoomend", check);
    return () => {
      map.off("zoomend", check);
      g.remove();
      group.current = null;
      renderer.current = null;
    };
  }, [map]);

  useEffect(() => {
    const g = group.current;
    const r = renderer.current;
    if (!g || !r) return;
    g.clearLayers();
    if (!visible || !zoomOk || !parcels) return;
    for (const p of parcels) {
      const status = pending?.get(`p:${p.parcelId}`) ?? null;
      const layer = status && status !== "not_todo" ? lotShape(p.geometry, status, true, false, { pane: PANE, renderer: r }) : parcelShape(p.geometry, { pane: PANE, renderer: r });
      layer.on("click", (e: L.LeafletMouseEvent) => {
        L.DomEvent.stopPropagation(e);
        tap.current(p.parcelId);
      });
      g.addLayer(layer);
      layer.eachLayer((l) => {
        if (l instanceof L.Path) l.getElement()?.setAttribute("data-parcel", p.parcelId);
      });
    }
  }, [parcels, visible, zoomOk, pending]);
};
