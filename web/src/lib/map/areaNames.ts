import L from "leaflet";
import { useEffect, useRef } from "react";
import { placeOnTopEdge, shortAreaLabel } from "./areaLabel.ts";
import { largestAreaIds, pillClass } from "./declutter.ts";

// #region layer
export interface NamedArea {
  id: number;
  label: string;
  /** [lng, lat] points; closed or not. */
  ring: ReadonlyArray<ReadonlyArray<number>>;
  doNotTouch?: boolean;
}

/** Pixels between the outline and the near side of the text. */
export const EDGE_GAP_PX = 2;
/** Line height of the name; the CSS sets the same. */
const LINE_PX = 14;
/** Room at each end of the edge. */
const END_PAD_PX = 4;

const openRing = (ring: NamedArea["ring"]): Array<[number, number]> => {
  const pts: Array<[number, number]> = [];
  for (const p of ring) if (p[0] !== undefined && p[1] !== undefined) pts.push([p[1], p[0]]);
  const f = pts[0];
  const l = pts[pts.length - 1];
  if (pts.length > 1 && f && l && f[0] === l[0] && f[1] === l[1]) pts.pop();
  return pts;
};

export interface AreaNameOptions {
  visible: boolean;
  /** A tap on the small target at the start of the name; leave out for names that take no tap (the portal). */
  onTap?: (id: number) => void;
  /** The map's CSS turn in degrees (the driver map turns heading up), so names stay upright. */
  turn?: number;
  /** `dayof` (blue, the green, driver and Flag maps) or `plan` (the portal's dashed areas). */
  tone: "dayof" | "plan";
}

/**
 * Area names along each area's top edge, inside the outline, turned to the edge and kept upright,
 * cut to the edge's length with an ellipsis. The name never takes a tap; with `onTap`, a small target
 * at its start opens the area. Laid out again on every zoom (the edge's pixel length changes) and when
 * the areas or the turn change. The zoom declutter classes (declutter.ts) still apply.
 */
export const useAreaNames = (map: L.Map | null, areas: readonly NamedArea[] | undefined, opts: AreaNameOptions): void => {
  const group = useRef<L.LayerGroup | null>(null);
  const tap = useRef(opts.onTap);
  tap.current = opts.onTap;
  const hasTap = opts.onTap !== undefined;

  useEffect(() => {
    if (!map) return;
    const g = L.layerGroup().addTo(map);
    group.current = g;
    return () => {
      g.remove();
      group.current = null;
    };
  }, [map]);

  useEffect(() => {
    const g = group.current;
    if (!map || !g) return;
    const draw = (): void => {
      g.clearLayers();
      if (!opts.visible || !areas) return;
      const big = largestAreaIds(areas);
      for (const a of areas) {
        const ll = openRing(a.ring);
        const px = ll.map((p) => map.latLngToLayerPoint(p));
        const place = placeOnTopEdge(px, opts.turn ?? 0);
        if (!place) continue;
        const start = ll[place.from]!;
        const width = Math.max(0, place.length - END_PAD_PX * 2);
        const dy = place.insideBelow ? EDGE_GAP_PX : -(EDGE_GAP_PX + LINE_PX);
        const box = document.createElement("div");
        box.className = `lrb-area-name lrb-area-name-${opts.tone} ${pillClass(big.has(a.id))}${a.doNotTouch ? " lrb-area-name-dnt" : ""}`;
        box.dataset.areaId = String(a.id);
        box.style.width = `${width}px`;
        box.style.transform = `rotate(${place.angle}deg) translate(${END_PAD_PX}px, ${dy}px)`;
        if (hasTap) {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "lrb-area-hit";
          btn.setAttribute("aria-label", a.label);
          btn.innerHTML = '<span class="lrb-area-dot" aria-hidden="true"></span>';
          L.DomEvent.on(btn, "click", (e) => {
            L.DomEvent.stop(e);
            tap.current?.(a.id);
          });
          L.DomEvent.disableClickPropagation(btn);
          box.appendChild(btn);
        }
        const text = document.createElement("span");
        text.className = "lrb-area-text";
        text.textContent = shortAreaLabel(a.label);
        box.appendChild(text);
        g.addLayer(L.marker(start, { icon: L.divIcon({ className: "lrb-area-anchor", html: box, iconSize: [0, 0] }), interactive: false, keyboard: false, zIndexOffset: 300 }));
      }
    };
    draw();
    map.on("zoomend", draw);
    return () => {
      map.off("zoomend", draw);
    };
  }, [map, areas, opts.visible, opts.turn, opts.tone, hasTap]);
};
// #endregion
