import type { Map as LeafletMap } from "leaflet";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PaintBar, PaintFrame, PaintIcon, usePaint } from "../../../components/PaintBar.tsx";
import { useWakeLock } from "../../../components/driver/hooks.ts";
import { lotTitle } from "../../../lib/format.ts";
import type { PaintTarget } from "../../../lib/map/paintHit.ts";
import { STATUS_LABEL, type LotGrade, type LotStatus } from "../../../lib/lotStatus.ts";
import { FlagMap } from "./FlagMap.tsx";
import { postPhoto, prepareFrame, useInvalidatePhotos } from "../../../lib/photos.ts";
import { trpc } from "../../../lib/trpc.ts";
import { compassPoint, pickParcel, type Candidate } from "./pick.ts";
import { useCamera, useCompass, useFix } from "./sensors.ts";
import { storageGet, storageSet } from "../../../lib/safe.ts";

/** Undo stays on the last-flag card this long (SPEC 22). */
export const UNDO_MS = 20_000;
const RETRY_MS = [2000, 4000, 8000, 15_000] as const;
/** The map strip's state for the session (SPEC 22, map strip). */
const MAP_KEY = "lrb.flag.map";
const readExpanded = (): boolean => storageGet("session", MAP_KEY) === "full";

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

const ExpandIcon = ({ up }: { up: boolean }) => (
  <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {up ? <path d="M6 15l6-6 6 6" /> : <path d="M6 9l6 6 6-6" />}
  </svg>
);

const isRefusal = (e: unknown): boolean => {
  if (typeof e !== "object" || e === null || !("data" in e)) return false;
  const d: unknown = (e as { data: unknown }).data;
  const code = typeof d === "object" && d !== null && "code" in d ? (d as { code: unknown }).code : null;
  return code === "FORBIDDEN" || code === "NOT_FOUND" || code === "BAD_REQUEST";
};
// #endregion

/**
 * Flag screen (SPEC 22): the morning sweep with the camera. The phone's GPS
 * and compass pick the parcel it faces; Todo takes the photo, saves it as the
 * lot's Before and marks the lot Todo with its rectangle's crew. Flags queue
 * in memory and post in order.
 */
export const FlagPage = () => {
  const utils = trpc.useUtils();
  const refreshPhotos = useInvalidatePhotos();
  const overview = trpc.green.overview.useQuery(undefined, { refetchInterval: 60_000 });
  const parcels = trpc.green.parcels.useQuery(undefined, { refetchInterval: 120_000 });
  const plan = trpc.green.plan.useQuery(undefined, { refetchInterval: 120_000 });
  // Full-screen map: the camera pauses, taps on the map pick the parcel. Kept for the session.
  const [expanded, setExpandedState] = useState(readExpanded);
  const camera = useCamera(expanded);
  const { fix, state: fixState } = useFix();
  const compass = useCompass();
  useWakeLock(true);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);

  // The GPS course stands in for the compass while walking or driving faster than 2 m/s.
  const heading = compass.heading ?? (fix && fix.speed !== null && fix.speed > 2 ? fix.heading : null);

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
  // A parcel tapped on the full-screen map wins over the aimed one until the map collapses.
  const [tapped, setTapped] = useState<string | null>(null);
  const tappedTarget = tapped ? (targets.find((t) => t.key === tapped) ?? null) : null;
  const picked = expanded && tappedTarget ? tappedTarget : aimed;
  const setExpandedRaw = useCallback((on: boolean): void => {
    setExpandedState(on);
    setTapped(null);
    storageSet("session", MAP_KEY, on ? "full" : "strip");
  }, []);
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
        const at = flagsRef.current.find((x) => x.id === f.id)?.target;
        if (at) {
          form.set("lat", String(at.lat));
          form.set("lng", String(at.lng));
        }
        form.set("photo", f.photo.photo, "photo.jpg");
        form.set("thumb", f.photo.thumb, "thumb.jpg");
        const r = await postPhoto(form, () => undefined);
        if (!r.ok) throw new Error(r.message);
        photoId = r.id;
      }
      patch(f.id, { phase: "done", photoId, photo: null, message: null });
      void utils.green.invalidate();
      refreshPhotos();
    } catch (e) {
      if (isRefusal(e)) patch(f.id, { phase: "failed", message: e instanceof Error ? e.message : "Not saved" });
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
    return () => {
      window.removeEventListener("online", online);
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, [pump]);

  // No photo while the map is full screen: the camera is paused and would not show the tapped parcel.
  const grab = useCallback(async (): Promise<{ photo: Blob; thumb: Blob } | null> => {
    const v = camera.video.current;
    if (expanded || camera.state !== "on" || !v || v.videoWidth === 0) return null;
    try {
      return await prepareFrame(v, v.videoWidth, v.videoHeight);
    } catch {
      return null;
    }
  }, [camera.state, camera.video, expanded]);

  const flag = useCallback(
    async (target: Target, status: FlagStatus): Promise<void> => {
      const photo = await grab();
      const f: Flag = { id: nextId.current++, target, status, photo, at: Date.now(), phase: "queued", lotId: null, photoId: null, message: null, tries: 0 };
      flagsRef.current = [...flagsRef.current, f];
      setFlags(flagsRef.current);
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

  // Paint on the full-screen map (SPEC 22, Paint on the expanded map): the green map's brush bar,
  // the same green.paint batch and Undo history. Every lot and bare parcel at the CC is a target.
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
  const painting = paint.on && expanded;
  const mapPending = useMemo(() => (paint.pending.size === 0 ? pending : new Map([...pending, ...paint.pending])), [pending, paint.pending]);
  // The strip never paints: Collapse ends paint mode first.
  const closePaint = paint.close;
  const setExpanded = useCallback(
    (on: boolean): void => {
      if (!on) closePaint();
      setExpandedRaw(on);
    },
    [closePaint, setExpandedRaw],
  );
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
      {compass.needsAsk ? (
        <button type="button" onClick={() => void compass.ask()} className="min-h-11 shrink-0 rounded-full bg-[#fddd08] px-4 text-sm font-bold text-[#0e3038]">
          Compass
        </button>
      ) : (
        <span className="shrink-0 rounded-full bg-black/65 px-3 py-2 text-sm font-bold" data-flag-heading>
          {heading !== null ? `Facing ${compassPoint(heading)}` : "No compass"}
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
        {/* The parcel being aimed at: a yellow frame in the middle of the view. */}
        {picked && (
          <div aria-hidden="true" className="pointer-events-none absolute inset-x-[12%] top-[22%] bottom-[18%] rounded-2xl border-4 border-[#fddd08] shadow-[0_0_0_2px_rgb(0_0_0/0.35)]" />
        )}
        {!expanded && lastCard}
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
          painting={painting}
          onMap={setLeaflet}
          onPick={setTapped}
        />
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          aria-label={expanded ? "Collapse map" : "Expand map"}
          aria-expanded={expanded}
          className="absolute top-2 right-2 z-[1000] grid h-11 w-11 place-items-center rounded-full bg-black/75 text-white shadow-lg ring-2 ring-white/70"
          data-flag-expand
        >
          <ExpandIcon up={!expanded} />
        </button>
        {expanded && !painting && (
          <button
            type="button"
            onClick={() => paint.open()}
            disabled={!leaflet || !overview.data}
            className="absolute top-2 right-15 z-[1000] flex h-11 items-center gap-1.5 rounded-full bg-black/75 pr-4 pl-3 text-sm font-bold text-white shadow-lg ring-2 ring-white/70 disabled:opacity-40"
            data-flag-paint
          >
            <PaintIcon />
            Paint
          </button>
        )}
        {expanded && !painting && lastCard}
        {painting && (
          <div className="text-ink">
            <PaintFrame paint={paint} />
            <PaintBar paint={paint} crews={overview.data?.crews ?? []} />
          </div>
        )}
      </div>

      <div className={`relative z-10 shrink-0 items-center justify-between gap-3 bg-black px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))] ${painting ? "hidden" : "flex"}`} data-flag-buttons>
        <button
          type="button"
          disabled={!canFlag}
          onClick={() => picked && void flag(picked, "do_not_touch")}
          className="min-h-14 w-24 rounded-2xl bg-white/10 px-2 text-sm leading-tight font-bold ring-2 ring-[#ff8a3d] disabled:opacity-40"
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
        <button
          type="button"
          disabled={expanded}
          aria-pressed={expanded}
          onClick={() => setExpanded(true)}
          className={`min-h-14 w-24 rounded-2xl px-2 text-sm leading-tight font-bold ring-2 ${expanded ? "bg-[#fddd08] text-[#0e3038] ring-[#fddd08]" : "bg-white/10 ring-white/70"}`}
          data-flag-side="wrong"
        >
          Wrong lot
        </button>
      </div>
    </div>
  );
};
