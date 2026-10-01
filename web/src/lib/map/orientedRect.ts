/**
 * Oriented rectangle selection (SPEC 16). Detroit's east side streets run on
 * a diagonal, so an axis-aligned box never fits a block. Two clicks along the
 * street set the long axis, moving the pointer sideways sets the width and a
 * third click fixes it. After that the rectangle has a rotate handle at one
 * end, a handle on each edge and one on each corner.
 *
 * MapView keeps its Leaflet map to itself, so this module finds it through a
 * Leaflet init hook: every map registers itself on creation and leaves on
 * `unload`. `useLeafletMap(ref)` returns the map inside a wrapper element.
 */
import L from "leaflet";
import { useEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";

// #region geometry
export interface LatLng {
  lat: number;
  lng: number;
}

/** Centre, long-axis angle (radians from east, counter-clockwise, in metres space), length and width in metres. */
export interface OrientedRect {
  center: LatLng;
  angle: number;
  length: number;
  width: number;
}

/** Closed GeoJSON ring: [lng, lat] pairs, first equal to last. */
export type Ring = Array<[number, number]>;

interface XY {
  x: number;
  y: number;
}

const RAD = Math.PI / 180;
const M_LAT = 110_574;
const M_LNG = 111_320;
/** Smallest side a rectangle keeps while it is dragged, in metres. */
const MIN_SIDE = 4;
/** A third click this close to the axis gives a rectangle this wide, centred on it (a tap with no pointer to follow). */
const NEAR_AXIS = 3;
const DEFAULT_WIDTH = 30;

const toXY = (o: LatLng, p: LatLng): XY => ({ x: (p.lng - o.lng) * M_LNG * Math.cos(o.lat * RAD), y: (p.lat - o.lat) * M_LAT });
const fromXY = (o: LatLng, v: XY): LatLng => ({ lat: o.lat + v.y / M_LAT, lng: o.lng + v.x / (M_LNG * Math.cos(o.lat * RAD)) });
const dot = (a: XY, b: XY): number => a.x * b.x + a.y * b.y;
const add = (...vs: XY[]): XY => vs.reduce((s, v) => ({ x: s.x + v.x, y: s.y + v.y }), { x: 0, y: 0 });
const mul = (v: XY, k: number): XY => ({ x: v.x * k, y: v.y * k });

/** Unit vectors along the long axis (u) and across it (v). */
const axes = (angle: number): { u: XY; v: XY } => ({ u: { x: Math.cos(angle), y: Math.sin(angle) }, v: { x: -Math.sin(angle), y: Math.cos(angle) } });

/** Corner signs along u and v, in ring order. Edge i runs from corner i to corner i + 1. */
const CORNERS: ReadonlyArray<readonly [number, number]> = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
];
/** Outward direction of each edge as (along u, along v). */
const EDGES: ReadonlyArray<readonly [number, number]> = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];

const cornerXY = (r: OrientedRect, k: number): XY => {
  const { u, v } = axes(r.angle);
  const [a, b] = CORNERS[k] ?? [0, 0];
  return add(mul(u, (a * r.length) / 2), mul(v, (b * r.width) / 2));
};

export const rectCorners = (r: OrientedRect): LatLng[] => CORNERS.map((_c, k) => fromXY(r.center, cornerXY(r, k)));

/** The rectangle as a closed GeoJSON ring, ready for `crews.area`. */
export const rectRing = (r: OrientedRect): Ring => {
  const pts = rectCorners(r).map((p): [number, number] => [p.lng, p.lat]);
  return [...pts, pts[0]!];
};

export const rectPolygon = (r: OrientedRect): { type: "Polygon"; coordinates: Ring[] } => ({ type: "Polygon", coordinates: [rectRing(r)] });

/** Closed [lat, lng] outline, the order Leaflet and MapLine take. */
export const rectLatLngs = (r: OrientedRect): Array<[number, number]> => rectRing(r).map(([lng, lat]) => [lat, lng]);

/** [west, south, east, north] around the rectangle, for queries that only take an envelope. */
export const rectBBox = (r: OrientedRect): [number, number, number, number] => {
  const c = rectCorners(r);
  return [Math.min(...c.map((p) => p.lng)), Math.min(...c.map((p) => p.lat)), Math.max(...c.map((p) => p.lng)), Math.max(...c.map((p) => p.lat))];
};

/**
 * Reads a stored ring (four corners, closed or not) back into a rectangle.
 * The longer side becomes the long axis. Null for anything with fewer than
 * four corners or no area.
 */
export const rectFromRing = (ring: ReadonlyArray<ReadonlyArray<number>>): OrientedRect | null => {
  const pts: LatLng[] = [];
  for (const p of ring) {
    const [lng, lat] = p;
    if (lng === undefined || lat === undefined) continue;
    const last = pts[pts.length - 1];
    if (last && last.lat === lat && last.lng === lng) continue;
    pts.push({ lat, lng });
  }
  const first = pts[0];
  const end = pts[pts.length - 1];
  if (first && end && pts.length > 1 && first.lat === end.lat && first.lng === end.lng) pts.pop();
  if (pts.length < 4) return null;
  const four = pts.slice(0, 4);
  const center = { lat: four.reduce((s, p) => s + p.lat, 0) / 4, lng: four.reduce((s, p) => s + p.lng, 0) / 4 };
  const [p0, p1, p2] = four.map((p) => toXY(center, p)) as [XY, XY, XY, XY];
  const e1 = { x: p1.x - p0.x, y: p1.y - p0.y };
  const e2 = { x: p2.x - p1.x, y: p2.y - p1.y };
  const l1 = Math.hypot(e1.x, e1.y);
  const l2 = Math.hypot(e2.x, e2.y);
  if (l1 < 0.5 || l2 < 0.5) return null;
  return l1 >= l2 ? { center, angle: Math.atan2(e1.y, e1.x), length: l1, width: l2 } : { center, angle: Math.atan2(e2.y, e2.x), length: l2, width: l1 };
};

/** True when the point lies inside the rectangle (edges included). */
export const inRect = (p: LatLng, r: OrientedRect): boolean => {
  const d = toXY(r.center, p);
  const { u, v } = axes(r.angle);
  return Math.abs(dot(d, u)) <= r.length / 2 + 1e-6 && Math.abs(dot(d, v)) <= r.width / 2 + 1e-6;
};

/** Items whose centre (lat, lng) falls inside the rectangle. */
export const insideRect = <T extends LatLng>(items: readonly T[], r: OrientedRect): T[] => items.filter((i) => inRect(i, r));

const metres = (m: number): string => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`);

/** "180 x 40 m", long side first. */
export const rectSize = (r: OrientedRect): string => {
  const [a, b] = r.length >= r.width ? [r.length, r.width] : [r.width, r.length];
  return a < 1000 && b < 1000 ? `${Math.round(a)} x ${Math.round(b)} m` : `${metres(a)} x ${metres(b)}`;
};

/** Rectangle from the axis a to b and a third point that sets the width on its side of the axis. */
export const rectFromAxis = (a: LatLng, b: LatLng, side: LatLng): OrientedRect => {
  const d = toXY(a, b);
  const length = Math.max(MIN_SIDE, Math.hypot(d.x, d.y));
  const angle = Math.atan2(d.y, d.x);
  const { v } = axes(angle);
  const off = dot(toXY(a, side), v);
  const mid = mul(d, 0.5);
  if (Math.abs(off) < NEAR_AXIS) return { center: fromXY(a, mid), angle, length, width: DEFAULT_WIDTH };
  return { center: fromXY(a, add(mid, mul(v, off / 2))), angle, length, width: Math.max(MIN_SIDE, Math.abs(off)) };
};

/** Corner k moved to q, the opposite corner fixed. */
export const dragCorner = (r: OrientedRect, k: number, q: LatLng): OrientedRect => {
  const { u, v } = axes(r.angle);
  const o = cornerXY(r, (k + 2) % 4);
  const d = add(toXY(r.center, q), mul(o, -1));
  const [a, b] = CORNERS[k] ?? [1, 1];
  // Keep the corner on its own side of the fixed one, so the rectangle never turns inside out.
  const du = a * Math.max(MIN_SIDE, a * dot(d, u));
  const dv = b * Math.max(MIN_SIDE, b * dot(d, v));
  return { ...r, center: fromXY(r.center, add(o, mul(u, du / 2), mul(v, dv / 2))), length: Math.abs(du), width: Math.abs(dv) };
};

/** Edge i moved so it passes through q, the opposite edge fixed. */
export const dragEdge = (r: OrientedRect, i: number, q: LatLng): OrientedRect => {
  const { u, v } = axes(r.angle);
  const [a, b] = EDGES[i] ?? [1, 0];
  const n = add(mul(u, a), mul(v, b));
  const half = a !== 0 ? r.length / 2 : r.width / 2;
  const s = Math.max(MIN_SIDE - half, dot(toXY(r.center, q), n));
  const size = s + half;
  const center = fromXY(r.center, mul(n, (s - half) / 2));
  return a !== 0 ? { ...r, center, length: size } : { ...r, center, width: size };
};

/** Turned about its centre so the +u end points at q. */
export const rotateTo = (r: OrientedRect, q: LatLng): OrientedRect => {
  const d = toXY(r.center, q);
  return Math.hypot(d.x, d.y) < 0.5 ? r : { ...r, angle: Math.atan2(d.y, d.x) };
};
// #endregion

// #region map registry
const maps = new Set<L.Map>();
const listeners = new Set<() => void>();
let version = 0;
const bump = (): void => {
  version++;
  for (const l of listeners) l();
};
L.Map.addInitHook(function (this: L.Map) {
  const m = this;
  maps.add(m);
  m.on("unload", () => {
    maps.delete(m);
    bump();
  });
  bump();
});
const subscribe = (cb: () => void): (() => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};

/** The Leaflet map rendered inside `holder` (a MapView wrapper), once it exists. */
export const useLeafletMap = (holder: RefObject<HTMLElement | null>): L.Map | null => {
  useSyncExternalStore(subscribe, () => version);
  const el = holder.current;
  if (!el) return null;
  for (const m of maps) if (el.contains(m.getContainer())) return m;
  return null;
};
// #endregion

// #region styles
const CSS = `
.lrb-orect { stroke: var(--ink); fill: var(--brand); }
.lrb-orect-preview { stroke: var(--ink); fill: var(--brand); stroke-dasharray: 6 5; }
.lrb-orect-h { display: flex; align-items: center; justify-content: center; touch-action: none; }
.lrb-orect-h span { display: block; width: 14px; height: 14px; box-sizing: border-box; background: var(--surface); border: 2.5px solid var(--ink); border-radius: 3px; box-shadow: 0 0 0 1.5px var(--surface); }
.lrb-orect-edge span { border-radius: 9999px; width: 13px; height: 13px; }
.lrb-orect-rot span { border-radius: 9999px; width: 18px; height: 18px; background: var(--brand); }
.lrb-orect-corner { cursor: move; }
.lrb-orect-edge { cursor: ew-resize; }
.lrb-orect-rot { cursor: grab; }
.lrb-orect-dot span { width: 12px; height: 12px; border-radius: 9999px; background: var(--ink); border-color: var(--surface); }
.leaflet-container.lrb-orect-drawing, .leaflet-container.lrb-orect-drawing .leaflet-interactive { cursor: crosshair; }
`;
const injectCss = (): void => {
  if (typeof document === "undefined" || document.getElementById("lrb-orect-css")) return;
  const el = document.createElement("style");
  el.id = "lrb-orect-css";
  el.textContent = CSS;
  document.head.appendChild(el);
};
// #endregion

// #region tool
export type DrawStep = "first" | "second" | "width";

type Phase = { kind: "idle" } | { kind: "first" } | { kind: "second"; a: LatLng } | { kind: "width"; a: LatLng; b: LatLng };

interface ToolCallbacks {
  onChange: (r: OrientedRect) => void;
  onStep: (s: DrawStep | null) => void;
  onCancel: () => void;
}

const handleIcon = (kind: "corner" | "edge" | "rot" | "dot"): L.DivIcon =>
  L.divIcon({ className: `lrb-orect-h lrb-orect-${kind}`, html: "<span></span>", iconSize: [30, 30], iconAnchor: [15, 15] });

/** Pixels from the end edge to the rotate handle. */
const ROTATE_GAP_PX = 30;

/**
 * The drawing state machine and the handles for one rectangle on one map.
 * Live drags redraw without React; the owner hears about the rectangle on
 * draw finish and on each drag end.
 */
class Tool {
  private readonly group: L.LayerGroup;
  private readonly preview: L.LayerGroup;
  private shape: L.Polygon | null = null;
  private handles: L.Marker[] = [];
  private value: OrientedRect | null = null;
  private editable = false;
  private phase: Phase = { kind: "idle" };
  private dblClick = false;

  constructor(
    private readonly map: L.Map,
    private readonly cb: ToolCallbacks,
  ) {
    injectCss();
    this.group = L.layerGroup().addTo(map);
    this.preview = L.layerGroup().addTo(map);
    map.on("click", this.onClick);
    map.on("mousemove", this.onMove);
    map.on("zoomend", this.placeHandles);
    document.addEventListener("keydown", this.onKey);
  }

  destroy(): void {
    this.setDrawing(false);
    this.map.off("click", this.onClick);
    this.map.off("mousemove", this.onMove);
    this.map.off("zoomend", this.placeHandles);
    document.removeEventListener("keydown", this.onKey);
    this.group.remove();
    this.preview.remove();
  }

  setValue(r: OrientedRect | null): void {
    this.value = r;
    this.render();
  }

  setEditable(on: boolean): void {
    this.editable = on;
    this.render();
  }

  setDrawing(on: boolean): void {
    const was = this.phase.kind !== "idle";
    if (on === was) return;
    const box = this.map.getContainer();
    if (on) {
      this.dblClick = this.map.doubleClickZoom.enabled();
      this.map.doubleClickZoom.disable();
      box.classList.add("lrb-orect-drawing");
      this.phase = { kind: "first" };
    } else {
      if (this.dblClick) this.map.doubleClickZoom.enable();
      box.classList.remove("lrb-orect-drawing");
      this.phase = { kind: "idle" };
    }
    this.preview.clearLayers();
    this.render();
    this.emitStep();
  }

  private emitStep(): void {
    const k = this.phase.kind;
    this.cb.onStep(k === "idle" ? null : k);
  }

  private readonly onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape" && this.phase.kind !== "idle") this.cb.onCancel();
  };

  private readonly onClick = (e: L.LeafletMouseEvent): void => {
    const p = { lat: e.latlng.lat, lng: e.latlng.lng };
    const ph = this.phase;
    if (ph.kind === "first") {
      this.phase = { kind: "second", a: p };
    } else if (ph.kind === "second") {
      const d = toXY(ph.a, p);
      // A double click on one spot is not an axis.
      if (Math.hypot(d.x, d.y) < MIN_SIDE) return;
      this.phase = { kind: "width", a: ph.a, b: p };
    } else if (ph.kind === "width") {
      const r = rectFromAxis(ph.a, ph.b, p);
      this.setDrawing(false);
      this.cb.onChange(r);
      return;
    } else return;
    this.drawPreview(p);
    this.emitStep();
  };

  private readonly onMove = (e: L.LeafletMouseEvent): void => {
    if (this.phase.kind === "second" || this.phase.kind === "width") this.drawPreview({ lat: e.latlng.lat, lng: e.latlng.lng });
  };

  private drawPreview(p: LatLng): void {
    const ph = this.phase;
    this.preview.clearLayers();
    if (ph.kind === "second") {
      L.marker([ph.a.lat, ph.a.lng], { icon: handleIcon("dot"), interactive: false, keyboard: false }).addTo(this.preview);
      L.polyline(
        [
          [ph.a.lat, ph.a.lng],
          [p.lat, p.lng],
        ],
        { className: "lrb-orect-preview", weight: 2.5, interactive: false },
      ).addTo(this.preview);
    } else if (ph.kind === "width") {
      const r = rectFromAxis(ph.a, ph.b, p);
      L.polygon(rectLatLngs(r).slice(0, 4), { className: "lrb-orect-preview", weight: 2.5, fillOpacity: 0.12, interactive: false }).addTo(this.preview);
      for (const q of [ph.a, ph.b]) L.marker([q.lat, q.lng], { icon: handleIcon("dot"), interactive: false, keyboard: false }).addTo(this.preview);
    }
  }

  private render(): void {
    this.group.clearLayers();
    this.shape = null;
    this.handles = [];
    const r = this.value;
    if (!r || this.phase.kind !== "idle") return;
    this.shape = L.polygon(rectLatLngs(r).slice(0, 4), { className: "lrb-orect", weight: 2.5, fillOpacity: 0.12, interactive: false }).addTo(this.group);
    if (!this.editable) return;
    const make = (kind: "corner" | "edge" | "rot", label: string, move: (start: OrientedRect, q: LatLng) => OrientedRect): void => {
      const m = L.marker([r.center.lat, r.center.lng], { icon: handleIcon(kind), draggable: true, keyboard: false, title: label, alt: label, zIndexOffset: 2000 });
      let start: OrientedRect | null = null;
      m.on("dragstart", () => {
        start = this.value;
      });
      m.on("drag", () => {
        if (!start) return;
        const ll = m.getLatLng();
        this.value = move(start, { lat: ll.lat, lng: ll.lng });
        this.shape?.setLatLngs(rectLatLngs(this.value).slice(0, 4));
        this.placeHandles(m);
      });
      m.on("dragend", () => {
        start = null;
        this.placeHandles();
        if (this.value) this.cb.onChange(this.value);
      });
      m.addTo(this.group);
      this.handles.push(m);
    };
    for (let k = 0; k < 4; k++) make("corner", "Corner", (s, q) => dragCorner(s, k, q));
    for (let i = 0; i < 4; i++) make("edge", "Edge", (s, q) => dragEdge(s, i, q));
    make("rot", "Rotate", (s, q) => rotateTo(s, q));
    this.placeHandles();
  }

  /** Puts every handle (but the one being dragged) where the rectangle says it goes. */
  private readonly placeHandles = (skip?: unknown): void => {
    const r = this.value;
    if (!r || this.handles.length !== 9) return;
    const corners = rectCorners(r);
    const at: LatLng[] = [...corners];
    for (let i = 0; i < 4; i++) {
      const a = corners[i]!;
      const b = corners[(i + 1) % 4]!;
      at.push({ lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2 });
    }
    // Rotate handle sits a fixed number of pixels past the middle of the +u end.
    const mpp = (40_075_016.686 * Math.cos(r.center.lat * RAD)) / 2 ** (this.map.getZoom() + 8);
    const { u } = axes(r.angle);
    at.push(fromXY(r.center, mul(u, r.length / 2 + ROTATE_GAP_PX * mpp)));
    this.handles.forEach((h, i) => {
      const p = at[i];
      if (p && h !== skip) h.setLatLng([p.lat, p.lng]);
    });
  };
}
// #endregion

// #region hook
export interface OrientedRectOptions {
  /** True while the next clicks draw a new rectangle. */
  drawing: boolean;
  /** The rectangle on show, or nothing. Hidden while drawing. */
  value: OrientedRect | null;
  /** Shows the corner, edge and rotate handles. */
  editable?: boolean;
  /** A rectangle finished drawing, or a handle drag ended. */
  onChange: (r: OrientedRect) => void;
  /** Escape while drawing. */
  onCancel?: () => void;
}

/**
 * Attaches the tool to a map from `useLeafletMap`. Returns the drawing step,
 * for the label over the map: "first" and "second" wait for the two axis
 * clicks, "width" for the click that sets the width.
 */
export const useOrientedRect = (map: L.Map | null, opts: OrientedRectOptions): { step: DrawStep | null } => {
  const [step, setStep] = useState<DrawStep | null>(null);
  const tool = useRef<Tool | null>(null);
  const cbs = useRef(opts);
  cbs.current = opts;

  useEffect(() => {
    if (!map) return;
    const t = new Tool(map, {
      onChange: (r) => cbs.current.onChange(r),
      onStep: setStep,
      onCancel: () => cbs.current.onCancel?.(),
    });
    tool.current = t;
    return () => {
      t.destroy();
      tool.current = null;
      setStep(null);
    };
  }, [map]);

  useEffect(() => {
    tool.current?.setValue(opts.value);
  }, [map, opts.value]);
  useEffect(() => {
    tool.current?.setEditable(opts.editable ?? false);
  }, [map, opts.editable]);
  useEffect(() => {
    tool.current?.setDrawing(opts.drawing);
  }, [map, opts.drawing]);

  return { step };
};

/** Label for the bar over the map while drawing. */
export const STEP_LABEL: Record<DrawStep, string> = {
  first: "Street start",
  second: "Street end",
  width: "Width",
};
// #endregion
