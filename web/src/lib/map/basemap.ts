/**
 * Basemap constants copied from reference/basemap.ts (the practice-field map's
 * working setup). Two traps it records:
 *
 * - The host is `server.arcgisonline.com`, not `services.arcgisonline.com`.
 * - Esri's canvas tiles are only native to zoom 16. `maxZoom: 16` blanks the
 *   map past that; `maxNativeZoom: 16` with a higher `maxZoom` upscales.
 *
 * CARTO's keyless dark_all stamps "API KEY REQUIRED" on every tile, so dark
 * mode uses Esri's Dark Gray Canvas on the same host.
 */
export const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas";
export const ESRI_BASE = `${ESRI}/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}`;
export const ESRI_LABELS = `${ESRI}/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}`;
export const ESRI_DARK_BASE = `${ESRI}/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}`;
export const ESRI_DARK_LABELS = `${ESRI}/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}`;
export const TILE_ATTRIB = "&copy; OpenStreetMap contributors, &copy; Esri";
export const MAX_NATIVE_ZOOM = 16;
export const MAX_ZOOM = 20;

/** Detroit east side, for a map with nothing on it yet. */
export const DEFAULT_CENTER: [number, number] = [42.3745, -83.005];
export const DEFAULT_ZOOM = 14;
