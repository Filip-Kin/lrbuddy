import { errorText } from "../../lib/errors.ts";
import { useEffect, useRef, useState } from "react";
import { useMyFix } from "../../lib/position.ts";
import { trpc, type RouterOutputs } from "../../lib/trpc.ts";

export type DriverQueue = RouterOutputs["driver"]["queue"];
export type QueueStop = DriverQueue["stops"][number];
export type StockRow = RouterOutputs["driver"]["stock"][number];

/** A stop assigned this recently carries a New pill. Matches the server's NEW_STOP_MS. */
export const NEW_STOP_MS = 3 * 60_000;

// #region clock
/** Re-renders every `ms` so relative times and ETAs stay current. */
export const useNow = (ms = 30_000): number => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(t);
  }, [ms]);
  return now;
};
// #endregion

// #region distance from this phone
const distM = (a: { lat: number; lng: number }, b: { lat: number; lng: number }): number => {
  const r = (d: number) => (d * Math.PI) / 180;
  const dLat = r(b.lat - a.lat);
  const dLng = r(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(h)));
};

/** Straight-line metres from this phone's latest fix, else the server's figure. */
export const useDistanceFrom = (): ((p: { lat: number; lng: number }, fallback: number) => number) => {
  const fix = useMyFix();
  return (p, fallback) => (fix ? distM(fix, p) : fallback);
};
// #endregion

// #region screen on
const WAKE_KEY = "lrb.driver.wake";

export const wakePreference = (): boolean => window.localStorage.getItem(WAKE_KEY) !== "off";
export const setWakePreference = (on: boolean): void => {
  window.localStorage.setItem(WAKE_KEY, on ? "on" : "off");
  window.dispatchEvent(new Event("lrb-wake"));
};

interface WakeLockSentinelLike {
  release: () => Promise<void>;
  addEventListener: (type: "release", fn: () => void) => void;
}
type WakeNavigator = Navigator & { wakeLock?: { request: (type: "screen") => Promise<WakeLockSentinelLike> } };

/**
 * Keeps a truck-mounted phone awake while a driver page is open. The browser
 * drops the lock when the page is hidden, so it is taken again on return.
 */
export const useWakeLock = (): void => {
  useEffect(() => {
    const nav = navigator as WakeNavigator;
    if (!nav.wakeLock) return;
    let lock: WakeLockSentinelLike | null = null;
    let cancelled = false;
    const acquire = async (): Promise<void> => {
      if (cancelled || lock || document.visibilityState !== "visible" || !wakePreference()) return;
      try {
        lock = await nav.wakeLock!.request("screen");
        lock.addEventListener("release", () => {
          lock = null;
        });
      } catch {
        lock = null;
      }
    };
    const release = (): void => {
      void lock?.release().catch(() => undefined);
      lock = null;
    };
    const onPref = (): void => {
      if (wakePreference()) void acquire();
      else release();
    };
    const onVisible = (): void => {
      if (document.visibilityState === "visible") void acquire();
    };
    void acquire();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("lrb-wake", onPref);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("lrb-wake", onPref);
      release();
    };
  }, []);
};
// #endregion

// #region new stop buzz
/** Buzzes the phone when a stop appears that was not in the previous queue. */
export const useNewStopBuzz = (stops: readonly QueueStop[] | undefined): void => {
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!stops) return;
    const keys = new Set(stops.map((s) => s.key));
    const prev = seen.current;
    seen.current = keys;
    if (!prev) return;
    const added = [...keys].some((k) => !prev.has(k));
    if (added && "vibrate" in navigator) navigator.vibrate([180, 90, 180]);
  }, [stops]);
};
// #endregion

// #region actions
const messageOf = (err: unknown): string => errorText(err, "Not saved. Try again.");

/** Driver mutations. Each returns the fresh queue, which replaces the cached one at once. */
export const useDriverActions = () => {
  const utils = trpc.useUtils();
  const [error, setError] = useState<string | null>(null);
  const apply = (q: DriverQueue): void => {
    utils.driver.queue.setData(undefined, q);
    void utils.driver.route.invalidate();
    void utils.driver.stock.invalidate();
  };
  const common = {
    onMutate: () => setError(null),
    onSuccess: apply,
    onError: (err: unknown) => {
      setError(messageOf(err));
      void utils.driver.queue.invalidate();
    },
  };
  const enRoute = trpc.driver.enRoute.useMutation(common);
  const deliver = trpc.driver.deliver.useMutation({
    ...common,
    onSuccess: (q) => {
      apply(q);
      if ("vibrate" in navigator) navigator.vibrate(60);
    },
  });
  const cancel = trpc.driver.cancel.useMutation(common);
  const setReturning = trpc.driver.setReturning.useMutation(common);
  const restocked = trpc.driver.restocked.useMutation(common);
  return { enRoute, deliver, cancel, setReturning, restocked, error, clearError: () => setError(null) };
};

export type DriverActions = ReturnType<typeof useDriverActions>;
// #endregion
