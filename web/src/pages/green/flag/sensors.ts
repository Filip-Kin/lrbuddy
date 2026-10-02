import { useCallback, useEffect, useRef, useState } from "react";
import { finite, geolocation, storageGet, storageSet } from "../../../lib/safe.ts";
import { cameraBearing, circularMean, norm360 } from "./bearing.ts";
import { wideCameraId, zoomRangeOf, type Lens } from "./lens.ts";

// #region camera
export type CameraState = "starting" | "on" | "denied" | "none";

/** The lens choice for the session (SPEC 22). */
const LENS_KEY = "lrb.flag.lens";
const BACK: MediaTrackConstraints = { facingMode: { ideal: "environment" }, width: { ideal: 1600 } };

/** How this phone reaches its wide lens: a zoom below 1 on the open camera, or another camera. */
type LensWay = { kind: "zoom"; wide: number; normal: number } | { kind: "device"; wideId: string; normalId: string | null };

const stopAll = (s: MediaStream | null): void => {
  if (s) for (const t of s.getTracks()) t.stop();
};

const errorName = (e: unknown): string => (typeof e === "object" && e !== null && "name" in e ? String((e as { name: unknown }).name) : "");

/**
 * The rear camera on a <video>, or why there is none. Stops the tracks on
 * unmount. `paused` freezes the preview and turns the tracks off (the Flag
 * screen's full-screen map) without asking for the camera again. When the
 * phone has a wide lens it starts on it (unless Normal was chosen this
 * session) and `canSwitch` is true.
 */
export const useCamera = (paused = false) => {
  const video = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const [state, setState] = useState<CameraState>("starting");
  const [lens, setLensState] = useState<Lens>(() => (storageGet("session", LENS_KEY) === "normal" ? "normal" : "wide"));
  const lensRef = useRef(lens);
  const [way, setWay] = useState<LensWay | null>(null);
  const wayRef = useRef<LensWay | null>(null);
  const gone = useRef(false);
  /** Bumped by every lens change, so an older camera opening late is dropped. */
  const turn = useRef(0);

  const use = useCallback((s: MediaStream): void => {
    if (streamRef.current !== s) stopAll(streamRef.current);
    streamRef.current = s;
    for (const t of s.getVideoTracks()) t.enabled = !pausedRef.current;
    const v = video.current;
    if (v) {
      v.srcObject = s;
      if (!pausedRef.current) void v.play().catch(() => undefined);
    }
  }, []);

  const apply = useCallback(
    async (w: LensWay, l: Lens): Promise<void> => {
      const mine = ++turn.current;
      if (w.kind === "zoom") {
        const track = streamRef.current?.getVideoTracks()[0];
        if (!track) return;
        const zoom = l === "wide" ? w.wide : w.normal;
        await track.applyConstraints({ advanced: [{ zoom } as unknown as MediaTrackConstraintSet] }).catch(() => undefined);
        return;
      }
      const media = navigator.mediaDevices;
      const id = l === "wide" ? w.wideId : w.normalId;
      const want: MediaTrackConstraints = id ? { deviceId: { exact: id }, width: { ideal: 1600 } } : BACK;
      // Some phones open one camera at a time: the old one stops first.
      stopAll(streamRef.current);
      streamRef.current = null;
      let s: MediaStream;
      try {
        s = await media.getUserMedia({ video: want, audio: false });
      } catch {
        s = await media.getUserMedia({ video: BACK, audio: false }).catch(() => new MediaStream());
      }
      if (gone.current || mine !== turn.current) {
        stopAll(s);
        return;
      }
      use(s);
    },
    [use],
  );

  useEffect(() => {
    gone.current = false;
    const media = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
    if (!media?.getUserMedia) {
      setState("none");
      return;
    }
    const run = async (): Promise<void> => {
      let s: MediaStream;
      try {
        s = await media.getUserMedia({ video: BACK, audio: false });
      } catch (e) {
        const name = errorName(e);
        setState(name === "NotAllowedError" || name === "SecurityError" ? "denied" : "none");
        return;
      }
      if (gone.current) {
        stopAll(s);
        return;
      }
      use(s);
      setState("on");
      const track = s.getVideoTracks()[0];
      let caps: unknown = null;
      try {
        caps = track && typeof track.getCapabilities === "function" ? track.getCapabilities() : null;
      } catch {
        caps = null;
      }
      const z = zoomRangeOf(caps);
      let w: LensWay | null = null;
      if (z && z.min < 1) {
        w = { kind: "zoom", wide: z.min, normal: Math.min(Math.max(1, z.min), z.max) };
      } else if (typeof media.enumerateDevices === "function") {
        const list = await media.enumerateDevices().catch((): MediaDeviceInfo[] => []);
        const currentId = track?.getSettings().deviceId ?? null;
        const wideId = wideCameraId(list, currentId);
        if (wideId) w = { kind: "device", wideId, normalId: currentId };
      }
      if (gone.current) return;
      wayRef.current = w;
      setWay(w);
      if (w && lensRef.current === "wide") await apply(w, "wide");
    };
    void run();
    return () => {
      gone.current = true;
      stopAll(streamRef.current);
      streamRef.current = null;
    };
  }, [use, apply]);

  useEffect(() => {
    const s = streamRef.current;
    if (s) for (const t of s.getVideoTracks()) t.enabled = !paused;
    const v = video.current;
    if (!v || !v.srcObject) return;
    if (paused) v.pause();
    else void v.play().catch(() => undefined);
  }, [paused, state]);

  const setLens = useCallback(
    (l: Lens): void => {
      if (l === lensRef.current) return;
      lensRef.current = l;
      setLensState(l);
      storageSet("session", LENS_KEY, l);
      const w = wayRef.current;
      if (w) void apply(w, l);
    },
    [apply],
  );

  return { video, state, lens, canSwitch: way !== null, setLens };
};
// #endregion

// #region location
export type FixState = "waiting" | "on" | "denied" | "none";

export interface Fix {
  lat: number;
  lng: number;
  accuracy: number | null;
}

/** High-accuracy GPS while the screen is open. Position only: the GPS course never stands in for the compass (SPEC 22). */
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
        setFix({ lat, lng, accuracy: finite(p.coords.accuracy) });
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
/** Readings averaged into one heading (SPEC 22). */
export const SMOOTH_MS = 300;
/** Fastest the heading reaches React. */
const PUBLISH_MS = 100;

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

const screenAngle = (): number => {
  try {
    return finite(screen.orientation?.angle) ?? 0;
  } catch {
    return 0;
  }
};

/**
 * Bearing of the back camera, degrees clockwise from north, from the phone's
 * orientation (`cameraBearing`): `deviceorientationabsolute` on Android, or
 * `deviceorientation` with `webkitCompassHeading` on iOS after the permission
 * prompt (`ask`, from a tap). Circular mean of the last 300 ms. Null until
 * the phone reports one; never from the GPS course.
 */
export const useCompass = () => {
  const [heading, setHeading] = useState<number | null>(null);
  const [needsAsk, setNeedsAsk] = useState(() => permissionAsker() !== null);
  const [denied, setDenied] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || needsAsk) return;
    const samples: Array<{ t: number; h: number }> = [];
    let published = 0;
    let absolute = false;
    let trailing: number | null = null;
    const publish = (): void => {
      trailing = null;
      published = performance.now();
      while (samples.length > 0 && published - samples[0]!.t > SMOOTH_MS) samples.shift();
      const mean = circularMean(samples.map((x) => x.h));
      if (mean !== null) setHeading(norm360(Math.round(mean)));
    };
    const push = (h: number | null): void => {
      if (h === null) return;
      const t = performance.now();
      samples.push({ t, h });
      while (samples.length > 0 && t - samples[0]!.t > SMOOTH_MS) samples.shift();
      if (t - published >= PUBLISH_MS) publish();
      else if (trailing === null) trailing = window.setTimeout(publish, PUBLISH_MS - (t - published));
    };
    const onAbsolute = (e: DeviceOrientationEvent): void => {
      absolute = true;
      push(cameraBearing(finite(e.alpha), finite(e.beta), finite(e.gamma), screenAngle()));
    };
    const onRelative = (e: DeviceOrientationEvent): void => {
      if (absolute) return;
      // iOS: alpha has no fixed zero, webkitCompassHeading does; 360 minus it is alpha referenced to north.
      const wk = webkitHeading(e);
      if (wk !== null) push(cameraBearing(360 - wk, finite(e.beta), finite(e.gamma), screenAngle()));
      else if (e.absolute) push(cameraBearing(finite(e.alpha), finite(e.beta), finite(e.gamma), screenAngle()));
    };
    window.addEventListener("deviceorientationabsolute", onAbsolute as EventListener);
    window.addEventListener("deviceorientation", onRelative);
    return () => {
      if (trailing !== null) window.clearTimeout(trailing);
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
