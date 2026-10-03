import L from "leaflet";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LotGeometry } from "../../../../../server/db/schema.ts";
import { useDayOfLayer, type DayOfPlan } from "../../../components/green/dayOfLayer.ts";
import type { LotStatus } from "../../../lib/lotStatus.ts";
import { MapView, type MapMarker } from "../../../lib/map/MapView.tsx";
import { useParcelLayer, type BareParcel } from "../../../lib/map/parcelLayer.ts";
import { useOsmAlleys } from "../../../lib/map/alleyLayer.ts";
import type { LatLng } from "./pick.ts";

/** The strip and the full-screen map both sit at street level (SPEC 22, map strip). */
export const FLAG_MAP_ZOOM = 18;
const PICK_PANE = "lrb-flag-pick";
const ALLEY_HIT_PANE = "lrb-flag-alley-hit";
const RAD = Math.PI / 180;

// #region types
export interface FlagMapLot extends LatLng {
  id: number;
  status: LotStatus;
  geometry: LotGeometry | null;
  parcelId: string | null;
  crewId: number | null;
  address: string | null;
  /** A Before on the lot: Todo and In progress lots without one carry the camera badge. */
  hasBefore?: boolean;
}

/** Where the phone stood for a Before and which way its camera faced (SPEC 28): a yellow pin and cone. */
export interface MapSpot extends LatLng {
  heading: number | null;
}

/** Flag's camera badge (SPEC 28): a Todo or In progress lot still waiting for its Before. */
const needsBefore = (l: FlagMapLot, status: LotStatus): boolean => l.hasBefore === false && (status === "open" || status === "in_progress");

/** An alley half with no lot yet (SPEC 22, alleys): `a:<key>` and its centreline as [[lat, lng], ...]. */
export interface FlagMapAlley {
  key: string;
  line: ReadonlyArray<readonly [number, number]>;
}

interface Props {
  lots: readonly FlagMapLot[];
  parcels: readonly BareParcel[] | undefined;
  /** Alley halves that are not lots yet: a tap on one in the strip picks it. */
  alleys?: readonly FlagMapAlley[];
  plan: Pick<DayOfPlan, "areas"> | undefined;
  cc: (LatLng & { name: string; letter: string | null }) | null;
  fix: (LatLng & { accuracy: number | null }) | null;
  heading: number | null;
  /** The picked parcel's outline, drawn in yellow. */
  picked: { key: string; geometry: LotGeometry | null } | null;
  /** Statuses of flags still on their way to the server, keyed `l:<lot id>` or `p:<parcel id>`. */
  pending: ReadonlyMap<string, LotStatus>;
  /** Full screen: always Paint (SPEC 22), so taps paint, the map holds still and bare parcels draw at any zoom. */
  expanded: boolean;
  /** The Leaflet map once it exists, for Paint's stroke handling. */
  onMap: (map: L.Map | null) => void;
  /** A tap on a parcel in the strip: `l:<lot id>`, `p:<parcel id>`, `a:<alley half key>` or `t:<tire pile id>`. */
  onPick: (key: string) => void;
  /** Which lots carry the camera badge; Flag's rule (no Before yet) when left out. */
  badge?: (lot: FlagMapLot, status: LotStatus) => boolean;
  /** Bare parcels on the strip too (Flag), or only on the full-screen Paint map (Wrap up). */
  bareOnStrip?: boolean;
  /** The picked lot's Before spot (Wrap up). */
  spot?: MapSpot | null;
  /** What the strip centres on instead of the phone, while set. */
  centre?: LatLng | null;
  /** Tire piles (Wrap up, SPEC 29): `badge` while the pile has no photo, `picked` in yellow; a tap picks `t:<id>`. */
  tires?: ReadonlyArray<LatLng & { id: number; badge: boolean; picked: boolean }>;
  label?: string;
}
// #endregion

/** The heading cone: 30 m ahead (the ray's reach), 40 degrees wide. */
const cone = (at: LatLng, heading: number): L.LatLngTuple[] => {
  const pt = (deg: number, m: number): L.LatLngTuple => [at.lat + (Math.cos(deg * RAD) * m) / 111_320, at.lng + (Math.sin(deg * RAD) * m) / (111_320 * Math.cos(at.lat * RAD))];
  return [[at.lat, at.lng], pt(heading - 20, 30), pt(heading + 20, 30)];
};

const finitePoint = (p: LatLng): boolean => Number.isFinite(p.lat) && Number.isFinite(p.lng);

/**
 * The Flag screen's map (SPEC 22, map strip): north-up at zoom 18 on the
 * phone, the green map's lot, parcel, rectangle and CC layers, the heading
 * cone and the picked parcel in yellow. The strip follows the phone, takes no
 * pan or zoom gestures, and a tap on a parcel picks it. Full screen is Paint:
 * it centres on the phone once, then holds still under the strokes.
 */
export const FlagMap = ({ lots, parcels, alleys, plan, cc, fix, heading, picked, pending, expanded, onMap, onPick, badge = needsBefore, bareOnStrip = true, spot = null, centre = null, tires, label = "Flag map" }: Props) => {
  const [map, setMapState] = useState<L.Map | null>(null);
  const mapRef = useRef(onMap);
  mapRef.current = onMap;
  const setMap = useCallback((m: L.Map | null): void => {
    setMapState(m);
    mapRef.current(m);
  }, []);
  const tapPicks = !expanded;
  const tapPicksRef = useRef(tapPicks);
  tapPicksRef.current = tapPicks;
  const pickRef = useRef(onPick);
  pickRef.current = onPick;

  // #region layers
  const markers = useMemo<MapMarker[]>(() => {
    const out: MapMarker[] = lots.map((l) => ({
      id: `lot-${l.id}`,
      kind: "lot",
      lat: l.lat,
      lng: l.lng,
      status: pending.get(`l:${l.id}`) ?? l.status,
      geometry: l.geometry,
      parcelId: l.parcelId,
      mine: true,
      noFit: true,
      title: l.address ?? undefined,
      onClick: tapPicks ? () => pickRef.current(`l:${l.id}`) : undefined,
    }));
    // Camera badge: the lots still waiting for their photo of this round.
    for (const l of lots) {
      const status = pending.get(`l:${l.id}`) ?? l.status;
      if (!badge(l, status)) continue;
      out.push({ id: `cam-${l.id}`, kind: "camera", lat: l.lat, lng: l.lng, noFit: true, title: l.address ?? undefined, onClick: tapPicks ? () => pickRef.current(`l:${l.id}`) : undefined });
    }
    if (cc) out.push({ id: "cc", kind: "cc", lat: cc.lat, lng: cc.lng, name: `CC ${cc.name}`, letter: cc.letter, noFit: true });
    for (const t of tires ?? []) {
      out.push({ id: `tire-${t.id}`, kind: "tire", lat: t.lat, lng: t.lng, badge: t.badge, picked: t.picked, noFit: true, title: "Tire pile", onClick: tapPicks ? () => pickRef.current(`t:${t.id}`) : undefined });
    }
    if (fix) out.push({ id: "me", kind: "me", lat: fix.lat, lng: fix.lng, accuracy: fix.accuracy, noFit: true });
    return out;
  }, [lots, cc, fix, pending, tapPicks, badge, tires]);

  const onBare = useCallback((parcelId: string) => {
    if (tapPicksRef.current) pickRef.current(`p:${parcelId}`);
  }, []);
  useParcelLayer(map, parcels, bareOnStrip || expanded, onBare, pending, expanded);
  // OSM alleys as dashed centrelines, always on, as on the green map.
  useOsmAlleys(map, true);
  // Rectangle names take no tap on this map.
  useDayOfLayer(map, plan, true, undefined);

  // Alley halves with no lot: an unseen 16 px wide line along each, so a tap on the dashed
  // centreline in the strip picks the half. Under the lots (400), over the parcels.
  useEffect(() => {
    if (!map || !alleys || alleys.length === 0 || !tapPicks) return;
    const pane = map.getPane(ALLEY_HIT_PANE) ?? map.createPane(ALLEY_HIT_PANE);
    pane.style.zIndex = "395";
    const renderer = L.svg({ pane: ALLEY_HIT_PANE });
    const group = L.layerGroup().addTo(map);
    for (const a of alleys) {
      const hit = L.polyline(a.line.map(([lat, lng]): L.LatLngTuple => [lat, lng]), { renderer, pane: ALLEY_HIT_PANE, weight: 16, opacity: 0, className: "lrb-flag-alley-hit" });
      hit.on("click", (e) => {
        L.DomEvent.stop(e);
        if (tapPicksRef.current) pickRef.current(a.key);
      });
      group.addLayer(hit);
      hit.getElement()?.setAttribute("data-flag-alley", a.key);
    }
    return () => {
      group.remove();
    };
  }, [map, alleys, tapPicks]);

  // Cone and yellow outline in their own pane over the lots (400) and rectangles (405).
  const overlay = useRef<{ group: L.LayerGroup; renderer: L.Renderer } | null>(null);
  useEffect(() => {
    if (!map) return;
    const pane = map.getPane(PICK_PANE) ?? map.createPane(PICK_PANE);
    pane.style.zIndex = "410";
    pane.style.pointerEvents = "none";
    const renderer = L.svg({ pane: PICK_PANE });
    const group = L.layerGroup().addTo(map);
    overlay.current = { group, renderer };
    return () => {
      group.remove();
      overlay.current = null;
    };
  }, [map]);
  useEffect(() => {
    const o = overlay.current;
    if (!o) return;
    o.group.clearLayers();
    if (fix && heading !== null && Number.isFinite(heading) && finitePoint(fix)) {
      o.group.addLayer(L.polygon(cone(fix, heading), { renderer: o.renderer, pane: PICK_PANE, className: "lrb-flag-cone", weight: 1, interactive: false }));
    }
    if (spot && finitePoint(spot)) {
      if (spot.heading !== null && Number.isFinite(spot.heading)) {
        const c = L.polygon(cone(spot, spot.heading), { renderer: o.renderer, pane: PICK_PANE, className: "lrb-wrap-spot-cone", weight: 1, interactive: false });
        o.group.addLayer(c);
        c.getElement()?.setAttribute("data-spot-cone", "");
      }
      const pin = L.circleMarker([spot.lat, spot.lng], { renderer: o.renderer, pane: PICK_PANE, className: "lrb-wrap-spot", radius: 7, interactive: false });
      o.group.addLayer(pin);
      pin.getElement()?.setAttribute("data-spot-pin", "");
    }
    if (picked?.geometry) {
      const shape = L.geoJSON(picked.geometry, { pane: PICK_PANE, style: () => ({ className: "lrb-flag-pick", weight: 4, fill: false, interactive: false }) });
      o.group.addLayer(shape);
      shape.eachLayer((l) => {
        if (l instanceof L.Path) l.getElement()?.setAttribute("data-flag-pick", picked.key);
      });
    }
  }, [map, fix, heading, picked, spot]);
  // #endregion

  // #region view
  // The strip takes no gestures; the full-screen map pans and zooms (Paint takes one-finger drags).
  useEffect(() => {
    if (!map) return;
    const handlers = [map.dragging, map.touchZoom, map.doubleClickZoom, map.scrollWheelZoom, map.boxZoom, map.keyboard];
    for (const h of handlers) {
      if (expanded) h.enable();
      else h.disable();
    }
  }, [map, expanded]);

  // The strip stays centred on the phone (or the CC before the first fix). Expanding centres once
  // at zoom 18 (again when the first fix arrives after it), then the map holds still so a stroke
  // never lands on a map that moved.
  const at = centre ?? fix ?? cc;
  const atLat = at?.lat;
  const atLng = at?.lng;
  const atRef = useRef(at);
  atRef.current = at;
  useEffect(() => {
    if (!map || expanded || atLat === undefined || atLng === undefined) return;
    map.setView([atLat, atLng], FLAG_MAP_ZOOM, { animate: false });
  }, [map, atLat, atLng, expanded]);
  const hasFix = fix !== null;
  useEffect(() => {
    const p = atRef.current;
    if (!map || !expanded || !p) return;
    map.invalidateSize({ animate: false });
    map.setView([p.lat, p.lng], FLAG_MAP_ZOOM, { animate: false });
  }, [map, expanded, hasFix]);
  // #endregion

  return (
    <div className={`absolute inset-0 ${expanded ? "" : "[&_.leaflet-control-zoom]:hidden"}`} data-flag-map={expanded ? "full" : "strip"}>
      <MapView markers={markers} fitKey="flag" label={label} className="absolute inset-0" onReady={setMap} />
    </div>
  );
};
