import type { Map as LeafletMap } from "leaflet";
import { useCallback, useEffect, useMemo, useState, type PointerEvent as ReactPointerEvent } from "react";
import { BRUSH_COLOR, PaintBar, PaintFrame, usePaint } from "../../components/PaintBar.tsx";
import { RecenterIcon } from "../../components/driver/icons.tsx";
import { useWakeLock } from "../../components/driver/hooks.ts";
import { LotSheet, type GreenParcel } from "../../components/green/MapSheets.tsx";
import { useSetLot } from "../../components/LotStatusControl.tsx";
import { lotTitle } from "../../lib/format.ts";
import { STATUS_LABEL } from "../../lib/lotStatus.ts";
import type { PaintTarget } from "../../lib/map/paintHit.ts";
import { photoUrl, useInvalidatePhotos } from "../../lib/photos.ts";
import { trpc, type RouterOutputs } from "../../lib/trpc.ts";
import { FlagMap, type FlagMapLot } from "./flag/FlagMap.tsx";
import { LensSwitch } from "./flag/LensSwitch.tsx";
import { metres, type Candidate } from "./flag/pick.ts";
import { CompassAsk, ExpandIcon, useExpanded, useNow, usePaintFollowsExpand } from "./flag/screen.tsx";
import { grabFrame, useCamera, useCompass, useFix } from "./flag/sensors.ts";
import { onAfterSaved, queueAfter, queueTirePhoto, useAfterQueue, type QueuedAfter } from "./wrap/afterQueue.ts";
import { clock } from "../../lib/format.ts";
import { TirePileSheet } from "../../components/TirePile.tsx";
import { nearest, pickWrap, spotDistance } from "./wrap/pick.ts";
import { useBackCloses } from "./wrap/useBackCloses.ts";
import { FILTERS, tireNeedsPhoto, WrapList, type Filter, type WrapLot, type WrapTire } from "./wrap/WrapList.tsx";

/** The map strip's state for the session, as on the Flag screen. */
const MAP_KEY = "lrb.wrap.map";
/** Under this the phone stands where the Before was taken: the chip turns green. */
export const SPOT_NEAR_M = 3;
const NONE: readonly RouterOutputs["green"]["wrap"][number][] = [];

/** A work lot as a pick candidate: its outline from the overview. */
type WrapTarget = WrapLot & Candidate;

/**
 * Wrap up (SPEC 28): the After photo round at the end of the day, laid out as the Flag screen.
 * The camera on top with the picked lot, its Before spot distance and the Before in a corner (hold
 * to see it full size); Not done, the Done shutter and Expand along the bottom. The strip map below
 * picks a lot on a tap, else the camera's bearing picks the lot it faces. A shot or Not done moves
 * on to the nearest lot still needing its After. Expand is the full-screen Paint map; List opens
 * the lots as a sheet.
 */
export const WrapPage = () => {
  const utils = trpc.useUtils();
  const refreshPhotos = useInvalidatePhotos();
  const overview = trpc.green.overview.useQuery(undefined, { refetchInterval: 30_000 });
  const wrap = trpc.green.wrap.useQuery(undefined, { refetchInterval: 60_000 });
  const parcels = trpc.green.parcels.useQuery(undefined, { refetchInterval: 120_000 });
  // Tire piles (SPEC 29): their photo is taken here, at the end of the day, to count the tires.
  const tires = trpc.tires.list.useQuery(undefined, { refetchInterval: 60_000 });
  const lotWrites = useSetLot("green");
  const afters = useAfterQueue();
  useEffect(
    () =>
      onAfterSaved(() => {
        void utils.green.invalidate();
        void utils.tires.list.invalidate();
        refreshPhotos();
      }),
    [utils, refreshPhotos],
  );
  const [expanded, setExpandedState] = useExpanded(MAP_KEY);
  const camera = useCamera(expanded);
  const { fix, state: fixState } = useFix();
  const compass = useCompass();
  const heading = compass.heading;
  useWakeLock(true);
  const now = useNow();

  const [filter, setFilter] = useState<Filter>("needsAfter");
  const [listOpen, setListOpen] = useState(false);
  useBackCloses(listOpen, () => setListOpen(false));
  const [sheet, setSheet] = useState<number | null>(null);
  // A lot tapped on the strip, picked from the list or moved on to after a shot holds the pick
  // (the ray pauses) until Clear, a second tap on it, or Expand.
  const [held, setHeldLot] = useState<number | null>(null);
  // A tire pile held the same way (SPEC 29); holding one lets go of the lot, and back.
  const [heldTire, setHeldTireState] = useState<number | null>(null);
  const setHeld = (v: number | null | ((h: number | null) => number | null)): void => {
    setHeldLot(v);
    setHeldTireState(null);
  };
  const setHeldTire = (v: number | null | ((h: number | null) => number | null)): void => {
    setHeldTireState(v);
    setHeldLot(null);
  };
  const [tireSheet, setTireSheet] = useState<number | null>(null);
  // A List pick centres the strip on its lot until Recenter.
  const [onLot, setOnLot] = useState(false);
  const setExpanded = (on: boolean): void => {
    setExpandedState(on);
    setHeld(null);
    setOnLot(false);
  };

  // #region paint
  // Expand is Paint (SPEC 23), as on the green map: every lot and bare parcel at the CC is a target.
  const [leaflet, setLeaflet] = useState<LeafletMap | null>(null);
  const paintTargets = useMemo<PaintTarget[]>(() => {
    const out: PaintTarget[] = [];
    for (const l of overview.data?.lots ?? []) {
      out.push({ key: `l:${l.id}`, lotId: l.id, parcelId: l.parcelId, status: lotWrites.pending.get(`l:${l.id}`) ?? l.status, crewId: l.crewId, lat: l.lat, lng: l.lng, geometry: l.geometry });
    }
    for (const p of parcels.data ?? []) {
      out.push({ key: `p:${p.parcelId}`, lotId: null, parcelId: p.parcelId, status: lotWrites.pending.get(`p:${p.parcelId}`) ?? null, crewId: null, lat: p.lat, lng: p.lng, geometry: p.geometry });
    }
    return out;
  }, [overview.data?.lots, parcels.data, lotWrites.pending]);
  const paint = usePaint(leaflet, { kind: "green" }, paintTargets);
  usePaintFollowsExpand(paint, expanded);
  const pending = useMemo(() => (paint.pending.size === 0 ? lotWrites.pending : new Map([...lotWrites.pending, ...paint.pending])), [lotWrites.pending, paint.pending]);
  // #endregion

  // #region lots
  const queuedByLot = useMemo(() => {
    const m = new Map<number, QueuedAfter>();
    // A saved After stays until the list has refetched with it, so the lot does not flicker back.
    for (const q of afters) if (q.lotId !== null && (q.phase !== "done" || (q.savedAt ?? 0) > wrap.dataUpdatedAt)) m.set(q.lotId, q);
    return m;
  }, [afters, wrap.dataUpdatedAt]);
  const wrapTires = useMemo<WrapTire[]>(() => {
    const m = new Map<number, QueuedAfter>();
    for (const q of afters) if (q.pileId !== null && (q.phase !== "done" || (q.savedAt ?? 0) > tires.dataUpdatedAt)) m.set(q.pileId, q);
    return (tires.data ?? []).map((t) => ({ ...t, queued: m.get(t.id) ?? null }));
  }, [afters, tires.data, tires.dataUpdatedAt]);
  const shapes = useMemo(() => new Map((overview.data?.lots ?? []).map((l) => [l.id, l])), [overview.data]);
  const work = useMemo<WrapTarget[]>(
    () =>
      (wrap.data ?? NONE).map((l) => {
        const shape = shapes.get(l.id);
        return { ...l, status: pending.get(`l:${l.id}`) ?? l.status, queued: queuedByLot.get(l.id) ?? null, key: `l:${l.id}`, geometry: shape?.geometry ?? null, drawn: shape?.source === "drawn" };
      }),
    [wrap.data, shapes, pending, queuedByLot],
  );
  const byId = useMemo(() => new Map(work.map((l) => [l.id, l])), [work]);
  const badge = useCallback((l: FlagMapLot): boolean => {
    const w = byId.get(l.id);
    return w !== undefined && FILTERS.needsAfter(w);
  }, [byId]);

  // Recomputed every second (the `now` tick) from the latest fix and heading.
  const aimed = useMemo(() => pickWrap(fix, heading, work, FILTERS.needsAfter), [fix, heading, work, now]);
  const heldLot = held !== null ? (byId.get(held) ?? null) : null;
  const pickedTire = heldTire !== null ? (wrapTires.find((t) => t.id === heldTire) ?? null) : null;
  const picked = pickedTire ? null : (heldLot ?? aimed);
  const pickedShape = useMemo(() => (picked ? { key: picked.key, geometry: picked.geometry } : null), [picked?.key, picked?.geometry]);
  const spot = picked?.beforeSpot ?? null;
  const spotM = spot && fix ? metres(fix, spot) : null;
  const mapSpot = useMemo(() => (spot ? { lat: spot.lat, lng: spot.lng, heading: spot.heading } : null), [spot?.lat, spot?.lng, spot?.heading]);
  const centreOn = heldLot ?? pickedTire;
  const centre = useMemo(() => (onLot && centreOn ? { lat: centreOn.lat, lng: centreOn.lng } : null), [onLot, centreOn?.lat, centreOn?.lng]);
  const mapTires = useMemo(() => wrapTires.map((t) => ({ id: t.id, lat: t.lat, lng: t.lng, badge: tireNeedsPhoto(t), picked: t.id === heldTire })), [wrapTires, heldTire]);

  /**
   * After `done` was shot or set Not done: the nearest lot still needing its After or tire pile
   * still needing its photo, whichever is closer.
   */
  const moveOn = (done: { lot: number | null; tire: number | null }): void => {
    const lot = fix ? nearest(fix, work.filter(FILTERS.needsAfter), Number.POSITIVE_INFINITY, done.lot) : null;
    const tire = fix ? nearest(fix, wrapTires.filter(tireNeedsPhoto), Number.POSITIVE_INFINITY, done.tire) : null;
    if (tire && fix && (!lot || metres(fix, tire) < metres(fix, lot))) setHeldTire(tire.id);
    else setHeld(lot?.id ?? null);
    setOnLot(false);
  };

  const onStripPick = (key: string): void => {
    if (key.startsWith("t:")) {
      const id = Number(key.slice(2));
      setHeldTire((h) => (h === id ? null : id));
      setOnLot(false);
      return;
    }
    if (!key.startsWith("l:")) return;
    const id = Number(key.slice(2));
    // A work lot holds the pick; any other lot (Not todo, Do not touch) opens its sheet.
    if (byId.has(id)) {
      setHeld((h) => (h === id ? null : id));
      setOnLot(false);
    } else setSheet(id);
  };
  // #endregion

  // #region shutter
  const [busy, setBusy] = useState(false);
  const shoot = async (): Promise<void> => {
    const tire = pickedTire;
    if (tire) {
      if (busy) return;
      setBusy(true);
      const blobs = await grabFrame(camera);
      setBusy(false);
      if (blobs) queueTirePhoto(tire.id, blobs);
      moveOn({ lot: null, tire: tire.id });
      return;
    }
    const lot = picked;
    if (!lot || busy) return;
    const from = fix;
    const facing = heading;
    setBusy(true);
    const blobs = await grabFrame(camera);
    setBusy(false);
    if (lot.status !== "done") lotWrites.set({ lotId: lot.id, parcelId: null }, { status: "done" });
    if (blobs) queueAfter(lot.id, blobs, from, facing);
    moveOn({ lot: lot.id, tire: null });
  };
  const notDone = (): void => {
    const lot = picked;
    if (!lot) return;
    // A lot not finished looks the same as its Before: no photo.
    if (lot.status !== "not_done") lotWrites.set({ lotId: lot.id, parcelId: null }, { status: "not_done" });
    moveOn({ lot: lot.id, tire: null });
  };
  const queued = afters.filter((q) => q.phase === "queued" || q.phase === "sending").length;
  const notSent = afters.filter((q) => q.phase === "failed").length;
  // #endregion

  // #region peek
  const beforeId = picked?.beforeThumb ?? null;
  const [peek, setPeek] = useState(false);
  useEffect(() => setPeek(false), [beforeId, expanded]);
  const peekDown = (e: ReactPointerEvent<HTMLButtonElement>): void => {
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setPeek(true);
  };
  const peekUp = (): void => setPeek(false);
  // #endregion

  const d = overview.data;
  const loaded = !!d && !!wrap.data;
  const failed = (overview.isError && !d) || (wrap.isError && !wrap.data);
  const retry = (): void => {
    void overview.refetch();
    void wrap.refetch();
  };
  const cc = useMemo(() => (d ? { lat: d.cc.lat, lng: d.cc.lng, name: d.cc.name, letter: d.cc.letter } : null), [d]);

  const sheetLot = sheet !== null ? (d?.lots.find((l) => l.id === sheet) ?? null) : null;
  const sheetParcel: GreenParcel | null = sheetLot
    ? {
        lotId: sheetLot.id,
        parcelId: sheetLot.parcelId,
        address: sheetLot.address,
        status: pending.get(`l:${sheetLot.id}`) ?? sheetLot.status,
        grade: sheetLot.grade,
        note: sheetLot.note,
        crewId: sheetLot.crewId,
        statusAt: sheetLot.statusAt,
        drawn: sheetLot.source === "drawn",
      }
    : null;

  const chip = "rounded-full px-2 py-0.5";
  const top = (
    <div className={`z-[1001] flex items-start gap-2 ${expanded ? "relative shrink-0 px-3 py-3" : "absolute inset-x-3 top-3"}`}>
      <div className="min-w-0 flex-1 rounded-xl bg-black/65 px-3 py-2" data-wrap-target={picked?.id ?? ""} data-wrap-tire-target={pickedTire?.id ?? ""}>
        <p className="text-base leading-tight font-bold break-words">{pickedTire ? "Tire pile" : picked ? lotTitle(picked) : failed ? "Lots not loaded" : loaded ? "No lot" : "Loading lots"}</p>
        {pickedTire && (
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="min-w-0 text-sm font-semibold break-words text-white/85">{`${pickedTire.madeBy}, ${clock(pickedTire.createdAt)}`}</span>
            <button type="button" onClick={() => setTireSheet(pickedTire.id)} className="-my-2 ml-auto min-h-11 shrink-0 px-1 text-sm font-semibold underline underline-offset-4" data-wrap-details>
              Details
            </button>
          </div>
        )}
        {picked && (
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
            {/* The card is dark in both themes: the status as a light chip with the status colour as its dot. */}
            <span className="inline-flex items-center gap-1.5 rounded-full bg-white/20 px-2 py-0.5 text-xs font-semibold whitespace-nowrap" data-wrap-status={picked.status}>
              <span aria-hidden="true" className="h-2 w-2 rounded-full" style={{ background: BRUSH_COLOR[picked.status] }} />
              {STATUS_LABEL[picked.status]}
            </span>
            <span className="min-w-0 text-sm font-semibold break-words text-white/85">{picked.crewName ?? "No crew"}</span>
            <button
              type="button"
              onClick={() => setSheet(picked.id)}
              className="-my-2 ml-auto min-h-11 shrink-0 px-1 text-sm font-semibold underline underline-offset-4"
              data-wrap-details
            >
              Details
            </button>
          </div>
        )}
        <div className="mt-1 flex flex-wrap gap-1.5 text-xs font-semibold empty:hidden">
          {(camera.state === "denied" || camera.state === "none") && <span className={`${chip} bg-[#e55b00]`}>No camera</span>}
          {(fixState === "denied" || fixState === "none") && <span className={`${chip} bg-[#e55b00]`}>No location</span>}
          {fixState === "waiting" && <span className={`${chip} bg-white/20`}>Finding location</span>}
          {notSent > 0 && <span className={`${chip} bg-[#e55b00]`} data-wrap-not-sent>{`${notSent} not sent`}</span>}
          {failed && (
            <button type="button" onClick={retry} className={`${chip} -my-1 min-h-8 bg-white text-[#0e3038]`}>
              Retry
            </button>
          )}
        </div>
      </div>
      {spot && spotM !== null && (
        <span
          className={`shrink-0 rounded-full px-3 py-2 text-sm font-bold whitespace-nowrap ${spotM < SPOT_NEAR_M ? "bg-[#00a14b]" : "bg-black/65"}`}
          data-wrap-spot
          data-near={spotM < SPOT_NEAR_M ? "true" : "false"}
        >
          {`Before spot ${spotDistance(spotM)}`}
        </span>
      )}
    </div>
  );

  return (
    <div className="relative flex h-full min-h-[480px] flex-col overflow-hidden bg-black text-white" data-wrap data-wrap-expanded={expanded ? "true" : "false"}>
      {top}

      {/* Camera: hidden, not unmounted, while the map is full screen, so it resumes without asking again. */}
      <div className={`relative min-h-0 flex-1 ${expanded ? "hidden" : ""}`} data-wrap-camera>
        <video ref={camera.video} muted playsInline autoPlay className="absolute inset-0 h-full w-full object-cover" aria-label="Camera" />
        {camera.state !== "on" && <div aria-hidden="true" className="absolute inset-0 bg-[#0e3038]" />}
        {/* The Before full size, the camera's crop, while the corner is held. Always loaded so a hold shows it at once. */}
        {beforeId !== null && (
          <img
            src={photoUrl(beforeId)}
            alt={peek ? "Before" : ""}
            aria-hidden={!peek}
            draggable={false}
            className={`pointer-events-none absolute inset-0 h-full w-full object-cover ${peek ? "" : "invisible"}`}
            data-wrap-peek-view={peek ? "on" : "off"}
          />
        )}
        {beforeId !== null && (
          <button
            type="button"
            aria-label="Before"
            aria-pressed={peek}
            onPointerDown={peekDown}
            onPointerUp={peekUp}
            onPointerCancel={peekUp}
            onLostPointerCapture={peekUp}
            onContextMenu={(e) => e.preventDefault()}
            onKeyDown={(e) => {
              if (e.key === " " || e.key === "Enter") {
                e.preventDefault();
                setPeek(true);
              }
            }}
            onKeyUp={peekUp}
            onBlur={peekUp}
            className="absolute bottom-[124px] left-3 z-[1001] h-[150px] w-[112px] touch-none overflow-hidden rounded-xl border-[3px] border-[#fddd08] bg-[#0e3038] shadow-lg select-none [-webkit-touch-callout:none]"
            data-wrap-peek
          >
            <img src={photoUrl(beforeId, true)} alt="" draggable={false} className="pointer-events-none h-full w-full object-cover" />
            <span className="absolute inset-x-0 bottom-0 bg-black/70 py-1 text-center text-xs font-bold">{peek ? "Before" : "Hold"}</span>
          </button>
        )}
        <div className="absolute right-3 bottom-[124px] z-[1001]">
          <LensSwitch camera={camera} />
        </div>
        <div
          className="absolute inset-x-0 bottom-0 z-[1001] flex items-center justify-between gap-3 bg-gradient-to-t from-black/75 to-transparent px-4 pt-6 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
          data-wrap-buttons
        >
          <button
            type="button"
            disabled={!picked}
            onClick={notDone}
            className="min-h-14 w-28 shrink-0 rounded-2xl bg-[#a21caf] px-2 text-base leading-tight font-bold shadow-lg ring-2 ring-[#f0abfc] disabled:opacity-40"
            data-wrap-not-done
          >
            Not done
          </button>
          <button
            type="button"
            disabled={(!picked && !pickedTire) || busy || camera.state === "starting"}
            onClick={() => void shoot()}
            aria-label={`${pickedTire ? "Photo" : "Done"}${queued > 0 ? `, ${queued} queued` : ""}`}
            className="relative grid h-[88px] w-[88px] shrink-0 place-items-center rounded-full border-4 border-white bg-[#00a14b] text-lg font-black shadow-lg active:scale-95 disabled:opacity-40"
            data-wrap-shutter
          >
            {pickedTire ? "Photo" : "Done"}
            {queued > 0 && (
              <span className="absolute -top-1 -right-1 grid h-7 min-w-7 place-items-center rounded-full bg-[#fddd08] px-1.5 text-sm font-bold text-[#0e3038]" data-wrap-queued>
                {queued}
              </span>
            )}
          </button>
          <div className="flex w-28 shrink-0 justify-end">
            <button
              type="button"
              onClick={() => setExpanded(true)}
              aria-label="Expand map"
              aria-expanded={false}
              className="grid h-14 w-14 place-items-center rounded-full bg-black/75 text-white shadow-lg ring-2 ring-white/70"
              data-wrap-expand
            >
              <ExpandIcon up />
            </button>
          </div>
        </div>
        {!expanded && <CompassAsk compass={compass} />}
      </div>

      <div className={`relative isolate shrink-0 overflow-hidden border-t-2 border-black ${expanded ? "min-h-0 flex-1" : "h-[28%]"}`} data-wrap-strip>
        <FlagMap
          lots={d?.lots ?? []}
          parcels={parcels.data}
          plan={undefined}
          cc={cc}
          fix={fix}
          heading={heading}
          picked={pickedShape}
          pending={pending}
          expanded={expanded}
          onMap={setLeaflet}
          onPick={onStripPick}
          badge={badge}
          bareOnStrip={false}
          spot={mapSpot}
          centre={expanded ? null : centre}
          tires={mapTires}
          label="Wrap up map"
        />
        {!loaded && !failed && <div aria-hidden="true" className="absolute inset-0 z-[500] animate-pulse bg-surface-2/60" />}
        {!expanded && (heldLot || pickedTire) && (
          <button
            type="button"
            onClick={() => {
              setHeld(null);
              setOnLot(false);
            }}
            className="absolute top-2 left-2 z-[1000] h-11 rounded-full bg-black/75 px-4 text-sm font-bold text-white shadow-lg ring-2 ring-white/70"
            data-wrap-clear
          >
            Clear
          </button>
        )}
        {!expanded && (
          <button
            type="button"
            onClick={() => setListOpen(true)}
            className="absolute top-2 right-2 z-[1000] h-11 rounded-full bg-black/75 px-4 text-sm font-bold text-white shadow-lg ring-2 ring-white/70"
            data-wrap-list-open
          >
            List
          </button>
        )}
        {!expanded && onLot && fix && (
          <button
            type="button"
            onClick={() => setOnLot(false)}
            className="absolute right-2 bottom-2 z-[1000] flex h-11 items-center gap-1.5 rounded-full bg-black/75 px-4 text-sm font-bold text-white shadow-lg ring-2 ring-white/70"
            data-recenter
          >
            <RecenterIcon />
            Recenter
          </button>
        )}
        {expanded && (
          <>
            <button
              type="button"
              onClick={() => setExpanded(false)}
              aria-label="Collapse map"
              aria-expanded
              className="absolute top-2 right-2 z-[1000] grid h-11 w-11 place-items-center rounded-full bg-black/75 text-white shadow-lg ring-2 ring-white/70"
              data-wrap-collapse
            >
              <ExpandIcon up={false} />
            </button>
            <PaintFrame paint={paint} />
            <PaintBar paint={paint} crews={d?.crews ?? []} onDone={() => setExpanded(false)} />
          </>
        )}
      </div>

      <WrapList
        open={listOpen}
        onClose={() => setListOpen(false)}
        lots={work}
        loaded={!!wrap.data}
        failed={failed}
        onRetry={retry}
        filter={filter}
        onFilter={setFilter}
        me={fix}
        picked={picked?.id ?? null}
        onPick={(id) => {
          setHeld(id);
          setOnLot(true);
          setListOpen(false);
        }}
        tires={wrapTires}
        pickedTire={heldTire}
        onPickTire={(id) => {
          setHeldTire(id);
          setOnLot(true);
          setListOpen(false);
        }}
      />
      <TirePileSheet pile={tireSheet !== null ? (tires.data?.find((t) => t.id === tireSheet) ?? null) : null} now={now} onClose={() => setTireSheet(null)} />
      <LotSheet parcel={sheetParcel} crews={d?.crews ?? []} lots={lotWrites} onClose={() => setSheet(null)} />
    </div>
  );
};
