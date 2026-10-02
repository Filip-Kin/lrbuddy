import type { Map as LeafletMap } from "leaflet";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PaintFrame, usePaint } from "../../../components/PaintBar.tsx";
import { useWakeLock } from "../../../components/driver/hooks.ts";
import { lotTitle } from "../../../lib/format.ts";
import type { PaintTarget } from "../../../lib/map/paintHit.ts";
import { STATUS_LABEL, type LotGrade, type LotStatus } from "../../../lib/lotStatus.ts";
import { FlagMap } from "./FlagMap.tsx";
import { FlagPaintBar } from "./FlagPaintBar.tsx";
import { postPhoto, useInvalidatePhotos } from "../../../lib/photos.ts";
import { trpc } from "../../../lib/trpc.ts";
import { compassPoint, pickParcel, type Candidate } from "./pick.ts";
import { LensSwitch } from "./LensSwitch.tsx";
import { grabFrame, useCamera, useCompass, useFix } from "./sensors.ts";
import { CompassAsk, ExpandIcon, useExpanded, useNow, usePaintFollowsExpand } from "./screen.tsx";

/** Undo stays on the last-flag card this long (SPEC 22). */
export const UNDO_MS = 20_000;
const RETRY_MS = [2000, 4000, 8000, 15_000] as const;
/** The map strip's state for the session (SPEC 22, map strip). */
const MAP_KEY = "lrb.flag.map";

// #region types
interface Target extends Candidate {
  lotId: number | null;
  parcelId: string | null;
  address: string | null;
  status: LotStatus | null;
  grade: LotGrade | null;
  crewName: string | null;
}

type FlagStatus = "open" | "do_not_touch";

interface Flag {
  id: number;
  target: Target;
  status: FlagStatus;
  photo: { photo: Blob; thumb: Blob } | null;
  /** Where the phone stood and which way the camera faced at the shot (SPEC 15). */
  shotFrom: { lat: number; lng: number } | null;
  shotHeading: number | null;
  at: number;
  phase: "queued" | "sending" | "done" | "failed" | "undone";
  /** Server answer once sent. */
  lotId: number | null;
  photoId: number | null;
  message: string | null;
  tries: number;
}
// #endregion

// #region helpers
/** Point in a [lng, lat] ring. */
const inRing = (lat: number, lng: number, ring: ReadonlyArray<readonly [number, number]>): boolean => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};

/** "0:12" since a time. */
const since = (at: number, now: number): string => {
  const s = Math.max(0, Math.floor((now - at) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

const isRefusal = (e: unknown): boolean => {
  if (typeof e !== "object" || e === null || !("data" in e)) return false;
  const d: unknown = (e as { data: unknown }).data;
  const code = typeof d === "object" && d !== null && "code" in d ? (d as { code: unknown }).code : null;
  return code === "FORBIDDEN" || code === "NOT_FOUND" || code === "BAD_REQUEST" || code === "UNAUTHORIZED";
};

/** The server refused the photo (too big, not a JPEG, signed out): the flag stops here with the reason. */
class PhotoRefused extends Error {}
// #endregion

/**
 * Flag screen (SPEC 22): the morning sweep with the camera. The phone's GPS
 * and the bearing of its back camera pick the parcel it faces, or a tap on the
 * strip map picks one; Todo takes the photo, saves it as the lot's Before and
 * marks the lot Todo with its rectangle's crew. Flags queue in memory and post
 * in order. The expanded map is Paint with the toggle brush.
 */
export const FlagPage = () => {
  const utils = trpc.useUtils();
  const refreshPhotos = useInvalidatePhotos();
  const overview = trpc.green.overview.useQuery(undefined, { refetchInterval: 60_000 });
  const parcels = trpc.green.parcels.useQuery(undefined, { refetchInterval: 120_000 });
  const plan = trpc.green.plan.useQuery(undefined, { refetchInterval: 120_000 });
  // Full-screen map: the camera pauses and the map is Paint. Kept for the session.
  const [expanded, setExpandedState] = useExpanded(MAP_KEY);
  const camera = useCamera(expanded);
  const { fix, state: fixState } = useFix();
  const compass = useCompass();
  useWakeLock(true);
  const now = useNow();

  // The back camera's bearing from the orientation sensors only; never the GPS course.
  const heading = compass.heading;

  // #region candidates
  const crewName = useMemo(() => new Map((overview.data?.crews ?? []).map((c) => [c.id, c.name])), [overview.data]);
  const areaName = useCallback(
    (lat: number, lng: number): string | null => plan.data?.areas.find((a) => inRing(lat, lng, a.ring))?.label ?? null,
    [plan.data],
  );
  const targets = useMemo<Target[]>(() => {
    const lots: Target[] = (overview.data?.lots ?? []).map((l) => ({
      key: `l:${l.id}`,
      lat: l.lat,
      lng: l.lng,
      geometry: l.geometry,
      drawn: l.source === "drawn",
      lotId: l.id,
      parcelId: l.parcelId,
      address: l.address,
      status: l.status,
      grade: l.grade,
      crewName: l.crewId !== null ? (crewName.get(l.crewId) ?? null) : areaName(l.lat, l.lng),
    }));
    const bare: Target[] = (parcels.data ?? []).map((p) => ({
      key: `p:${p.parcelId}`,
      lat: p.lat,
      lng: p.lng,
      geometry: p.geometry,
      lotId: null,
      parcelId: p.parcelId,
      address: p.address,
      status: null,
      grade: null,
      crewName: areaName(p.lat, p.lng),
    }));
    return [...lots, ...bare];
  }, [overview.data, parcels.data, crewName, areaName]);

  // Recomputed every second (the `now` tick) from the latest fix and heading.
  const aimed = useMemo(() => pickParcel(fix, heading, targets), [fix, heading, targets, now]);
  // A parcel tapped on the strip holds the pick (the ray pick pauses) until Clear, a second tap
  // on it, a flag, or Expand.
  const [tapped, setTapped] = useState<string | null>(null);
  const tappedTarget = tapped ? (targets.find((t) => t.key === tapped) ?? null) : null;
  const picked = !expanded && tappedTarget ? tappedTarget : aimed;
  const onStripPick = useCallback((key: string): void => setTapped((k) => (k === key ? null : key)), []);
  const setExpandedRaw = (on: boolean): void => {
    setExpandedState(on);
    setTapped(null);
  };
  // #endregion

  // #region queue
  const [flags, setFlags] = useState<Flag[]>([]);
  const flagsRef = useRef<Flag[]>([]);
  flagsRef.current = flags;
  const nextId = useRef(1);
  const busy = useRef(false);
  const timer = useRef<number | null>(null);

  const patch = useCallback((id: number, p: Partial<Flag>): void => {
    setFlags((list) => list.map((f) => (f.id === id ? { ...f, ...p } : f)));
    flagsRef.current = flagsRef.current.map((f) => (f.id === id ? { ...f, ...p } : f));
  }, []);

  const send = useCallback(async (f: Flag): Promise<void> => {
    patch(f.id, { phase: "sending" });
    try {
      let lotId = f.lotId;
      if (lotId === null) {
        const r = await utils.client.green.setLotStatus.mutate({ lotId: f.target.lotId, parcelId: f.target.lotId === null ? f.target.parcelId : null, status: f.status });
        lotId = r.lot?.id ?? null;
        patch(f.id, { lotId });
      }
      let photoId: number | null = null;
      if (f.photo && lotId !== null) {
        const form = new FormData();
        form.set("lotId", String(lotId));
        form.set("kind", "before");
        if (f.shotFrom) {
          form.set("lat", String(f.shotFrom.lat));
          form.set("lng", String(f.shotFrom.lng));
        }
        if (f.photo && f.shotHeading !== null) form.set("heading", String(f.shotHeading));
        form.set("photo", f.photo.photo, "photo.jpg");
        form.set("thumb", f.photo.thumb, "thumb.jpg");
        const r = await postPhoto(form, () => undefined);
        if (!r.ok) throw r.refused ? new PhotoRefused(r.message) : new Error(r.message);
        photoId = r.id;
      }
      patch(f.id, { phase: "done", photoId, photo: null, message: null });
      void utils.green.invalidate();
      refreshPhotos();
    } catch (e) {
      if (e instanceof PhotoRefused || isRefusal(e)) patch(f.id, { phase: "failed", message: e instanceof Error ? e.message : "Not saved" });
      else patch(f.id, { phase: "queued", tries: f.tries + 1, message: "No signal" });
    }
  }, [patch, utils, refreshPhotos]);

  const pump = useCallback(async (): Promise<void> => {
    if (busy.current) return;
    busy.current = true;
    try {
      for (;;) {
        const f = flagsRef.current.find((x) => x.phase === "queued");
        if (!f) break;
        await send(f);
        const after = flagsRef.current.find((x) => x.id === f.id);
        if (after?.phase === "queued") {
          // Still no signal: wait, then try the same flag again so the order holds.
          const wait = RETRY_MS[Math.min(after.tries - 1, RETRY_MS.length - 1)] ?? 15_000;
          timer.current = window.setTimeout(() => void pump(), wait);
          break;
        }
      }
    } finally {
      busy.current = false;
    }
  }, [send]);

  useEffect(() => {
    const online = (): void => void pump();
    window.addEventListener("online", online);
    // Leaving the screen does not drop flags still queued: the retry timer keeps running
    // until they post or the server refuses them. Only an empty queue stops it.
    return () => {
      window.removeEventListener("online", online);
      if (timer.current !== null && !flagsRef.current.some((f) => f.phase === "queued" || f.phase === "sending")) window.clearTimeout(timer.current);
    };
  }, [pump]);

  const { state: cameraState, video: cameraVideo } = camera;
  const grab = useCallback(() => grabFrame({ state: cameraState, video: cameraVideo }), [cameraState, cameraVideo]);

  // The phone's fix and the camera's heading at the press, read through refs so the shutter keeps one identity.
  const shotRef = useRef({ fix, heading });
  shotRef.current = { fix, heading };
  const flag = useCallback(
    async (target: Target, status: FlagStatus): Promise<void> => {
      const { fix: from, heading: facing } = shotRef.current;
      const photo = await grab();
      const f: Flag = {
        id: nextId.current++,
        target,
        status,
        photo,
        shotFrom: from ? { lat: from.lat, lng: from.lng } : null,
        shotHeading: facing,
        at: Date.now(),
        phase: "queued",
        lotId: null,
        photoId: null,
        message: null,
        tries: 0,
      };
      flagsRef.current = [...flagsRef.current, f];
      setFlags(flagsRef.current);
      setTapped(null);
      void pump();
    },
    [grab, pump],
  );

  const undo = useCallback(
    async (f: Flag): Promise<void> => {
      if (f.phase === "queued") {
        patch(f.id, { phase: "undone" });
        return;
      }
      if (f.phase !== "done" || f.lotId === null) return;
      patch(f.id, { phase: "undone" });
      try {
        if (f.photoId !== null) await utils.client.shared.deletePhoto.mutate({ id: f.photoId });
        const prev = f.target.status;
        if (prev === null) {
          // It was a bare parcel: back to Todo (Do not touch cannot go straight to a delete), then Not todo deletes the row.
          if (f.status !== "open") await utils.client.green.setLotStatus.mutate({ lotId: f.lotId, status: "open" });
          await utils.client.green.setLotStatus.mutate({ lotId: f.lotId, status: "not_todo" });
        } else {
          await utils.client.green.setLotStatus.mutate({ lotId: f.lotId, status: prev, grade: f.target.grade });
        }
      } catch (e) {
        patch(f.id, { phase: "done", message: e instanceof Error ? e.message : "Not undone" });
      }
      void utils.green.invalidate();
      refreshPhotos();
    },
    [patch, utils, refreshPhotos],
  );
  // #endregion

  // #region map
  // Flags not yet answered draw in their new status on the map straight away.
  const pending = useMemo(() => {
    const out = new Map<string, LotStatus>();
    for (const f of flags) if (f.phase === "queued" || f.phase === "sending") out.set(f.target.key, f.status);
    return out;
  }, [flags]);
  const mapLots = useMemo(() => overview.data?.lots ?? [], [overview.data]);

  // The expanded map is Paint (SPEC 22): the toggle brush, or Do not touch, on the same green.paint
  // batch and Undo history as the green map. Every lot and bare parcel at the CC is a target.
  const [leaflet, setLeaflet] = useState<LeafletMap | null>(null);
  const paintTargets = useMemo<PaintTarget[]>(() => {
    const out: PaintTarget[] = [];
    for (const l of mapLots) {
      out.push({ key: `l:${l.id}`, lotId: l.id, parcelId: l.parcelId, status: pending.get(`l:${l.id}`) ?? l.status, crewId: l.crewId, lat: l.lat, lng: l.lng, geometry: l.geometry });
    }
    for (const p of parcels.data ?? []) {
      out.push({ key: `p:${p.parcelId}`, lotId: null, parcelId: p.parcelId, status: pending.get(`p:${p.parcelId}`) ?? null, crewId: null, lat: p.lat, lng: p.lng, geometry: p.geometry });
    }
    return out;
  }, [mapLots, parcels.data, pending]);
  const paint = usePaint(leaflet, { kind: "green" }, paintTargets);
  const mapPending = useMemo(() => (paint.pending.size === 0 ? pending : new Map([...pending, ...paint.pending])), [pending, paint.pending]);
  // Paint follows the map: on with the toggle brush when expanded (a reload too), off on Collapse.
  usePaintFollowsExpand(paint, expanded, "toggle");
  const cc = useMemo(() => {
    const c = overview.data?.cc;
    return c ? { lat: c.lat, lng: c.lng, name: c.name, letter: c.letter } : null;
  }, [overview.data]);
  // #endregion

  const last = [...flags].reverse().find((f) => f.phase !== "undone") ?? null;
  const queued = flags.filter((f) => f.phase === "queued" || f.phase === "sending").length;
  const label = (t: Target): string => [lotTitle(t), t.status ? STATUS_LABEL[t.status] : STATUS_LABEL.not_todo, t.crewName].filter(Boolean).join(" · ");
  const canFlag = picked !== null;

  const top = (
    <div className={`z-[1001] flex items-start gap-2 ${expanded ? "relative shrink-0 px-3 py-3" : "absolute inset-x-3 top-3"}`}>
      <div className="min-w-0 flex-1 rounded-xl bg-black/65 px-3 py-2" data-flag-target>
        <p className="text-base leading-tight font-bold break-words">{picked ? label(picked) : "No parcel"}</p>
        <div className="mt-1 flex flex-wrap gap-1.5 text-xs font-semibold empty:hidden">
          {camera.state === "denied" && <span className="rounded-full bg-[#e55b00] px-2 py-0.5">No camera</span>}
          {camera.state === "none" && <span className="rounded-full bg-[#e55b00] px-2 py-0.5">No camera</span>}
          {(fixState === "denied" || fixState === "none") && <span className="rounded-full bg-[#e55b00] px-2 py-0.5">No location</span>}
          {fixState === "waiting" && <span className="rounded-full bg-white/20 px-2 py-0.5">Finding location</span>}
        </div>
      </div>
      {(!compass.needsAsk || compass.denied) && (
        <span className={`shrink-0 rounded-full px-3 py-2 text-sm font-bold ${heading === null ? "bg-[#e55b00]" : "bg-black/65"}`} data-flag-heading>
          {heading !== null ? `Facing ${compassPoint(heading)}` : compass.denied ? "Compass off" : "No compass"}
        </span>
      )}
    </div>
  );

  const lastCard = last && (
    <div className={`absolute inset-x-3 z-[1000] flex items-center gap-2 rounded-xl bg-black/70 py-1.5 pr-1.5 pl-3 ${expanded ? "bottom-6" : "bottom-3"}`} data-flag-last role="status" aria-live="polite">
      <p className="min-w-0 flex-1 text-sm leading-tight font-semibold break-words">
        {`Last: ${lotTitle(last.target)} · ${STATUS_LABEL[last.status]} · ${since(last.at, now)} ago`}
        {last.phase === "failed" && ` · ${last.message ?? "Not saved"}`}
        {last.phase === "queued" && last.message && ` · ${last.message}`}
      </p>
      {now - last.at < UNDO_MS && last.phase !== "failed" && (
        <button type="button" onClick={() => void undo(last)} className="min-h-11 shrink-0 rounded-lg bg-white px-4 text-sm font-bold text-[#0e3038]" data-flag-undo>
          Undo
        </button>
      )}
    </div>
  );

  return (
    <div className="relative flex h-full min-h-[480px] flex-col overflow-hidden bg-black text-white" data-flag data-flag-expanded={expanded ? "true" : "false"}>
      {top}

      {/* Camera: hidden, not unmounted, while the map is full screen, so it resumes without asking again. */}
      <div className={`relative min-h-0 flex-1 ${expanded ? "hidden" : ""}`} data-flag-camera>
        <video ref={camera.video} muted playsInline autoPlay className="absolute inset-0 h-full w-full object-cover" aria-label="Camera" />
        {camera.state !== "on" && <div aria-hidden="true" className="absolute inset-0 bg-[#0e3038]" />}
        {!expanded && lastCard}
        {!expanded && <CompassAsk compass={compass} />}
      </div>

      <div className={`relative isolate shrink-0 overflow-hidden border-t-2 border-black ${expanded ? "min-h-0 flex-1" : "h-[28%]"}`} data-flag-strip>
        <FlagMap
          lots={mapLots}
          parcels={parcels.data}
          plan={plan.data}
          cc={cc}
          fix={fix}
          heading={heading}
          picked={picked}
          pending={mapPending}
          expanded={expanded}
          onMap={setLeaflet}
          onPick={onStripPick}
        />
        {!expanded && tappedTarget && (
          <button
            type="button"
            onClick={() => setTapped(null)}
            className="absolute top-2 left-2 z-[1000] h-11 rounded-full bg-black/75 px-4 text-sm font-bold text-white shadow-lg ring-2 ring-white/70"
            data-flag-clear
          >
            Clear
          </button>
        )}
        <button
          type="button"
          onClick={() => setExpandedRaw(!expanded)}
          aria-label={expanded ? "Collapse map" : "Expand map"}
          aria-expanded={expanded}
          className="absolute top-2 right-2 z-[1000] grid h-11 w-11 place-items-center rounded-full bg-black/75 text-white shadow-lg ring-2 ring-white/70"
          data-flag-expand
        >
          <ExpandIcon up={!expanded} />
        </button>
        {expanded && (
          <>
            <PaintFrame paint={paint} />
            <FlagPaintBar paint={paint} />
          </>
        )}
      </div>

      <div className={`relative z-10 shrink-0 items-center justify-between gap-3 bg-black px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))] ${expanded ? "hidden" : "flex"}`} data-flag-buttons>
        <button
          type="button"
          disabled={!canFlag}
          onClick={() => picked && void flag(picked, "do_not_touch")}
          className="min-h-14 w-28 shrink-0 rounded-2xl bg-white/10 px-2 text-sm leading-tight font-bold ring-2 ring-[#ff8a3d] disabled:opacity-40"
          data-flag-side="dnt"
        >
          Do not touch
        </button>
        <button
          type="button"
          disabled={!canFlag}
          onClick={() => picked && void flag(picked, "open")}
          aria-label={queued > 0 ? `Todo, ${queued} queued` : "Todo"}
          className="relative grid h-[88px] w-[88px] shrink-0 place-items-center rounded-full border-4 border-white bg-[#e5484d] text-lg font-black shadow-lg active:scale-95 disabled:opacity-40"
          data-flag-shutter
        >
          Todo
          {queued > 0 && (
            <span className="absolute -top-1 -right-1 grid h-7 min-w-7 place-items-center rounded-full bg-[#fddd08] px-1.5 text-sm font-bold text-[#0e3038]" data-flag-queued>
              {queued}
            </span>
          )}
        </button>
        <LensSwitch camera={camera} />
      </div>
    </div>
  );
};
