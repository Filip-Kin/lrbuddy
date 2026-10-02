/**
 * The basemap every interactive map draws: Esri canvas base and labels, and on
 * the green, driver and crew maps the World Street Map over them from zoom 16.5.
 *
 * Two Leaflet traps this avoids (field report 2026-10-02, "the map is gone and
 * it's just the data layers"):
 *
 * - A tile layer picks its tiles by the ROUNDED zoom but prunes them by the RAW
 *   zoom. With the canvas at `maxZoom: 16` and the streets at `minZoom: 17`, any
 *   zoom strictly between 16 and 17 (16.5 is a zoomSnap step, and fitBounds and
 *   the driver map land anywhere) pruned the canvas and never loaded the
 *   streets: no basemap at all. So the canvas stays on at every zoom, upscaled
 *   past its native 16, and the streets sit on top from 16.5, the first zoom whose
 *   tiles round to 17. The streets are opaque, so the canvas labels under them
 *   never double up.
 * - On a phone Leaflet loads tiles only when a gesture ends (`updateWhenIdle`),
 *   so a pinch out showed bare background around the old view until release.
 *   `updateWhenIdle: false` loads them during the gesture, throttled to 200 ms.
 */
import L from "leaflet";
import {
  ESRI_BASE,
  ESRI_DARK_BASE,
  ESRI_DARK_LABELS,
  ESRI_LABELS,
  ESRI_STREETS,
  MAX_NATIVE_ZOOM,
  MAX_ZOOM,
  STREETS_MAX_NATIVE_ZOOM,
  STREETS_MIN_ZOOM,
  TILE_ATTRIB,
} from "./basemap.ts";
import "./liveRedraw.ts";

/** Leaflet rounds the zoom to pick tiles, so from here the street layer already shows its zoom 17 tiles. */
export const STREETS_FROM_ZOOM = STREETS_MIN_ZOOM - 0.5;

export interface BasemapOptions {
  dark: boolean;
  /** World Street Map over the canvas from zoom 16.5. Off for the plan maps, which stay on the canvas. */
  streets?: boolean;
}

/** The basemap tile layers, bottom first, not yet on a map. */
export const basemapLayers = ({ dark, streets = true }: BasemapOptions): L.TileLayer[] => {
  const common: L.TileLayerOptions = { updateWhenIdle: false };
  const canvas: L.TileLayerOptions = { ...common, maxNativeZoom: MAX_NATIVE_ZOOM, maxZoom: MAX_ZOOM };
  const layers = [
    L.tileLayer(dark ? ESRI_DARK_BASE : ESRI_BASE, { ...canvas, attribution: TILE_ATTRIB, zIndex: 1 }),
    L.tileLayer(dark ? ESRI_DARK_LABELS : ESRI_LABELS, { ...canvas, zIndex: 2 }),
  ];
  if (streets) {
    layers.push(
      L.tileLayer(ESRI_STREETS, {
        ...common,
        minZoom: STREETS_FROM_ZOOM,
        maxNativeZoom: STREETS_MAX_NATIVE_ZOOM,
        maxZoom: MAX_ZOOM,
        zIndex: 3,
        className: dark ? "tiles-dark-street" : "",
      }),
    );
  }
  return layers;
};

/** Adds the basemap to the map and returns its layers, for removing them when the colour scheme changes. */
export const addBasemap = (map: L.Map, opts: BasemapOptions): L.TileLayer[] => basemapLayers(opts).map((l) => l.addTo(map));
