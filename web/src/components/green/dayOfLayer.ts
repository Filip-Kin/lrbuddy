import L from "leaflet";
import { useEffect, useRef } from "react";
import { escapeHtml } from "../../lib/map/markers.ts";
import { hatchLines } from "../../lib/map/hatch.ts";
import type { RouterOutputs } from "../../lib/trpc.ts";

export type DayOfPlan = RouterOutputs["green"]["plan"];
export type DayOfArea = DayOfPlan["areas"][number];
export type DayOfSide = DayOfPlan["sides"][number];

/** Done when nothing on it is left to do; Do not touch when any lot was skipped and none is left. */
export const sideState = (c: DayOfSide["counts"]): "open" | "done" | "dnt" =>
  c.open + c.inProgress > 0 ? "open" : c.skipped > 0 ? "dnt" : c.done > 0 ? "done" : "open";

const SIDES_PANE = "lrb-dayof-sides";
const AREAS_PANE = "lrb-dayof-areas";

/**
 * The CC's rectangles and block sides on the green map (SPEC 19 Marks). Block
 * sides sit in a pane under the lot outlines, so a tap on a lot opens the lot
 * and a tap between lots opens the side. Rectangles are outlines (hatched for
 * Do not touch) with a tappable name pill on their top edge.
 */
export const useDayOfLayer = (
  map: L.Map | null,
  plan: Pick<DayOfPlan, "areas" | "sides"> | undefined,
  visible: boolean,
  onArea: (id: number) => void,
  onSide: (key: string) => void,
  /** Stacking of the rectangles' pane; 405 sits over the lot outlines, the driver map puts them under its route. */
  areasZ = "405",
): void => {
  const group = useRef<L.LayerGroup | null>(null);
  const renderers = useRef<{ sides: L.Renderer; areas: L.Renderer } | null>(null);
  const areaClick = useRef(onArea);
  areaClick.current = onArea;
  const sideClick = useRef(onSide);
  sideClick.current = onSide;

  useEffect(() => {
    if (!map) return;
    for (const [name, z] of [
      [SIDES_PANE, "390"],
      [AREAS_PANE, areasZ],
    ] as const) {
      const pane = map.getPane(name) ?? map.createPane(name);
      pane.style.zIndex = z;
    }
    // The rectangles never take a tap; their pills do.
    map.getPane(AREAS_PANE)!.style.pointerEvents = "none";
    renderers.current = { sides: L.svg({ pane: SIDES_PANE }), areas: L.svg({ pane: AREAS_PANE }) };
    const g = L.layerGroup().addTo(map);
    group.current = g;
    return () => {
      g.remove();
      group.current = null;
      renderers.current = null;
    };
  }, [map, areasZ]);

  useEffect(() => {
    const g = group.current;
    const r = renderers.current;
    if (!g || !r) return;
    g.clearLayers();
    if (!plan || !visible) return;
    for (const s of plan.sides) {
      const poly = L.polygon(
        s.ring.slice(0, -1).map(([lng, lat]) => [lat, lng] as [number, number]),
        { renderer: r.sides, pane: SIDES_PANE, className: `lrb-dayof-side lrb-dayof-side-${sideState(s.counts)}`, weight: 1.5 },
      );
      poly.on("click", (e: L.LeafletMouseEvent) => {
        L.DomEvent.stopPropagation(e);
        sideClick.current(s.key);
      });
      g.addLayer(poly);
    }
    for (const a of plan.areas) {
      const pts = a.ring.slice(0, -1).map(([lng, lat]) => [lat, lng] as [number, number]);
      if (pts.length < 3) continue;
      g.addLayer(L.polygon(pts, { renderer: r.areas, pane: AREAS_PANE, className: `lrb-dayof-area${a.doNotTouch ? " lrb-dayof-area-dnt" : ""}`, interactive: false, fill: false, weight: 3 }));
      if (a.doNotTouch) {
        for (const seg of hatchLines(a.ring)) g.addLayer(L.polyline(seg, { renderer: r.areas, pane: AREAS_PANE, className: "lrb-dayof-hatch", interactive: false, weight: 1.5 }));
      }
      // The pill sits on the edge whose middle is furthest north, the way the printed sheet labels it.
      let top: L.LatLngTuple = pts[0]!;
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i]!;
        const q = pts[(i + 1) % pts.length]!;
        const mid: L.LatLngTuple = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
        if (i === 0 || mid[0] > top[0]) top = mid;
      }
      const html = `<button type="button" class="lrb-dayof-pill${a.doNotTouch ? " lrb-dayof-pill-dnt" : ""}">${escapeHtml(a.label)}</button>`;
      const pill = L.marker(top, { icon: L.divIcon({ className: "lrb-dayof-tag", html, iconSize: [0, 0] }), keyboard: false, zIndexOffset: 300, title: a.label });
      pill.on("click", (e: L.LeafletMouseEvent) => {
        L.DomEvent.stopPropagation(e);
        areaClick.current(a.id);
      });
      g.addLayer(pill);
    }
  }, [plan, visible]);
};
