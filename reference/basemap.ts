import L from "leaflet";
import { useEffect, useRef } from "react";
import type { StoreView } from "./api.ts";
import { flag, fmtDate } from "./util.ts";

/**
 * Same basemap the practice-field map uses, which is the one that actually
 * works in a browser. Two things matter and both bit this map first time round:
 *
 * - The host is `server.arcgisonline.com`, not `services.arcgisonline.com`.
 * - Esri's canvas tiles are only native to zoom 16. Setting `maxZoom: 16` makes
 *   the map go blank past that; `maxNativeZoom: 16` with a higher `maxZoom`
 *   upscales instead, so it stays usable at street level.
 *
 * CARTO's keyless dark_all is not an option any more: it still returns 200 but
 * stamps "API KEY REQUIRED" across every tile.
 */
const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas";
const ESRI_BASE = `${ESRI}/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}`;
const ESRI_LABELS = `${ESRI}/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}`;
const TILE_ATTRIB = "&copy; OpenStreetMap contributors, &copy; Esri &middot; stores from OpenStreetMap";

/**
 * A canvas renderer hit-tests against the drawn radius, so a 3.5 px dot is a
 * 3.5 px tap target, which is nothing on a phone. Dots grow as you zoom in,
 * where there is room for them, and stay small at world zoom where 559 of them
 * would otherwise merge into a smear.
 */
const radiusFor = (zoom: number, been: boolean): number => {
  const base = zoom >= 11 ? 9 : zoom >= 8 ? 7 : zoom >= 5 ? 5.5 : 4;
  return been ? base + 3 : base;
};

/** Opens the Google Maps app on a phone and the site on a desktop. */
const mapsUrl = (lat: number, lon: number): string =>
  `https://www.google.com/maps/search/?api=1&query=${lat},${lon}`;

export const MapView = ({ stores }: { stores: readonly StoreView[] }): JSX.Element => {
  const holder = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const pins = useRef<L.LayerGroup | null>(null);
  const dots = useRef<Array<{ marker: L.CircleMarker; been: boolean }>>([]);

  useEffect(() => {
    if (!holder.current || map.current) return;
    map.current = L.map(holder.current, {
      worldCopyJump: true,
      minZoom: 2,
      maxZoom: 20,
    }).setView([25, 5], 2);

    L.tileLayer(ESRI_BASE, { maxNativeZoom: 16, maxZoom: 20, attribution: TILE_ATTRIB }).addTo(map.current);
    L.tileLayer(ESRI_LABELS, { maxNativeZoom: 16, maxZoom: 20 }).addTo(map.current);

    pins.current = L.layerGroup().addTo(map.current);

    const resize = (): void => {
      const zoom = map.current?.getZoom() ?? 2;
      for (const { marker, been } of dots.current) marker.setRadius(radiusFor(zoom, been));
    };
    map.current.on("zoomend", resize);

    return () => {
      map.current?.remove();
      map.current = null;
      dots.current = [];
    };
  }, []);

  useEffect(() => {
    if (!pins.current) return;
    pins.current.clearLayers();
    dots.current = [];
    const renderer = L.canvas({ padding: 0.4 });
    const zoom = map.current?.getZoom() ?? 2;

    // Unvisited first so the yellow ones always draw on top.
    const ordered = [...stores].sort((a, b) => Number(a.visits > 0) - Number(b.visits > 0));

    for (const s of ordered) {
      const been = s.visits > 0;
      const marker = L.circleMarker([s.lat, s.lon], {
        renderer,
        radius: radiusFor(zoom, been),
        weight: been ? 2.5 : 1,
        color: been ? "#0058a3" : "#8ea3b8",
        fillColor: been ? "#ffdb00" : "#ffffff",
        fillOpacity: 1,
      });

      // Two gaps to paper over: an element with no addr:* tags that the reverse
      // geocoder could not place either, which falls back to the city, and the
      // common case of a postcode with no city name, which reads oddly alone.
      // The link uses the real coordinates either way, so it is right even when
      // the text is vague.
      const town = [s.city, s.country].filter(Boolean).join(", ");
      const where = !s.address
        ? town
        : s.city && !s.address.includes(s.city)
          ? `${s.address}, ${s.city}`
          : s.address;
      const visitLine = been
        ? `<span class="m">${s.visits} visit${s.visits === 1 ? "" : "s"} &middot; last ${fmtDate(s.lastVisit ?? 0)}</span>`
        : `<span class="m">Not been yet</span>`;

      marker.bindPopup(
        [
          `<b>${flag(s.cc)} ${escapeHtml(s.label)}</b>`,
          where
            ? `<a class="addr" href="${mapsUrl(s.lat, s.lon)}" target="_blank" rel="noopener noreferrer">${escapeHtml(where)}</a>`
            : "",
          visitLine,
        ]
          .filter(Boolean)
          .join(""),
      );
      marker.addTo(pins.current);
      dots.current.push({ marker, been });
    }
  }, [stores]);

  return <div id="map" ref={holder} />;
};

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
