import type { LatLngExpression } from "leaflet";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { LotGeometry } from "../../../../../server/db/schema.ts";

export type Grade = "high" | "low" | "clear";
export type Band = "none" | "light" | "mid" | "dark";

export const GRADE_LABEL: Record<Grade, string> = { high: "High", low: "Low", clear: "Clear" };
export const GRADES: readonly Grade[] = ["high", "low", "clear"];

// #region scheme
const darkQuery = typeof window !== "undefined" ? window.matchMedia("(prefers-color-scheme: dark)") : null;

export const usePrefersDark = (): boolean =>
  useSyncExternalStore(
    (cb) => {
      darkQuery?.addEventListener("change", cb);
      return () => darkQuery?.removeEventListener("change", cb);
    },
    () => darkQuery?.matches ?? false,
    () => false,
  );

export interface Palette {
  ink: string;
  brand: string;
  crew: string;
  warn: string;
  muted: string;
  line: string;
  surface: string;
}

const read = (): Palette => {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string): string => cs.getPropertyValue(name).trim() || fallback;
  return {
    ink: v("--ink", "#0e3038"),
    brand: v("--brand", "#fddd08"),
    crew: v("--crew", "#e5484d"),
    warn: v("--warn", "#e55b00"),
    muted: v("--muted", "#5b6b70"),
    line: v("--line", "#d1d3d4"),
    surface: v("--surface", "#ffffff"),
  };
};

/**
 * The palette from styles.css as literal colours. Canvas-drawn shapes cannot
 * use CSS classes, so the maps take colours from here and redraw on a scheme
 * change.
 */
export const usePalette = (): Palette => {
  const dark = usePrefersDark();
  const [p, setP] = useState<Palette>(read);
  useEffect(() => setP(read()), [dark]);
  return p;
};
// #endregion

// #region colours
/** High is crew red, low the warn orange, clear the muted grey; never surveyed is a thin outline. */
export const gradeColour = (p: Palette, g: Grade | null): string => (g === "high" ? p.crew : g === "low" ? p.warn : g === "clear" ? p.muted : p.line);

/** Block side outline by band: heavier and more opaque red as the work count climbs. */
export const bandStroke = (p: Palette, b: Band): { color: string; weight: number; opacity: number; dashArray?: string } =>
  b === "dark"
    ? { color: p.crew, weight: 4, opacity: 1 }
    : b === "mid"
      ? { color: p.crew, weight: 3, opacity: 0.75 }
      : b === "light"
        ? { color: p.crew, weight: 2, opacity: 0.45 }
        : { color: p.muted, weight: 1.5, opacity: 0.7, dashArray: "4 4" };
// #endregion

// #region geometry
/** GeoJSON outline to Leaflet's nested [lat, lng] arrays. */
export const toLatLngs = (g: LotGeometry): LatLngExpression[][] | LatLngExpression[][][] =>
  g.type === "Polygon"
    ? g.coordinates.map((ring) => ring.map((pt) => [pt[1] ?? 0, pt[0] ?? 0] as [number, number]))
    : g.coordinates.map((poly) => poly.map((ring) => ring.map((pt) => [pt[1] ?? 0, pt[0] ?? 0] as [number, number])));

/** "3961" from "3961 Garland St", for a label on a small parcel. */
export const houseNumber = (address: string | null): string | null => /^\s*(\d+[A-Z]?)\b/i.exec(address ?? "")?.[1] ?? null;
// #endregion
