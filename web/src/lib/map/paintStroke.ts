import L from "leaflet";
import { useEffect, useRef, useState } from "react";
import type { LotStatus } from "../../../../server/db/schema.ts";
import { hitAt, type Candidate } from "./paintHit.ts";

/** SPEC 23: below this zoom a finger covers several parcels, so Paint waits. */
export const PAINT_MIN_ZOOM = 16;
/** Pixels between hit tests along a fast stroke, so no parcel in its path is jumped over. */
const STEP_PX = 4;
/** A touch becomes a stroke after this much movement or time; a second finger before then is a pinch. */
const COMMIT_PX = 8;
const COMMIT_MS = 120;

/** The Leaflet internals its own pinch uses (leaflet/src/map/handler/Map.TouchZoom.js, 1.9). */
interface PinchInternals {
  _stop(): void;
  _moveStart(zoomChanged: boolean, noMoveStart: boolean): void;
  _move(center: L.LatLng, zoom: number, data: { pinch: boolean; round: boolean }): void;
  _limitZoom(zoom: number): number;
  _animateZoom(center: L.LatLng, zoom: number, startAnim: boolean, noUpdate: number | undefined): void;
  _resetView(center: L.LatLng, zoom: number): void;
}

export interface PaintStrokeOptions {
  /** Paint mode is on. */
  on: boolean;
  targets: readonly Candidate[];
  /** The status the brush gives this parcel, for colouring it as the finger crosses it; null for the Crew brush. */
  statusOf: (c: Candidate) => LotStatus | null;
  /** True for a parcel the brush would not change (already in its status, or nothing to assign). */
  skip: (c: Candidate) => boolean;
  /** Parcels the stroke in progress will change. */
  onCount: (n: number) => void;
  /** The stroke is over; `hits` are the parcels it changes, each once. */
  onStroke: (hits: Candidate[]) => void;
}

const elementsFor = (root: HTMLElement, c: Candidate): Element[] => [
  ...(c.lotId !== null ? root.querySelectorAll(`[data-lot-id="${c.lotId}"]`) : []),
  ...(c.lotId === null && c.parcelId ? root.querySelectorAll(`[data-parcel="${CSS.escape(c.parcelId)}"]`) : []),
];

/**
 * Pointer handling for Paint mode on a Leaflet map. While on and at zoom 16 or
 * more: one finger or a mouse drag paints (the map's own drag pan is off), two
 * fingers still pinch and pan, the wheel still zooms, and taps on parcels and
 * markers open nothing. Parcels are found by polygon on `targets`, not by DOM
 * hit testing, so a fast stroke is sampled every few pixels along its path.
 * Returns whether the zoom allows painting.
 */
export const usePaintStroke = (map: L.Map | null, opts: PaintStrokeOptions): { zoomOk: boolean } => {
  const ref = useRef(opts);
  ref.current = opts;
  const [zoomOk, setZoomOk] = useState(false);

  useEffect(() => {
    if (!map) return;
    const check = (): void => setZoomOk(map.getZoom() >= PAINT_MIN_ZOOM);
    check();
    map.on("zoomend", check);
    return () => {
      map.off("zoomend", check);
    };
  }, [map]);

  const live = opts.on && zoomOk;

  useEffect(() => {
    if (!map || !live) return;
    const el = map.getContainer();
    const wasDragging = map.dragging.enabled();
    const wasDbl = map.doubleClickZoom.enabled();
    const wasBox = map.boxZoom.enabled();
    const wasTouchZoom = map.touchZoom.enabled();
    map.dragging.disable();
    map.doubleClickZoom.disable();
    map.boxZoom.disable();
    // Two fingers pan and pinch here, not in Leaflet: its touch zoom only zooms about the centre
    // and never pans with dragging off, so one finger paints and two move the map.
    map.touchZoom.disable();
    // With dragging off, Leaflet leaves the container at touch-action pan-x pan-y, so Android
    // takes a one-finger drag as a scroll and fires pointercancel a few pixels in, which killed
    // every stroke. Own the touches while painting; Leaflet's pinch zoom still works.
    const prevTouchAction = el.style.touchAction;
    el.style.touchAction = "none";

    const touches = new Map<number, L.Point>();
    const lm = map as unknown as PinchInternals;
    let gesture: { mid: L.Point; dist: number; zoom: number; anchor: L.LatLng; moved: boolean; center: L.LatLng; to: number; frame: number } | null = null;
    const pair = (): [L.Point, L.Point] | null => {
      const v = [...touches.values()];
      return v.length >= 2 ? [v[0]!, v[1]!] : null;
    };
    const startGesture = (): void => {
      const pts = pair();
      if (!pts) return;
      lm._stop();
      const mid = pts[0].add(pts[1]).divideBy(2);
      gesture = { mid, dist: Math.max(1, pts[0].distanceTo(pts[1])), zoom: map.getZoom(), anchor: map.containerPointToLatLng(mid), moved: false, center: map.getCenter(), to: map.getZoom(), frame: 0 };
    };
    // Moves the map the way Leaflet's own pinch does (Map.TouchZoom): one `_move` per frame with
    // `pinch`, which scales the tiles and vectors already drawn. `setView` per touch move reset the
    // whole view every frame instead: every tile thrown away and refetched, every path redrawn.
    const moveGesture = (): void => {
      const pts = pair();
      const g = gesture;
      if (!g || !pts) return;
      const mid = pts[0].add(pts[1]).divideBy(2);
      const dist = Math.max(1, pts[0].distanceTo(pts[1]));
      const zoom = Math.min(map.getMaxZoom(), Math.max(map.getMinZoom(), g.zoom + Math.log2(dist / g.dist)));
      // Keep the spot that was under the fingers under the fingers.
      g.center = map.unproject(map.project(g.anchor, zoom).subtract(mid).add(map.getSize().divideBy(2)), zoom);
      g.to = zoom;
      if (!g.moved) {
        lm._moveStart(true, false);
        g.moved = true;
      }
      cancelAnimationFrame(g.frame);
      g.frame = requestAnimationFrame(() => lm._move(g.center, g.to, { pinch: true, round: false }));
    };
    const endGesture = (): void => {
      const g = gesture;
      if (!g) return;
      gesture = null;
      cancelAnimationFrame(g.frame);
      if (!g.moved) return;
      const zoom = lm._limitZoom(g.to);
      if (map.options.zoomAnimation) lm._animateZoom(g.center, zoom, true, map.options.zoomSnap);
      else lm._resetView(g.center, zoom);
    };
    let stroke: {
      id: number;
      touch: boolean;
      committed: boolean;
      startAt: number;
      start: L.Point;
      last: L.Point;
      hits: Map<string, Candidate>;
      styled: Array<{ el: Element; cls: string | null; w: string | null; fo: string | null }>;
    } | null = null;

    const nearDeg = (): number => {
      const c = map.getCenter();
      const p = map.latLngToContainerPoint(c);
      const q = map.containerPointToLatLng(L.point(p.x + 14, p.y));
      return Math.abs(q.lng - c.lng);
    };

    const style = (c: Candidate): void => {
      if (!stroke) return;
      const status = ref.current.statusOf(c);
      for (const e of elementsFor(el, c)) {
        stroke.styled.push({ el: e, cls: e.getAttribute("class"), w: e.getAttribute("stroke-width"), fo: e.getAttribute("fill-opacity") });
        if (status && e instanceof SVGElement) {
          e.setAttribute("class", `lrb-lot-shape lrb-lot-shape-${status} lrb-paint-hit leaflet-interactive`);
          e.setAttribute("stroke-width", status === "not_todo" ? "1" : "2");
          e.setAttribute("fill-opacity", status === "not_todo" ? "0.01" : "0.3");
        } else {
          e.classList.add("lrb-paint-hit");
        }
      }
    };

    const visit = (pt: L.Point): void => {
      if (!stroke) return;
      const ll = map.containerPointToLatLng(pt);
      const c = hitAt(ref.current.targets, ll.lng, ll.lat, nearDeg());
      if (!c || stroke.hits.has(c.key) || ref.current.skip(c)) return;
      stroke.hits.set(c.key, c);
      if (stroke.committed) style(c);
      ref.current.onCount(stroke.hits.size);
    };

    const along = (to: L.Point): void => {
      if (!stroke) return;
      const from = stroke.last;
      const d = from.distanceTo(to);
      const n = Math.max(1, Math.ceil(d / STEP_PX));
      for (let i = 1; i <= n; i++) visit(L.point(from.x + ((to.x - from.x) * i) / n, from.y + ((to.y - from.y) * i) / n));
      stroke.last = to;
    };

    const commit = (): void => {
      if (!stroke || stroke.committed) return;
      stroke.committed = true;
      for (const c of stroke.hits.values()) style(c);
    };

    const abort = (): void => {
      if (!stroke) return;
      for (const s of stroke.styled) {
        if (s.cls === null) s.el.removeAttribute("class");
        else s.el.setAttribute("class", s.cls);
        if (s.w !== null) s.el.setAttribute("stroke-width", s.w);
        if (s.fo !== null) s.el.setAttribute("fill-opacity", s.fo);
      }
      stroke = null;
      ref.current.onCount(0);
    };

    const finish = (): void => {
      if (!stroke) return;
      commit();
      const hits = [...stroke.hits.values()];
      stroke = null;
      if (hits.length > 0) ref.current.onStroke(hits);
    };

    const point = (e: PointerEvent): L.Point => {
      const r = el.getBoundingClientRect();
      return L.point(e.clientX - r.left, e.clientY - r.top);
    };
    const onControl = (e: Event): boolean => e.target instanceof Element && e.target.closest(".leaflet-control") !== null;

    const down = (e: PointerEvent): void => {
      if (onControl(e)) return;
      if (e.pointerType === "touch") {
        touches.set(e.pointerId, point(e));
        if (touches.size > 1) {
          // A second finger: pan and pinch. Before the stroke shows it is dropped; after, it ends here.
          if (stroke && !stroke.committed) abort();
          else finish();
          if (!gesture) startGesture();
          return;
        }
      } else if (e.button !== 0) return;
      const p = point(e);
      stroke = { id: e.pointerId, touch: e.pointerType === "touch", committed: e.pointerType !== "touch", startAt: performance.now(), start: p, last: p, hits: new Map(), styled: [] };
      ref.current.onCount(0);
      visit(p);
    };
    const move = (e: PointerEvent): void => {
      if (touches.has(e.pointerId)) touches.set(e.pointerId, point(e));
      if (gesture) {
        moveGesture();
        return;
      }
      if (!stroke || e.pointerId !== stroke.id) return;
      const p = point(e);
      along(p);
      if (!stroke.committed && (p.distanceTo(stroke.start) > COMMIT_PX || performance.now() - stroke.startAt > COMMIT_MS)) commit();
    };
    const up = (e: PointerEvent): void => {
      touches.delete(e.pointerId);
      // The gesture ends when a finger lifts; the one left behind does not start painting.
      if (gesture) {
        endGesture();
        return;
      }
      if (!stroke || e.pointerId !== stroke.id) return;
      if (e.type === "pointercancel" && !stroke.committed) abort();
      else finish();
    };
    // Taps on parcels, pills and markers open nothing while painting; the zoom buttons still work.
    const click = (e: MouseEvent): void => {
      if (onControl(e)) return;
      e.stopPropagation();
      e.preventDefault();
    };

    el.addEventListener("pointerdown", down, true);
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", up, true);
    el.addEventListener("click", click, true);
    el.addEventListener("dblclick", click, true);
    return () => {
      abort();
      el.removeEventListener("pointerdown", down, true);
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", up, true);
      el.removeEventListener("click", click, true);
      el.removeEventListener("dblclick", click, true);
      endGesture();
      el.style.touchAction = prevTouchAction;
      if (wasTouchZoom) map.touchZoom.enable();
      if (wasDragging) map.dragging.enable();
      if (wasDbl) map.doubleClickZoom.enable();
      if (wasBox) map.boxZoom.enable();
    };
  }, [map, live]);

  return { zoomOk };
};
