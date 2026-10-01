import L from "leaflet";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LotGeometry } from "../../../../../server/db/schema.ts";
import { useDayOfLayer, type DayOfPlan } from "../../../components/green/dayOfLayer.ts";
import type { LotStatus } from "../../../lib/lotStatus.ts";
import { MapView, type MapMarker } from "../../../lib/map/MapView.tsx";
import { useParcelLayer, type BareParcel } from "../../../lib/map/parcelLayer.ts";
import type { LatLng } from "./pick.ts";

/** The strip and the full-screen map both sit at street level (SPEC 22, map strip). */
export const FLAG_MAP_ZOOM = 18;
const PICK_PANE = "lrb-flag-pick";
const RAD = Math.PI / 180;

// #region types
export interface FlagMapLot extends LatLng {
  id: number;
  status: LotStatus;
  geometry: LotGeometry | null;
  parcelId: string | null;
  crewId: number | null;
  address: string | null;
}

interface Props {
  lots: readonly FlagMapLot[];
  parcels: readonly BareParcel[] | undefined;
  plan: Pick<DayOfPlan, "areas"> | undefined;
  cc: (LatLng & { name: string; letter: string | null }) | null;
  fix: (LatLng & { accuracy: number | null }) | null;
  heading: number | null;
  /** The picked parcel's outline, drawn in yellow. */
  picked: { key: string; geometry: LotGeometry | null } | null;
  /** Statuses of flags still on their way to the server, keyed `l:<lot id>` or `p:<parcel id>`. */
  pending: ReadonlyMap<string, LotStatus>;
  expanded: boolean;
  /** Paint mode on the full-screen map: taps pick nothing, the map stops following, bare parcels draw at any zoom. */
  painting: boolean;
  /** The Leaflet map once it exists, for Paint's stroke handling. */
  onMap: (map: L.Map | null) => void;
  /** A tap on a parcel in the full-screen map: `l:<lot id>` or `p:<parcel id>`. */
  onPick: (key: string) => void;
}
// #endregion

/** The heading cone: 30 m ahead (the ray's reach), 40 degrees wide. */
const cone = (at: LatLng, heading: number): L.LatLngTuple[] => {
  const pt = (deg: number, m: number): L.LatLngTuple => [at.lat + (Math.cos(deg * RAD) * m) / 111_320, at.lng + (Math.sin(deg * RAD) * m) / (111_320 * Math.cos(at.lat * RAD))];
  return [[at.lat, at.lng], pt(heading - 20, 30), pt(heading + 20, 30)];
};

/**
 * The Flag screen's map (SPEC 22, map strip): north-up at zoom 18 on the
 * phone, the green map's lot, parcel, rectangle and CC layers, the heading
 * cone and the picked parcel in yellow. In the strip it follows the phone and
 * takes no gestures; full screen it pans and zooms, follows until touched, and
 * a tap on a parcel picks it.
 */
export const FlagMap = ({ lots, parcels, plan, cc, fix, heading, picked, pending, expanded, painting, onMap, onPick }: Props) => {
  const [map, setMapState] = useState<L.Map | null>(null);
  const mapRef = useRef(onMap);
  mapRef.current = onMap;
  const setMap = useCallback((m: L.Map | null): void => {
    setMapState(m);
    mapRef.current(m);
  }, []);
  const holder = useRef<HTMLDivElement>(null);
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const tapPicks = expanded && !painting;
  const tapPicksRef = useRef(tapPicks);
  tapPicksRef.current = tapPicks;
  const pickRef = useRef(onPick);
  pickRef.current = onPick;
  const touched = useRef(false);

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
    if (cc) out.push({ id: "cc", kind: "cc", lat: cc.lat, lng: cc.lng, name: `CC ${cc.name}`, letter: cc.letter, noFit: true });
    if (fix) out.push({ id: "me", kind: "me", lat: fix.lat, lng: fix.lng, accuracy: fix.accuracy, noFit: true });
    return out;
  }, [lots, cc, fix, pending, tapPicks]);

  const onBare = useCallback((parcelId: string) => {
    if (tapPicksRef.current) pickRef.current(`p:${parcelId}`);
  }, []);
  useParcelLayer(map, parcels, true, onBare, pending, painting);
  const noArea = useCallback(() => undefined, []);
  useDayOfLayer(map, plan, true, noArea);

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
    if (fix && heading !== null && Number.isFinite(heading) && Number.isFinite(fix.lat) && Number.isFinite(fix.lng)) {
      o.group.addLayer(L.polygon(cone(fix, heading), { renderer: o.renderer, pane: PICK_PANE, className: "lrb-flag-cone", weight: 1, interactive: false }));
    }
    if (picked?.geometry) {
      const shape = L.geoJSON(picked.geometry, { pane: PICK_PANE, style: () => ({ className: "lrb-flag-pick", weight: 4, fill: false, interactive: false }) });
      o.group.addLayer(shape);
      shape.eachLayer((l) => {
        if (l instanceof L.Path) l.getElement()?.setAttribute("data-flag-pick", picked.key);
      });
    }
  }, [map, fix, heading, picked]);
  // #endregion

  // #region view
  // The strip takes no gestures; the full-screen map pans and zooms.
  useEffect(() => {
    if (!map) return;
    const handlers = [map.dragging, map.touchZoom, map.doubleClickZoom, map.scrollWheelZoom, map.boxZoom, map.keyboard];
    for (const h of handlers) {
      if (expanded) h.enable();
      else h.disable();
    }
    touched.current = false;
  }, [map, expanded]);

  useEffect(() => {
    const el = holder.current;
    if (!el) return;
    const touch = (): void => {
      if (expandedRef.current) touched.current = true;
    };
    for (const ev of ["pointerdown", "wheel"] as const) el.addEventListener(ev, touch, { passive: true });
    return () => {
      for (const ev of ["pointerdown", "wheel"] as const) el.removeEventListener(ev, touch);
    };
  }, []);

  // Centred on the phone (or the CC before the first fix), following it until the full-screen map is touched.
  // Paint holds the view still, so a stroke never lands on a map that moved under the finger.
  const at = fix ?? cc;
  const atLat = at?.lat;
  const atLng = at?.lng;
  useEffect(() => {
    if (!map || atLat === undefined || atLng === undefined || touched.current || painting) return;
    map.setView([atLat, atLng], FLAG_MAP_ZOOM, { animate: false });
  }, [map, atLat, atLng, expanded, painting]);
  // #endregion

  return (
    <div ref={holder} className={`absolute inset-0 ${expanded ? "" : "[&_.leaflet-control-zoom]:hidden"}`} data-flag-map={expanded ? "full" : "strip"}>
      <MapView markers={markers} fitKey="flag" label="Flag map" className="absolute inset-0" onReady={setMap} />
    </div>
  );
};
