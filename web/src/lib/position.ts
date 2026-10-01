import { useEffect, useSyncExternalStore } from "react";
import { api } from "./trpc.ts";
import { geolocation } from "./safe.ts";

export type LocationStatus = "off" | "waiting" | "on" | "denied" | "unavailable";

const MIN_MOVE_M = 15;
const MAX_GAP_MS = 30_000;
// Trucks are watched live by greens and crews: post more often than a crew on foot.
const TRUCK_MIN_MOVE_M = 8;
const TRUCK_MAX_GAP_MS = 5_000;

// #region store
let status: LocationStatus = "off";
let last: { lat: number; lng: number; accuracy: number | null; at: number } | null = null;
const listeners = new Set<() => void>();
const emit = (): void => listeners.forEach((l) => l());
const setStatus = (s: LocationStatus): void => {
  if (s !== status) {
    status = s;
    emit();
  }
};
const snapshot = { get: (): LocationStatus => status };

export const useLocationStatus = (): LocationStatus =>
  useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    snapshot.get,
    snapshot.get,
  );

export interface DeviceFix {
  lat: number;
  lng: number;
  accuracy: number | null;
  /** Degrees clockwise from north, as the GPS reports it; null when standing still or unknown. */
  heading: number | null;
  /** Metres per second; null when unknown. */
  speed: number | null;
  at: number;
}

let lastFix: DeviceFix | null = null;
/** Latest fix from this device outside React, for stamping a photo. Null for roles that do not report. */
export const currentFix = (): { lat: number; lng: number } | null => lastFix;

/** Latest fix from this device, for drawing the blue dot without a round trip. */
export const useMyFix = () =>
  useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => lastFix,
    () => lastFix,
  );
// #endregion

const distM = (a: { lat: number; lng: number }, b: { lat: number; lng: number }): number => {
  const r = (d: number) => (d * Math.PI) / 180;
  const dLat = r(b.lat - a.lat);
  const dLng = r(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(h)));
};

/**
 * Watches the device position while the page is visible and posts it to
 * `shared.position` after 15 m of movement or 30 s, whichever comes first.
 * Crew and driver only; pass `enabled=false` for other roles.
 */
export const usePositionReporter = (enabled: boolean, truck = false): void => {
  const minMove = truck ? TRUCK_MIN_MOVE_M : MIN_MOVE_M;
  const maxGap = truck ? TRUCK_MAX_GAP_MS : MAX_GAP_MS;
  useEffect(() => {
    if (!enabled) return;
    const geo = geolocation();
    if (!geo) {
      setStatus("unavailable");
      return;
    }
    let watchId: number | null = null;
    let pending: GeolocationPosition | null = null;
    let sending = false;

    const send = async (pos: GeolocationPosition): Promise<void> => {
      if (sending) {
        pending = pos;
        return;
      }
      sending = true;
      const c = pos.coords;
      try {
        await api.shared.position.mutate({
          lat: c.latitude,
          lng: c.longitude,
          accuracy: Number.isFinite(c.accuracy) ? c.accuracy : null,
          heading: c.heading !== null && Number.isFinite(c.heading) ? c.heading : null,
          speed: c.speed !== null && Number.isFinite(c.speed) ? c.speed : null,
        });
        last = { lat: c.latitude, lng: c.longitude, accuracy: c.accuracy, at: Date.now() };
      } catch {
        // Next fix tries again.
      } finally {
        sending = false;
        const next = pending;
        pending = null;
        if (next) void send(next);
      }
    };

    const onFix = (pos: GeolocationPosition): void => {
      setStatus("on");
      const c = pos.coords;
      lastFix = {
        lat: c.latitude,
        lng: c.longitude,
        accuracy: c.accuracy,
        heading: c.heading !== null && Number.isFinite(c.heading) ? c.heading : null,
        speed: c.speed !== null && Number.isFinite(c.speed) ? c.speed : null,
        at: pos.timestamp || Date.now(),
      };
      emit();
      const here = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      if (!last || distM(last, here) >= minMove || Date.now() - last.at >= maxGap) void send(pos);
    };

    const onError = (err: GeolocationPositionError): void => {
      setStatus(err.code === err.PERMISSION_DENIED ? "denied" : "unavailable");
    };

    const start = (): void => {
      if (watchId !== null) return;
      setStatus(status === "on" ? "on" : "waiting");
      watchId = geo.watchPosition(onFix, onError, { enableHighAccuracy: true, maximumAge: 0, timeout: 30_000 });
    };
    const stop = (): void => {
      if (watchId !== null) geo.clearWatch(watchId);
      watchId = null;
    };

    // watchPosition only fires on movement; a stationary crew still posts every 30 s.
    const heartbeat = window.setInterval(() => {
      if (document.visibilityState !== "visible" || watchId === null) return;
      geo.getCurrentPosition(onFix, () => undefined, { maximumAge: 20_000, timeout: 20_000 });
    }, maxGap);

    const onVisibility = (): void => {
      if (document.visibilityState === "visible") start();
      else stop();
    };
    document.addEventListener("visibilitychange", onVisibility);
    if (document.visibilityState === "visible") start();

    // A watch that failed with PERMISSION_DENIED never fires again; restart it when the permission is granted.
    let perm: PermissionStatus | null = null;
    const onPermChange = (): void => {
      if (perm?.state !== "granted" || document.visibilityState !== "visible") return;
      stop();
      start();
    };
    let disposed = false;
    navigator.permissions
      ?.query({ name: "geolocation" })
      .then((p) => {
        if (disposed) return;
        perm = p;
        p.addEventListener("change", onPermChange);
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      perm?.removeEventListener("change", onPermChange);
      document.removeEventListener("visibilitychange", onVisibility);
      window.clearInterval(heartbeat);
      stop();
    };
  }, [enabled]);
};

export type LocationPermission = "granted" | "prompt" | "denied" | "unknown";

/** Browser permission for geolocation, for the settings Location row. iOS re-asks often. */
export const locationPermission = async (): Promise<LocationPermission> => {
  try {
    const p = await navigator.permissions.query({ name: "geolocation" });
    return p.state;
  } catch {
    return "unknown";
  }
};

/** Location row labels. Web apps only get GPS while open. */
export const LOCATION_LABELS: Record<LocationStatus, string> = {
  on: "On while open",
  waiting: "Waiting for GPS",
  off: "Off",
  denied: "Blocked in browser settings",
  unavailable: "Not available",
};
