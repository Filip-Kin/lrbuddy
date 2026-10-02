import L from "leaflet";

/**
 * Leaflet 1.9 internals that hold work scheduled to run after `remove()`. Not in @types/leaflet;
 * named here so the cast below is to a known shape rather than to anything.
 */
interface PendingWork {
  /** True from the start of a zoom animation until its transition ends. */
  _animatingZoom?: boolean;
  scrollWheelZoom?: { _timer?: ReturnType<typeof setTimeout> };
  touchZoom?: { _animRequest?: number };
}

/**
 * Removes a Leaflet map without leaving work behind that runs on the removed map.
 *
 * Leaflet's own `remove()` deletes the map pane but leaves three callbacks queued that read it:
 * the 250 ms `_onZoomTransitionEnd` fallback of every animated zoom (the zoom buttons, the first
 * fit, a wheel step), the wheel handler's debounce timer and a pinch's frame request. Any of them
 * firing after `remove()` throws `Cannot read properties of undefined (reading '_leaflet_pos')`,
 * which reached Client errors whenever someone tapped a nav link within about 200 ms of a zoom
 * (tests/e2e/FOUND.md, FOUND-1). So: stop pans and flights, mark the zoom animation finished so
 * the fallback returns at once, clear the two handler timers, remove, and then drop every
 * listener so a late Leaflet event (the `moveend` of a debounced resize, the `zoomstart` of a
 * zoom whose frame was already queued) reaches no code of ours.
 */
export const removeMap = (m: L.Map): void => {
  m.stop();
  const p = m as unknown as PendingWork;
  p._animatingZoom = false;
  const wheel = p.scrollWheelZoom?._timer;
  if (wheel !== undefined) clearTimeout(wheel);
  const pinch = p.touchZoom?._animRequest;
  if (pinch !== undefined) L.Util.cancelAnimFrame(pinch);
  m.remove();
  m.off();
};
