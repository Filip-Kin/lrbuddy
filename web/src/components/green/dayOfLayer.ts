import L from "leaflet";
import { useEffect, useRef } from "react";
import { useAreaNames } from "../../lib/map/areaNames.ts";
import { attachLabelDeclutter } from "../../lib/map/declutter.ts";
import { hatchLines } from "../../lib/map/hatch.ts";
import type { RouterOutputs } from "../../lib/trpc.ts";

export type DayOfPlan = RouterOutputs["green"]["plan"];
export type DayOfArea = DayOfPlan["areas"][number];

const AREAS_PANE = "lrb-dayof-areas";

/**
 * The CC's rectangles on the green, driver and Flag maps (SPEC 19 Marks): blue
 * outlines (hatched when a green marked the rectangle Do not touch) with the
 * name small along the top edge (`useAreaNames`); a dot at the start of the
 * name opens the rectangle. Status colour belongs to the lot outlines only;
 * block sides are a planning idea and are not drawn here.
 */
export const useDayOfLayer = (
  map: L.Map | null,
  plan: Pick<DayOfPlan, "areas"> | undefined,
  visible: boolean,
  onArea: ((id: number) => void) | undefined,
  /** Stacking of the rectangles' pane; 405 sits over the lot outlines, the driver map puts them under its route. */
  areasZ = "405",
  /** The map's CSS turn (the driver map turns heading up), so the names stay upright. */
  turn = 0,
): void => {
  const group = useRef<L.LayerGroup | null>(null);
  const renderer = useRef<L.Renderer | null>(null);

  useEffect(() => {
    if (!map) return;
    const pane = map.getPane(AREAS_PANE) ?? map.createPane(AREAS_PANE);
    pane.style.zIndex = areasZ;
    // The rectangles never take a tap; the dots at their names do.
    pane.style.pointerEvents = "none";
    renderer.current = L.svg({ pane: AREAS_PANE });
    const g = L.layerGroup().addTo(map);
    group.current = g;
    const detachLabels = attachLabelDeclutter(map);
    return () => {
      detachLabels();
      g.remove();
      group.current = null;
      renderer.current = null;
    };
  }, [map, areasZ]);

  // `map` is a dependency so the rectangles draw when the map arrives after the plan (a fast
  // answer, or the phone's cached copy): the group above only exists once the map does.
  useEffect(() => {
    const g = group.current;
    const r = renderer.current;
    if (!g || !r) return;
    g.clearLayers();
    if (!plan || !visible) return;
    for (const a of plan.areas) {
      const pts = a.ring.slice(0, -1).map(([lng, lat]) => [lat, lng] as [number, number]);
      if (pts.length < 3) continue;
      const poly = L.polygon(pts, { renderer: r, pane: AREAS_PANE, className: `lrb-dayof-area${a.doNotTouch ? " lrb-dayof-area-dnt" : ""}`, interactive: false, fill: false, weight: 3 });
      g.addLayer(poly);
      poly.getElement()?.setAttribute("data-area-id", String(a.id));
      if (a.doNotTouch) {
        for (const seg of hatchLines(a.ring)) g.addLayer(L.polyline(seg, { renderer: r, pane: AREAS_PANE, className: "lrb-dayof-hatch", interactive: false, weight: 1.5 }));
      }
    }
  }, [map, areasZ, plan, visible]);

  useAreaNames(map, plan?.areas, { visible, onTap: onArea, turn, tone: "dayof" });
};
