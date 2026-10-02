import L from "leaflet";
import { useEffect, useRef } from "react";
import { attachLabelDeclutter, largestAreaIds, pillClass } from "../../lib/map/declutter.ts";
import { escapeHtml } from "../../lib/map/markers.ts";
import { hatchLines } from "../../lib/map/hatch.ts";
import type { RouterOutputs } from "../../lib/trpc.ts";

export type DayOfPlan = RouterOutputs["green"]["plan"];
export type DayOfArea = DayOfPlan["areas"][number];

const AREAS_PANE = "lrb-dayof-areas";

/**
 * The CC's rectangles on the green and driver maps (SPEC 19 Marks): blue
 * outlines (hatched when a green marked the rectangle Do not touch) with a
 * tappable name pill on their top edge. Status colour belongs to the lot
 * outlines only; block sides are a planning idea and are not drawn here.
 */
export const useDayOfLayer = (
  map: L.Map | null,
  plan: Pick<DayOfPlan, "areas"> | undefined,
  visible: boolean,
  onArea: (id: number) => void,
  /** Stacking of the rectangles' pane; 405 sits over the lot outlines, the driver map puts them under its route. */
  areasZ = "405",
): void => {
  const group = useRef<L.LayerGroup | null>(null);
  const renderer = useRef<L.Renderer | null>(null);
  const areaClick = useRef(onArea);
  areaClick.current = onArea;

  useEffect(() => {
    if (!map) return;
    const pane = map.getPane(AREAS_PANE) ?? map.createPane(AREAS_PANE);
    pane.style.zIndex = areasZ;
    // The rectangles never take a tap; their pills do.
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
    // SPEC 20: from zoom 14 to 16 only the six largest rectangles keep their pill.
    const big = largestAreaIds(plan.areas);
    for (const a of plan.areas) {
      const pts = a.ring.slice(0, -1).map(([lng, lat]) => [lat, lng] as [number, number]);
      if (pts.length < 3) continue;
      g.addLayer(L.polygon(pts, { renderer: r, pane: AREAS_PANE, className: `lrb-dayof-area${a.doNotTouch ? " lrb-dayof-area-dnt" : ""}`, interactive: false, fill: false, weight: 3 }));
      if (a.doNotTouch) {
        for (const seg of hatchLines(a.ring)) g.addLayer(L.polyline(seg, { renderer: r, pane: AREAS_PANE, className: "lrb-dayof-hatch", interactive: false, weight: 1.5 }));
      }
      // The pill sits on the edge whose middle is furthest north, the way the printed sheet labels it.
      let top: L.LatLngTuple = pts[0]!;
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i]!;
        const q = pts[(i + 1) % pts.length]!;
        const mid: L.LatLngTuple = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
        if (i === 0 || mid[0] > top[0]) top = mid;
      }
      const html = `<button type="button" class="lrb-dayof-pill ${pillClass(big.has(a.id))}${a.doNotTouch ? " lrb-dayof-pill-dnt" : ""}">${escapeHtml(a.label)}</button>`;
      const pill = L.marker(top, { icon: L.divIcon({ className: "lrb-dayof-tag", html, iconSize: [0, 0] }), keyboard: false, zIndexOffset: 300, title: a.label });
      pill.on("click", (e: L.LeafletMouseEvent) => {
        L.DomEvent.stopPropagation(e);
        areaClick.current(a.id);
      });
      g.addLayer(pill);
    }
  }, [map, areasZ, plan, visible]);
};
