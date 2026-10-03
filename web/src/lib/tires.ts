import { useCallback, useState } from "react";
import type { RouterOutputs } from "./trpc.ts";

/** One tire pile as `tires.list` returns it (SPEC 29). */
export type TirePile = RouterOutputs["tires"]["list"][number];

/** The pile's photo; `photoAt` versions the URL, so a new photo is never served from the old cache entry. */
export const tirePhotoUrl = (p: Pick<TirePile, "id" | "photoAt">, thumb = false): string => `/tire-photos/${p.id}${thumb ? "/thumb" : ""}?v=${p.photoAt ?? 0}`;

/** The pile being placed (Tire pile) or moved (Move): a draggable pin, a tap on the map moves it. */
export type TirePlacing = { mode: "add" | "move"; id: number | null; lat: number; lng: number };

/** Placing state for a map: start at a point, move with a tap or a drag, end with Save or Cancel. */
export const useTirePlacing = () => {
  const [placing, setPlacing] = useState<TirePlacing | null>(null);
  const startAdd = useCallback((at: { lat: number; lng: number }) => setPlacing({ mode: "add", id: null, lat: at.lat, lng: at.lng }), []);
  const startMove = useCallback((p: Pick<TirePile, "id" | "lat" | "lng">) => setPlacing({ mode: "move", id: p.id, lat: p.lat, lng: p.lng }), []);
  const moveTo = useCallback((lat: number, lng: number) => setPlacing((cur) => (cur ? { ...cur, lat, lng } : cur)), []);
  const cancel = useCallback(() => setPlacing(null), []);
  return { placing, startAdd, startMove, moveTo, cancel };
};
