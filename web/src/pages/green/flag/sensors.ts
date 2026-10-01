import { useCallback, useEffect, useRef, useState } from "react";
import { finite, geolocation } from "../../../lib/safe.ts";

// #region camera
export type CameraState = "starting" | "on" | "denied" | "none";

/**
 * The rear camera on a <video>, or why there is none. Stops the tracks on
 * unmount. `paused` freezes the preview and turns the tracks off (the Flag
 * screen's full-screen map) without asking for the camera again.
 */
export const useCamera = (paused = false) => {
  const video = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const [state, setState] = useState<CameraState>("starting");
  useEffect(() => {
    let stream: MediaStream | null = null;
    let gone = false;
    const media = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
    if (!media?.getUserMedia) {
      setState("none");
      return;
    }
    media
      .getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1600 } }, audio: false })
      .then((s) => {
        if (gone) {
          for (const t of s.getTracks()) t.stop();
          return;
        }
        stream = s;
        streamRef.current = s;
        for (const t of s.getVideoTracks()) t.enabled = !pausedRef.current;
        const v = video.current;
        if (v) {
          v.srcObject = s;
          if (!pausedRef.current) void v.play().catch(() => undefined);
        }
        setState("on");
      })
      .catch((e: unknown) => {
        const name = typeof e === "object" && e !== null && "name" in e ? String((e as { name: unknown }).name) : "";
        setState(name === "NotAllowedError" || name === "SecurityError" ? "denied" : "none");
      });
    return () => {
      gone = true;
      streamRef.current = null;
      if (stream) for (const t of stream.getTracks()) t.stop();
    };
  }, []);
  useEffect(() => {
    const s = streamRef.current;
    if (s) for (const t of s.getVideoTracks()) t.enabled = !paused;
    const v = video.current;
    if (!v || !v.srcObject) return;
    if (paused) v.pause();
    else void v.play().catch(() => undefined);
  }, [paused, state]);
  return { video, state };
};
// #endregion

// #region location
export type FixState = "waiting" | "on" | "denied" | "none";

export interface Fix {
  lat: number;
  lng: number;
  accuracy: number | null;
  /** GPS course, only meaningful while moving. */
  heading: number | null;
  speed: number | null;
}

/** High-accuracy GPS while the screen is open. */
export const useFix = () => {
  const [fix, setFix] = useState<Fix | null>(null);
  const [state, setState] = useState<FixState>("waiting");
  useEffect(() => {
    const geo = geolocation();
    if (!geo) {
      setState("none");
      return;
    }
    const id = geo.watchPosition(
      (p) => {
        const lat = finite(p.coords.latitude);
        const lng = finite(p.coords.longitude);
        if (lat === null || lng === null) return;
        setFix({ lat, lng, accuracy: finite(p.coords.accuracy), heading: finite(p.coords.heading), speed: finite(p.coords.speed) });
        setState("on");
      },
      (e) => setState(e.code === e.PERMISSION_DENIED ? "denied" : "none"),
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 20_000 },
    );
    return () => geo.clearWatch(id);
  }, []);
  return { fix, state };
};
// #endregion

// #region compass
/** iOS Safari's extra on the orientation event: degrees clockwise from north. */
const webkitHeading = (e: DeviceOrientationEvent): number | null => {
  const v: unknown = (e as unknown as Record<string, unknown>).webkitCompassHeading;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
};

/** `DeviceOrientationEvent.requestPermission`, which only iOS has, or null. */
const permissionAsker = (): (() => Promise<string>) | null => {
  if (typeof window === "undefined" || !("DeviceOrientationEvent" in window)) return null;
  const fn: unknown = (DeviceOrientationEvent as unknown as Record<string, unknown>).requestPermission;
  return typeof fn === "function" ? () => (fn as () => Promise<string>).call(DeviceOrientationEvent) : null;
};

/**
 * Compass heading, degrees clockwise from north, from `deviceorientationabsolute`
 * (Android) or `webkitCompassHeading` (iOS, after the permission prompt). Null
 * until the phone reports one. `ask` must run from a tap on iOS.
 */
export const useCompass = () => {
  const [heading, setHeading] = useState<number | null>(null);
  const [needsAsk, setNeedsAsk] = useState(() => permissionAsker() !== null);
  const [denied, setDenied] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || needsAsk) return;
    const fromAlpha = (alpha: number | null): number | null => {
      const a = finite(alpha);
      return a === null ? null : (((360 - a) % 360) + 360) % 360;
    };
    const onAbsolute = (e: DeviceOrientationEvent): void => {
      const h = fromAlpha(e.alpha);
      if (h !== null) setHeading(h);
    };
    const onRelative = (e: DeviceOrientationEvent): void => {
      const h = webkitHeading(e) ?? (e.absolute ? fromAlpha(e.alpha) : null);
      if (h !== null) setHeading(h);
    };
    window.addEventListener("deviceorientationabsolute", onAbsolute as EventListener);
    window.addEventListener("deviceorientation", onRelative);
    return () => {
      window.removeEventListener("deviceorientationabsolute", onAbsolute as EventListener);
      window.removeEventListener("deviceorientation", onRelative);
    };
  }, [needsAsk]);

  const ask = useCallback(async (): Promise<void> => {
    const fn = permissionAsker();
    if (!fn) {
      setNeedsAsk(false);
      return;
    }
    try {
      const r = await fn();
      if (r === "granted") setNeedsAsk(false);
      else setDenied(true);
    } catch {
      setDenied(true);
    }
  }, []);

  return { heading, needsAsk, denied, ask };
};
// #endregion
