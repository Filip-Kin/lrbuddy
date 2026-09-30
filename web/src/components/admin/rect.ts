import { useCallback, useMemo, useState } from "react";
import type { MapLine, MapMarker } from "../../lib/map/MapView.tsx";

export interface LatLng {
  lat: number;
  lng: number;
}

/** [west, south, east, north], the order the server's bbox inputs take. */
export type BBox = [number, number, number, number];

export const bboxOf = (a: LatLng, b: LatLng): BBox => [Math.min(a.lng, b.lng), Math.min(a.lat, b.lat), Math.max(a.lng, b.lng), Math.max(a.lat, b.lat)];

export const inBBox = (p: LatLng, b: BBox): boolean => p.lng >= b[0] && p.lng <= b[2] && p.lat >= b[1] && p.lat <= b[3];

/** Width and height of a bbox in metres, for the "too large" check and the label. */
export const bboxSize = (b: BBox): { w: number; h: number } => {
  const midLat = ((b[1] + b[3]) / 2) * (Math.PI / 180);
  return { w: (b[2] - b[0]) * 111_320 * Math.cos(midLat), h: (b[3] - b[1]) * 110_574 };
};

/** "1.2 x 0.8 km". */
export const bboxText = (b: BBox): string => {
  const { w, h } = bboxSize(b);
  const f = (m: number): string => (m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`);
  return `${f(w)} x ${f(h)}`;
};

/**
 * Two-tap rectangle on a MapView: the first tap drops corner 1, the second
 * closes the rectangle. A third tap starts over. Works the same with a finger
 * and a mouse, and never fights the map's own drag to pan.
 */
export const useRectDraw = () => {
  const [a, setA] = useState<LatLng | null>(null);
  const [b, setB] = useState<LatLng | null>(null);

  const tap = useCallback(
    (lat: number, lng: number): BBox | null => {
      if (!a || b) {
        setA({ lat, lng });
        setB(null);
        return null;
      }
      const next = { lat, lng };
      setB(next);
      return bboxOf(a, next);
    },
    [a, b],
  );

  const reset = useCallback(() => {
    setA(null);
    setB(null);
  }, []);

  const bbox = a && b ? bboxOf(a, b) : null;

  const lines = useMemo<MapLine[]>(() => {
    if (!bbox) return [];
    const [w, s, e, n] = bbox;
    return [{ id: "rect", points: [[s, w], [n, w], [n, e], [s, e], [s, w]], style: "select" }];
  }, [bbox]);

  const markers = useMemo<MapMarker[]>(() => (a && !b ? [{ id: "rect-a", kind: "stop", n: 1, active: true, lat: a.lat, lng: a.lng, noFit: true }] : []), [a, b]);

  return { corner: a, bbox, tap, reset, lines, markers, step: !a ? 1 : !b ? 2 : 3 };
};
