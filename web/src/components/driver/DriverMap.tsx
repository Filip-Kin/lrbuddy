import L from "leaflet";
import { useEffect, useRef, useState } from "react";
import { DEFAULT_CENTER, ESRI_BASE, ESRI_DARK_BASE, ESRI_DARK_LABELS, ESRI_LABELS, MAX_NATIVE_ZOOM, MAX_ZOOM } from "../../lib/map/basemap.ts";
import { ccBody, escapeHtml, routeLine } from "../../lib/map/markers.ts";
import { usePrefersDark } from "../../lib/map/MapView.tsx";
import { ahead, metresPerPixel, turn, type LatLng } from "../../pages/plan/survey/geo.ts";

export interface DriverMapStop extends LatLng {
  key: string;
  n: number;
  active: boolean;
  name: string;
}

/** Zoom while following the truck: a few blocks ahead. */
export const FOLLOW_ZOOM = 17;
/** Share of the visible height the truck sits below the centre, so more road ahead shows. */
const LOOK_AHEAD = 0.22;

const STAR_SVG =
  '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M12 2.5l2.9 6.1 6.6.8-4.9 4.6 1.3 6.5L12 17.3l-5.9 3.2 1.3-6.5L2.5 9.4l6.6-.8z"/></svg>';

// #region icons
/** Upright inside a turned map: the map's square sets --lrb-unrot to the opposite turn. */
const UNROT = "transform:rotate(var(--lrb-unrot,0deg))";

/** The truck: blue dot with a heading cone, drawn in map space so the map's turn points it up. */
const truckIcon = (heading: number | null): L.DivIcon =>
  L.divIcon({
    className: "lrb-me",
    iconSize: [64, 64],
    iconAnchor: [32, 32],
    html:
      (heading === null
        ? ""
        : `<svg viewBox="0 0 64 64" width="64" height="64" aria-hidden="true" style="position:absolute;left:0;top:0;transform:rotate(${heading}deg)"><path d="M32 32 L18 3 A30 30 0 0 1 46 3 Z" fill="#2f80ed" fill-opacity="0.28" stroke="#2f80ed" stroke-opacity="0.6"/></svg>`) +
      '<span style="position:absolute;left:21px;top:21px"><span class="lrb-me-dot"></span></span>',
  });

const stopIcon = (n: number, active: boolean): L.DivIcon =>
  L.divIcon({
    className: `lrb-stop${active ? " lrb-stop-active" : ""}`,
    html: `<span style="${UNROT}">${n}</span>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });

const ccStarIcon = (name: string, letter: string | null): L.DivIcon =>
  L.divIcon({
    className: "lrb-cc",
    html: `<span style="display:block;${UNROT}">${ccBody(letter, STAR_SVG)}<span class="lrb-tag">${escapeHtml(name)}</span></span>`,
    iconSize: [36, 36],
    iconAnchor: [18, 18],
  });
// #endregion

const setInteractive = (m: L.Map, on: boolean): void => {
  for (const h of [m.dragging, m.touchZoom, m.scrollWheelZoom, m.doubleClickZoom]) {
    if (on) h.enable();
    else h.disable();
  }
};

/**
 * The driver's map. While following, it centres a little ahead of the truck at
 * a fixed zoom and turns heading up the way Survey drive mode does: Leaflet
 * cannot rotate, so the map sits in a square as wide as the frame's diagonal
 * and the square turns by minus the heading. A touch on the map (not on a
 * stop) stops following: the map snaps north up at once, so the drag that
 * started moves the map the way the finger goes, and pan and pinch work as on
 * any map until Recenter.
 */
export const DriverMap = ({
  at,
  heading,
  line,
  stops,
  cc,
  follow,
  onUnfollow,
  onStop,
}: {
  at: LatLng | null;
  heading: number | null;
  line: ReadonlyArray<[number, number]>;
  stops: readonly DriverMapStop[];
  cc: (LatLng & { name: string; letter: string | null }) | null;
  follow: boolean;
  onUnfollow: () => void;
  onStop: (key: string) => void;
}) => {
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const tiles = useRef<L.Layer[]>([]);
  const lineLayer = useRef<L.LayerGroup | null>(null);
  const markLayer = useRef<L.LayerGroup | null>(null);
  const truckLayer = useRef<L.LayerGroup | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const rot = useRef(0);
  const followRef = useRef(follow);
  followRef.current = follow;
  const unfollowRef = useRef(onUnfollow);
  unfollowRef.current = onUnfollow;
  const onStopRef = useRef(onStop);
  onStopRef.current = onStop;
  const dark = usePrefersDark();

  useEffect(() => {
    const el = outer.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!inner.current || map.current) return;
    const m = L.map(inner.current, {
      zoomControl: false,
      attributionControl: false,
      keyboard: false,
      boxZoom: false,
      zoomSnap: 0,
      maxZoom: MAX_ZOOM,
    }).setView(DEFAULT_CENTER, FOLLOW_ZOOM);
    setInteractive(m, false);
    lineLayer.current = L.layerGroup().addTo(m);
    markLayer.current = L.layerGroup().addTo(m);
    truckLayer.current = L.layerGroup().addTo(m);
    map.current = m;
    return () => {
      m.remove();
      map.current = null;
      tiles.current = [];
    };
  }, []);

  // A first touch or wheel on the map while following hands the map to the driver.
  useEffect(() => {
    const el = outer.current;
    if (!el) return;
    const take = (e: Event): void => {
      if (!followRef.current) return;
      if (e.target instanceof Element && e.target.closest(".leaflet-marker-icon")) return;
      const m = map.current;
      const sq = inner.current;
      if (!m || !sq) return;
      followRef.current = false;
      rot.current = 0;
      sq.style.transition = "none";
      sq.style.transform = "rotate(0deg)";
      sq.style.setProperty("--lrb-unrot", "0deg");
      setInteractive(m, true);
      unfollowRef.current();
    };
    el.addEventListener("pointerdown", take, { capture: true });
    el.addEventListener("wheel", take, { capture: true, passive: true });
    return () => {
      el.removeEventListener("pointerdown", take, { capture: true });
      el.removeEventListener("wheel", take, { capture: true });
    };
  }, []);

  useEffect(() => {
    const m = map.current;
    if (m) setInteractive(m, !follow);
  }, [follow]);

  useEffect(() => {
    const m = map.current;
    if (!m) return;
    for (const t of tiles.current) m.removeLayer(t);
    const opts = { maxNativeZoom: MAX_NATIVE_ZOOM, maxZoom: MAX_ZOOM };
    tiles.current = [L.tileLayer(dark ? ESRI_DARK_BASE : ESRI_BASE, opts).addTo(m), L.tileLayer(dark ? ESRI_DARK_LABELS : ESRI_LABELS, opts).addTo(m)];
    for (const t of tiles.current) (t as L.TileLayer).bringToBack();
  }, [dark]);

  const d = Math.ceil(Math.hypot(size.w, size.h));

  useEffect(() => {
    map.current?.invalidateSize({ pan: false });
  }, [d]);

  // Follow: turn the square to the heading and centre a little ahead of the truck.
  useEffect(() => {
    const m = map.current;
    const sq = inner.current;
    if (!m || !sq || !follow) return;
    sq.style.transition = "";
    rot.current = heading === null ? rot.current + turn(rot.current, 0) : rot.current + turn(rot.current, -heading);
    sq.style.transform = `rotate(${rot.current}deg)`;
    sq.style.setProperty("--lrb-unrot", `${-rot.current}deg`);
    if (!at) return;
    const shift = heading === null ? 0 : LOOK_AHEAD * size.h * metresPerPixel(at.lat, FOLLOW_ZOOM);
    const c = heading === null ? at : ahead(at, heading, shift);
    if (Math.abs(m.getZoom() - FOLLOW_ZOOM) > 0.01) m.setView([c.lat, c.lng], FOLLOW_ZOOM, { animate: false });
    else m.panTo([c.lat, c.lng], { animate: true, duration: 0.6, easeLinearity: 1 });
  }, [follow, at, heading, size.h, d]);

  useEffect(() => {
    const g = truckLayer.current;
    if (!g) return;
    g.clearLayers();
    if (at) L.marker([at.lat, at.lng], { icon: truckIcon(heading), interactive: false, keyboard: false, zIndexOffset: 1000 }).addTo(g);
  }, [at, heading]);

  useEffect(() => {
    const g = lineLayer.current;
    if (!g) return;
    g.clearLayers();
    if (line.length > 1) routeLine(line.map((p) => [p[0], p[1]] as [number, number])).addTo(g);
  }, [line]);

  useEffect(() => {
    const g = markLayer.current;
    if (!g) return;
    g.clearLayers();
    if (cc) L.marker([cc.lat, cc.lng], { icon: ccStarIcon(cc.name, cc.letter), keyboard: false, interactive: false }).addTo(g);
    // Later stops under earlier ones, the next stop on top.
    for (const s of [...stops].reverse()) {
      L.marker([s.lat, s.lng], { icon: stopIcon(s.n, s.active), title: s.name, alt: s.name, zIndexOffset: s.active ? 500 : 0 })
        .on("click", () => onStopRef.current(s.key))
        .addTo(g);
    }
  }, [stops, cc]);

  return (
    <div ref={outer} role="region" aria-label="Route map" className="absolute inset-0 overflow-hidden bg-surface-2">
      <div
        ref={inner}
        className="absolute transition-transform duration-500 ease-linear motion-reduce:transition-none"
        style={{ width: d || "100%", height: d || "100%", left: (size.w - d) / 2, top: (size.h - d) / 2 }}
      />
    </div>
  );
};
