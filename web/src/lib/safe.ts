/**
 * Browser features that a phone may lack or refuse, read without throwing. Each of these crashed
 * a screen when it was missing (Flag screen sweep, 2026-10-01): storage blocked by the browser's
 * privacy settings, `matchMedia` absent or without `addEventListener` (Safari before 14), no
 * `navigator.geolocation`, and a compass or GPS reporting NaN.
 */

// #region storage
type Kind = "local" | "session";

const area = (kind: Kind): Storage | null => {
  try {
    if (typeof window === "undefined") return null;
    return kind === "local" ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
};

export const storageGet = (kind: Kind, key: string): string | null => {
  try {
    return area(kind)?.getItem(key) ?? null;
  } catch {
    return null;
  }
};

/** Null removes the key. Quota or a blocked store: nothing is kept, nothing throws. */
export const storageSet = (kind: Kind, key: string, value: string | null): void => {
  try {
    const s = area(kind);
    if (!s) return;
    if (value === null) s.removeItem(key);
    else s.setItem(key, value);
  } catch {
    // Not kept.
  }
};

export const storageClear = (kind: Kind): void => {
  try {
    area(kind)?.clear();
  } catch {
    // Nothing to clear.
  }
};
// #endregion

// #region media queries
export interface MediaWatch {
  matches: () => boolean;
  subscribe: (cb: () => void) => () => void;
}

/** A media query that answers false and never changes where `matchMedia` is missing. */
export const media = (query: string): MediaWatch => {
  let mql: MediaQueryList | null = null;
  try {
    mql = typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(query) : null;
  } catch {
    mql = null;
  }
  return {
    matches: () => mql?.matches ?? false,
    subscribe: (cb) => {
      if (!mql) return () => undefined;
      if (typeof mql.addEventListener === "function") {
        mql.addEventListener("change", cb);
        return () => mql?.removeEventListener("change", cb);
      }
      // Safari before 14.
      if (typeof mql.addListener === "function") {
        mql.addListener(cb);
        return () => mql?.removeListener(cb);
      }
      return () => undefined;
    },
  };
};

export const mediaMatches = (query: string): boolean => media(query).matches();
// #endregion

// #region sensors
/** `navigator.geolocation`, or null where the browser has none (or hides it). */
export const geolocation = (): Geolocation | null => {
  try {
    return typeof navigator !== "undefined" && navigator.geolocation ? navigator.geolocation : null;
  } catch {
    return null;
  }
};

/** A number from a sensor, or null when it is null, NaN or infinite. */
export const finite = (v: number | null | undefined): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
// #endregion
