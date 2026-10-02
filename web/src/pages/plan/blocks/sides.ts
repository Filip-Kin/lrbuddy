import L from "leaflet";
import { useEffect, useRef, useState } from "react";
import { useAreaNames } from "../../../lib/map/areaNames.ts";
import { attachLabelDeclutter } from "../../../lib/map/declutter.ts";
import { hatchLines } from "../../../lib/map/hatch.ts";
import type { RouterOutputs } from "../../../lib/trpc.ts";

export type Side = RouterOutputs["plan"]["blocks"]["list"][number];
export type SideShape = RouterOutputs["plan"]["blocks"]["shapes"][number];
export type Band = Side["band"];

// #region labels
/** "E CANFIELD ST" to "E Canfield St". */
export const titleCase = (s: string): string => s.toLowerCase().replace(/(^|[\s-])([a-z])/g, (_m, a: string, b: string) => a + b.toUpperCase());

export const BAND_LABEL: Record<Band, string> = { none: "0", light: "1 to 4", mid: "5 to 9", dark: "10+" };

export const parityLabel = (p: Side["parity"]): string => (p === "odd" ? "Odd" : "Even");

/** "Ford 2, Day 1", or the company alone before crews exist. */
export const assignedLabel = (a: Side["assignment"], withDay = true): string | null => {
  if (!a) return null;
  const who = a.crewName ?? a.companyName ?? `CC ${a.ccName}`;
  return withDay ? `${who}, ${a.dayLabel}` : who;
};
// #endregion

// #region styles
/** Swatch classes for legends, matching the map. */
export const SWATCH: Record<Band | "here" | "away" | "sel" | "done" | "dnt", string> = {
  none: "bg-muted/25 ring-1 ring-inset ring-muted",
  light: "bg-crew/25 ring-1 ring-inset ring-crew",
  mid: "bg-crew/60 ring-1 ring-inset ring-crew",
  dark: "bg-[color-mix(in_srgb,var(--crew)_55%,#000)]",
  here: "bg-brand-green/50 ring-1 ring-inset ring-brand-green",
  away: "bg-muted/10 ring-1 ring-inset ring-muted",
  sel: "bg-brand ring-2 ring-inset ring-ink",
  done: "bg-brand-green/75 ring-1 ring-inset ring-brand-green",
  dnt: "bg-warn/45 ring-1 ring-inset ring-warn",
};
// #endregion

// #region layers
export interface DrawnSide {
  key: string;
  ring: SideShape["ring"];
  /** Extra classes after `lrb-side`: a band, `here`, `away`, plus `focus` or `sel`. */
  classes: string;
}

export interface SideClick {
  key: string;
  /** Shift, Ctrl or Cmd held: add or remove instead of replacing. */
  toggle: boolean;
}

/**
 * Block side outlines on a Leaflet map, redrawn when `sides` changes.
 * `onClick` is skipped (and the click passes to the map) while `passive`,
 * so a drawing tool can take the clicks.
 */
export const useSidesLayer = (map: L.Map | null, sides: readonly DrawnSide[], onClick: (c: SideClick) => void, passive = false): void => {
  const group = useRef<L.LayerGroup | null>(null);
  const click = useRef(onClick);
  click.current = onClick;
  const quiet = useRef(passive);
  quiet.current = passive;

  useEffect(() => {
    if (!map) return;
    const g = L.layerGroup().addTo(map);
    group.current = g;
    return () => {
      g.remove();
      group.current = null;
    };
  }, [map]);

  useEffect(() => {
    const g = group.current;
    if (!g) return;
    g.clearLayers();
    for (const s of sides) {
      const poly = L.polygon(
        s.ring.slice(0, -1).map(([lng, lat]) => [lat, lng] as [number, number]),
        { className: `lrb-side ${s.classes}`, weight: 1.5, fillOpacity: 0.3 },
      );
      poly.on("click", (e: L.LeafletMouseEvent) => {
        if (quiet.current) return;
        L.DomEvent.stopPropagation(e);
        const ev = e.originalEvent;
        click.current({ key: s.key, toggle: ev.shiftKey || ev.ctrlKey || ev.metaKey });
      });
      g.addLayer(poly);
    }
  }, [map, sides]);
};

export interface DrawnArea {
  id: number;
  label: string;
  ring: ReadonlyArray<ReadonlyArray<number>>;
  /** Marked Do not touch in the field: drawn hatched. */
  doNotTouch?: boolean;
}

/** Crew areas as thin dashed outlines with the name small along the top edge (`useAreaNames`). Not clickable. */
export const useAreasLayer = (map: L.Map | null, areas: readonly DrawnArea[]): void => {
  const group = useRef<L.LayerGroup | null>(null);
  useEffect(() => {
    if (!map) return;
    const g = L.layerGroup().addTo(map);
    group.current = g;
    const detachLabels = attachLabelDeclutter(map);
    return () => {
      detachLabels();
      g.remove();
      group.current = null;
    };
  }, [map]);
  useEffect(() => {
    const g = group.current;
    if (!g) return;
    g.clearLayers();
    for (const a of areas) {
      const pts: Array<[number, number]> = [];
      for (const p of a.ring) if (p[0] !== undefined && p[1] !== undefined) pts.push([p[1], p[0]]);
      if (pts.length < 3) continue;
      const poly = L.polygon(pts, { className: `lrb-area${a.doNotTouch ? " lrb-area-dnt" : ""}`, interactive: false, fill: false });
      g.addLayer(poly);
      poly.getElement()?.setAttribute("data-area-id", String(a.id));
      if (a.doNotTouch) for (const seg of hatchLines(a.ring)) g.addLayer(L.polyline(seg, { className: "lrb-area-hatch", interactive: false }));
    }
  }, [map, areas]);
  useAreaNames(map, areas, { visible: true, tone: "plan" });
};

/** Fits the map to the points once per key (and again when the key changes). */
export const useFitOnce = (map: L.Map | null, key: string | null, points: ReadonlyArray<[number, number]>): void => {
  const done = useRef<string | null>(null);
  useEffect(() => {
    if (!map || key === null || done.current === key || points.length === 0) return;
    done.current = key;
    if (points.length === 1) map.setView(points[0]!, 16);
    else map.fitBounds(L.latLngBounds([...points]), { padding: [30, 30], maxZoom: 17 });
  }, [map, key, points]);
};
// #endregion

// #region capacity
export interface Capacity {
  /** Low work parcels one crew takes. */
  parcels: number;
  /** High work parcels one crew takes. */
  high: number;
}

const CAP_KEY = "lrb.plan.capacity";
export const DEFAULT_CAPACITY: Capacity = { parcels: 10, high: 5 };

const readCapacity = (): Capacity => {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(CAP_KEY) ?? "null");
    if (typeof raw === "object" && raw !== null && "parcels" in raw && "high" in raw) {
      const { parcels, high } = raw as { parcels: unknown; high: unknown };
      if (typeof parcels === "number" && typeof high === "number" && parcels >= 1 && high >= 1) return { parcels, high };
    }
  } catch {
    // A broken stored value falls back to the defaults.
  }
  return DEFAULT_CAPACITY;
};

/** Per-crew capacity, shared by Blocks and Assignments and kept in this browser. */
export const useCapacity = (): [Capacity, (c: Capacity) => void] => {
  const [cap, setCap] = useState<Capacity>(readCapacity);
  const set = (c: Capacity): void => {
    setCap(c);
    try {
      localStorage.setItem(CAP_KEY, JSON.stringify(c));
    } catch {
      // Private mode without storage still works for this visit.
    }
  };
  return [cap, set];
};

/** Crews a load of work needs at this capacity, as a fraction (2.4 crews). */
export const crewLoad = (high: number, low: number, cap: Capacity): number => low / Math.max(1, cap.parcels) + high / Math.max(1, cap.high);

/** "2.4" or "3". */
export const loadText = (n: number): string => (Number.isInteger(Math.round(n * 10) / 10) ? String(Math.round(n)) : (Math.round(n * 10) / 10).toFixed(1));
// #endregion
