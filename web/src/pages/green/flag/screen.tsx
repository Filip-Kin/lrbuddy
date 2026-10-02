import { useEffect, useRef, useState } from "react";
import type { BrushKey, PaintState } from "../../../components/PaintBar.tsx";
import { storageGet, storageSet } from "../../../lib/safe.ts";
import type { useCompass } from "./sensors.ts";

/**
 * Pieces the two camera screens share: the Flag screen (SPEC 22) and Wrap up (SPEC 28). Camera on
 * top, the map strip at the bottom, Expand to a full-screen Paint map.
 */

export const ExpandIcon = ({ up }: { up: boolean }) => (
  <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {up ? <path d="M6 15l6-6 6 6" /> : <path d="M6 9l6 6 6-6" />}
  </svg>
);

/** A clock tick, once a second: the pick is recomputed on it and the "ago" labels follow it. */
export const useNow = (): number => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  return now;
};

/** Full-screen map or strip, kept for the session under `key`. */
export const useExpanded = (key: string): [boolean, (on: boolean) => void] => {
  const [expanded, setExpanded] = useState(() => storageGet("session", key) === "full");
  const set = (on: boolean): void => {
    setExpanded(on);
    storageSet("session", key, on ? "full" : "strip");
  };
  return [expanded, set];
};

/** Paint follows the map: on (with `start` as the brush) when expanded, a reload too; off on Collapse. */
export const usePaintFollowsExpand = (paint: PaintState, expanded: boolean, start?: BrushKey): void => {
  const paintRef = useRef(paint);
  paintRef.current = paint;
  const startRef = useRef(start);
  startRef.current = start;
  useEffect(() => {
    const p = paintRef.current;
    if (expanded && !p.on) p.open(startRef.current);
    else if (!expanded && p.on) p.close();
  }, [expanded]);
};

/** iOS reads the compass only after a tap: one big button over the camera until then. */
export const CompassAsk = ({ compass }: { compass: ReturnType<typeof useCompass> }) =>
  compass.needsAsk && !compass.denied ? (
    <div className="absolute inset-0 z-[1002] grid place-items-center bg-black/55 p-6">
      <button
        type="button"
        onClick={() => void compass.ask()}
        className="min-h-16 w-full max-w-xs rounded-2xl bg-[#fddd08] px-6 text-xl font-extrabold text-[#0e3038] shadow-2xl ring-4 ring-white/80"
        data-flag-compass-ask
      >
        Turn on compass
      </button>
    </div>
  ) : null;
