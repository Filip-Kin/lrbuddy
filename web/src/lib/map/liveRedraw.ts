/**
 * Vector layers that keep up with a pinch or a drag (field report 2026-10-02:
 * "things not rendering right until you release your fingers").
 *
 * Leaflet draws each SVG or canvas renderer over the view plus `padding` and
 * redraws it only when the gesture ends (moveend). During a pinch it scales
 * that drawing with a CSS transform, so a pinch out showed every lot, parcel
 * and rectangle clipped to the old view's rectangle, while the one-way arrows
 * (markers, repositioned every frame) carried on past its edge.
 *
 * This hook, on every map, remembers the area each renderer last drew, and on
 * each `move` of a gesture redraws a renderer whose area no longer holds the
 * view: the paths are projected at the current zoom (what Leaflet does at
 * zoomend) and clipped to the current view (what it does at moveend). A redraw
 * costs one projection of every path, so it runs only when the edge comes into
 * view, not every frame: the padding below sets how far a gesture goes between
 * two redraws.
 *
 * Imported once by basemapLayers.ts, which every interactive map uses.
 */
import L from "leaflet";

/**
 * View sizes drawn on each side of the view. Leaflet's 0.1 meant a redraw every sixth of a zoom
 * level on a pinch out; 0.5 holds a whole zoom level out, or half a screen of drag, per redraw.
 */
export const RENDER_PADDING = 0.5;

/** The Leaflet internals this needs (leaflet/src/layer/vector/Renderer.js, 1.9). */
interface RendererInternals {
  _bounds?: L.Bounds;
  _zoom?: number;
  /** Projects every path at the map's current zoom. */
  _onZoomEnd(): void;
  /** Sets the drawn area to the current view plus padding, places the container, fires `update` (paths re-clip). */
  _update(): void;
}
interface MapInternals {
  _animatingZoom?: boolean;
}

const internals = (r: L.Renderer): RendererInternals => r as unknown as RendererInternals;

L.Renderer.mergeOptions({ padding: RENDER_PADDING });

L.Map.addInitHook(function (this: L.Map) {
  const map = this;
  const drawn = new WeakMap<L.Renderer, L.LatLngBounds>();

  const record = (r: L.Renderer): void => {
    const b = internals(r)._bounds;
    if (!b?.min || !b.max) return;
    drawn.set(r, L.latLngBounds(map.layerPointToLatLng(b.min), map.layerPointToLatLng(b.max)));
  };
  const onUpdate = (e: L.LeafletEvent): void => {
    if (e.target instanceof L.Renderer) record(e.target);
  };

  map.on("layeradd", (e: L.LayerEvent) => {
    if (!(e.layer instanceof L.Renderer)) return;
    // The renderer drew once in onAdd, before this event: take that area now, then every redraw's.
    record(e.layer);
    e.layer.on("update", onUpdate);
  });
  map.on("layerremove", (e: L.LayerEvent) => {
    if (e.layer instanceof L.Renderer) e.layer.off("update", onUpdate);
  });

  // `move` comes after `zoom` in each frame of a pinch, so Leaflet has already scaled the renderers;
  // a redraw here replaces that scaled drawing in the same frame.
  map.on("move", () => {
    if ((map as unknown as MapInternals)._animatingZoom) return;
    const view = map.getBounds();
    map.eachLayer((layer) => {
      if (!(layer instanceof L.Renderer)) return;
      const area = drawn.get(layer);
      if (!area || area.contains(view)) return;
      const r = internals(layer);
      if (r._zoom !== map.getZoom()) r._onZoomEnd();
      r._update();
    });
  });
});
