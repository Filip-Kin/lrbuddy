import type { Map as LeafletMap } from "leaflet";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../../../components/Button.tsx";
import { useWakeLock } from "../../../components/driver/hooks.ts";
import { Sheet } from "../../../components/Sheet.tsx";
import { lotTitle } from "../../../lib/format.ts";
import { STATUS_LABEL, type LotGrade, type LotStatus } from "../../../lib/lotStatus.ts";
import { MapView, type MapLine, type MapMarker } from "../../../lib/map/MapView.tsx";
import { useParcelLayer } from "../../../lib/map/parcelLayer.ts";
import { postPhoto, prepareFrame, useInvalidatePhotos } from "../../../lib/photos.ts";
import { trpc } from "../../../lib/trpc.ts";
import { compassPoint, pickParcel, type Candidate } from "./pick.ts";
import { useCamera, useCompass, useFix } from "./sensors.ts";

/** Undo stays on the last-flag card this long (SPEC 22). */
export const UNDO_MS = 20_000;
const RETRY_MS = [2000, 4000, 8000, 15_000] as const;

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
const RAD = Math.PI / 180;

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

/** The heading cone on the mini map: 30 m ahead, 40 degrees wide. */
const cone = (at: { lat: number; lng: number }, heading: number): Array<[number, number]> => {
  const pt = (deg: number, m: number): [number, number] => [at.lat + (Math.cos(deg * RAD) * m) / 111_320, at.lng + (Math.sin(deg * RAD) * m) / (111_320 * Math.cos(at.lat * RAD))];
  return [[at.lat, at.lng], pt(heading - 20, 30), pt(heading + 20, 30), [at.lat, at.lng]];
};

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
  const camera = useCamera();
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
  const picked = useMemo(() => pickParcel(fix, heading, targets), [fix, heading, targets, now]);
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

  const grab = useCallback(async (): Promise<{ photo: Blob; thumb: Blob } | null> => {
    const v = camera.video.current;
    if (camera.state !== "on" || !v || v.videoWidth === 0) return null;
    try {
      return await prepareFrame(v, v.videoWidth, v.videoHeight);
    } catch {
      return null;
    }
  }, [camera.state, camera.video]);

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

  // #region wrong lot
  const [wrongOpen, setWrongOpen] = useState(false);
  const [chosen, setChosen] = useState<string | null>(null);
  const [miniMap, setMiniMap] = useState<LeafletMap | null>(null);
  const chosenTarget = chosen ? (targets.find((t) => t.key === chosen) ?? null) : null;
  const onBare = useCallback((parcelId: string) => setChosen(`p:${parcelId}`), []);
  useParcelLayer(wrongOpen ? miniMap : null, parcels.data, wrongOpen, onBare);
  const miniMarkers = useMemo<MapMarker[]>(() => {
    if (!wrongOpen) return [];
    const out: MapMarker[] = (overview.data?.lots ?? []).map((l) => ({
      id: `lot-${l.id}`,
      kind: "lot",
      lat: l.lat,
      lng: l.lng,
      status: l.status,
      geometry: l.geometry,
      selected: chosen === `l:${l.id}`,
      noFit: true,
      title: l.address ?? undefined,
      onClick: () => setChosen(`l:${l.id}`),
    }));
    if (fix) out.push({ id: "me", kind: "me", lat: fix.lat, lng: fix.lng, accuracy: fix.accuracy });
    else if (overview.data) out.push({ id: "cc", kind: "cc", lat: overview.data.cc.lat, lng: overview.data.cc.lng, name: `CC ${overview.data.cc.name}`, letter: overview.data.cc.letter });
    return out;
  }, [wrongOpen, overview.data, fix, chosen]);
  const miniLines = useMemo<MapLine[]>(() => {
    const out: MapLine[] = [];
    if (fix && heading !== null) out.push({ id: "cone", points: cone(fix, heading), style: "select" });
    const t = chosenTarget;
    const ring = t?.geometry?.type === "Polygon" ? t.geometry.coordinates[0] : t?.geometry?.coordinates[0]?.[0];
    if (ring) out.push({ id: "chosen", points: ring.map((p) => [p[1] ?? 0, p[0] ?? 0] as [number, number]), style: "select" });
    return out;
  }, [fix, heading, chosenTarget]);
  // #endregion

  const last = [...flags].reverse().find((f) => f.phase !== "undone") ?? null;
  const queued = flags.filter((f) => f.phase === "queued" || f.phase === "sending").length;
  const label = (t: Target): string => [lotTitle(t), t.status ? STATUS_LABEL[t.status] : STATUS_LABEL.not_todo, t.crewName].filter(Boolean).join(" · ");
  const canFlag = picked !== null;

  return (
    <div className="relative h-full min-h-[480px] overflow-hidden bg-black text-white" data-flag>
      <video ref={camera.video} muted playsInline autoPlay className="absolute inset-0 h-full w-full object-cover" aria-label="Camera" />
      {camera.state !== "on" && <div aria-hidden="true" className="absolute inset-0 bg-[#0e3038]" />}

      {/* The parcel being aimed at: a yellow frame in the middle of the view. */}
      {picked && (
        <div aria-hidden="true" className="pointer-events-none absolute inset-x-[12%] top-[24%] bottom-[34%] rounded-2xl border-4 border-[#fddd08] shadow-[0_0_0_2px_rgb(0_0_0/0.35)]" />
      )}

      <div className="absolute inset-x-3 top-3 z-10 flex items-start gap-2">
        <div className="min-w-0 flex-1 rounded-xl bg-black/65 px-3 py-2" data-flag-target>
          <p className="text-base leading-tight font-bold break-words">{picked ? label(picked) : "No parcel"}</p>
          <div className="mt-1 flex flex-wrap gap-1.5 text-xs font-semibold">
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

      {last && (
        <div className="absolute inset-x-3 bottom-[calc(max(1rem,env(safe-area-inset-bottom))+7.5rem)] z-10 flex items-center gap-2 rounded-xl bg-black/70 py-1.5 pr-1.5 pl-3" data-flag-last role="status" aria-live="polite">
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
      )}

      <div className="absolute inset-x-0 bottom-0 z-10 flex items-center justify-between gap-3 px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <button
          type="button"
          disabled={!canFlag}
          onClick={() => picked && void flag(picked, "do_not_touch")}
          className="min-h-14 w-24 rounded-2xl bg-black/70 px-2 text-sm leading-tight font-bold ring-2 ring-[#ff8a3d] disabled:opacity-40"
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
          onClick={() => {
            setChosen(picked?.key ?? null);
            setWrongOpen(true);
          }}
          className="min-h-14 w-24 rounded-2xl bg-black/70 px-2 text-sm leading-tight font-bold ring-2 ring-white/70"
          data-flag-side="wrong"
        >
          Wrong lot
        </button>
      </div>

      <Sheet
        open={wrongOpen}
        onClose={() => setWrongOpen(false)}
        title={chosenTarget ? label(chosenTarget) : "Wrong lot"}
        footer={
          <Button
            size="lg"
            block
            disabled={!chosenTarget}
            onClick={() => {
              if (!chosenTarget) return;
              void flag(chosenTarget, "open");
              setWrongOpen(false);
            }}
          >
            Todo here
          </Button>
        }
      >
        <div className="relative h-[52dvh] min-h-64 overflow-hidden rounded-2xl ring-1 ring-line">
          {wrongOpen && <MapView markers={miniMarkers} lines={miniLines} fitKey="flag" label="Parcels" className="absolute inset-0" onReady={setMiniMap} />}
        </div>
      </Sheet>
    </div>
  );
};
