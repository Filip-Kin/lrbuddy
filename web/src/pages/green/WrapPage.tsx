import type { Map as LeafletMap } from "leaflet";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "../../components/Button.tsx";
import { PaintBar, PaintFrame, PaintIcon, usePaint } from "../../components/PaintBar.tsx";
import { EmptyState } from "../../components/EmptyState.tsx";
import { RecenterIcon } from "../../components/driver/icons.tsx";
import { LotSheet, type GreenParcel } from "../../components/green/MapSheets.tsx";
import { useSetLot } from "../../components/LotStatusControl.tsx";
import { CameraIcon } from "../../components/photos/icons.tsx";
import { Segmented } from "../../components/Segmented.tsx";
import { lotPill, StatusPill } from "../../components/StatusPill.tsx";
import { distance, lotTitle } from "../../lib/format.ts";
import type { LotStatus } from "../../lib/lotStatus.ts";
import { MapView, type MapMarker } from "../../lib/map/MapView.tsx";
import type { PaintTarget } from "../../lib/map/paintHit.ts";
import { useParcelLayer } from "../../lib/map/parcelLayer.ts";
import { photoUrl, useInvalidatePhotos } from "../../lib/photos.ts";
import { geolocation } from "../../lib/safe.ts";
import { trpc, type RouterOutputs } from "../../lib/trpc.ts";
import { distanceM } from "../plan/survey/geo.ts";
import { onAfterSaved, queueAfter, useAfterQueue, type QueuedAfter } from "./wrap/afterQueue.ts";
import { AfterCamera } from "./wrap/AfterCamera.tsx";
import { useBackCloses, WrapChooser, type WrapChoice } from "./wrap/WrapChooser.tsx";

/** A wrap lot with this phone's unsent writes on it: a status tap or stroke, an After still in the queue. */
type WrapLot = Omit<RouterOutputs["green"]["wrap"][number], "status"> & { status: LotStatus; queued: QueuedAfter | null };
type Filter = "needsAfter" | "notDone" | "all";
const NONE: readonly RouterOutputs["green"]["wrap"][number][] = [];

/** An After on its way counts as taken; one the server refused does not. */
const hasAfter = (l: WrapLot): boolean => l.hasAfter || (l.queued !== null && l.queued.phase !== "failed");

const FILTERS: Record<Filter, (l: WrapLot) => boolean> = {
  // A Not done lot needs no After: nothing changed on it.
  needsAfter: (l) => l.hasBefore && !hasAfter(l) && l.status !== "not_done",
  notDone: (l) => l.status !== "done",
  all: () => true,
};

/** One photo kind on a row: the newest thumb when taken (or the local one while it uploads), a hollow camera when missing. */
const PhotoMark = ({ kind, thumb, queued = null }: { kind: "Before" | "After"; thumb: number | null; queued?: QueuedAfter | null }) => (
  <span
    data-photo={kind.toLowerCase()}
    data-taken={thumb !== null || (queued !== null && queued.phase !== "failed")}
    data-upload={thumb === null && queued ? queued.phase : undefined}
    className="flex flex-col items-center gap-0.5"
  >
    {thumb !== null ? (
      <img src={photoUrl(thumb, true)} alt={kind} loading="lazy" className="h-8 w-8 rounded-md bg-surface-2 object-cover ring-1 ring-line" />
    ) : queued ? (
      <img src={queued.preview} alt={kind} className={`h-8 w-8 rounded-md bg-surface-2 object-cover ${queued.phase === "failed" ? "opacity-50 ring-2 ring-crew" : "ring-2 ring-brand ring-dashed"}`} />
    ) : (
      <span role="img" aria-label={`No ${kind.toLowerCase()}`} className="grid h-8 w-8 place-items-center rounded-md text-muted ring-1 ring-inset ring-line ring-dashed">
        <CameraIcon size={16} />
      </span>
    )}
    <span className="text-[10px] leading-none font-semibold text-muted">{thumb === null && queued?.phase === "failed" ? "Not sent" : kind}</span>
  </span>
);

/**
 * Wrap up: the After photo round at the end of the day. A map strip with the lots, the camera
 * badge on lots with a Before and no After, and the blue dot; below it the work lots nearest
 * first. A tap on a lot is Done or Not done; Done on a lot with a Before and no After opens the
 * camera, and one shutter press is back on the list with the After uploading behind it. Paint
 * works here as on the green map.
 */
export const WrapPage = () => {
  const utils = trpc.useUtils();
  const refreshPhotos = useInvalidatePhotos();
  const overview = trpc.green.overview.useQuery(undefined, { refetchInterval: 30_000 });
  const wrap = trpc.green.wrap.useQuery(undefined, { refetchInterval: 60_000 });
  const parcels = trpc.green.parcels.useQuery(undefined, { refetchInterval: 120_000 });
  const lotWrites = useSetLot("green");
  const afters = useAfterQueue();
  useEffect(
    () =>
      onAfterSaved(() => {
        void utils.green.invalidate();
        refreshPhotos();
      }),
    [utils, refreshPhotos],
  );
  const [filter, setFilter] = useState<Filter>("needsAfter");
  // The highlighted lot stays highlighted after its sheet closes.
  const [selected, setSelected] = useState<number | null>(null);
  const [sheet, setSheet] = useState<number | null>(null);
  // The tap flow on one lot: Done or Not done, then the After camera when the lot needs one.
  const [flow, setFlow] = useState<{ lotId: number; step: "choose" | "camera" } | null>(null);
  useBackCloses(flow !== null, () => setFlow(null));
  const [map, setMap] = useState<LeafletMap | null>(null);
  const [me, setMe] = useState<{ lat: number; lng: number; accuracy: number } | null>(null);
  useEffect(() => {
    const geo = geolocation();
    if (!geo) return;
    const id = geo.watchPosition(
      (p) => setMe({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }),
      () => undefined,
      { enableHighAccuracy: true, maximumAge: 0, timeout: 30_000 },
    );
    return () => geo.clearWatch(id);
  }, []);
  // Recenter follows the blue dot until the strip is moved by hand, as on the map.
  const [follow, setFollow] = useState(false);
  useEffect(() => {
    if (follow && map && me) map.panTo([me.lat, me.lng], { animate: true, duration: 0.5 });
  }, [follow, map, me]);
  useEffect(() => {
    if (!map) return;
    const stop = (): void => setFollow(false);
    map.on("dragstart zoomstart", stop);
    return () => {
      map.off("dragstart zoomstart", stop);
    };
  }, [map]);

  // Paint (SPEC 23), as on the green map: every lot and bare parcel at the CC is a target.
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
  const paint = usePaint(map, { kind: "green" }, paintTargets);
  const painting = paint.on;
  const pending = useMemo(() => (paint.pending.size === 0 ? lotWrites.pending : new Map([...lotWrites.pending, ...paint.pending])), [lotWrites.pending, paint.pending]);
  // Bare parcels only while painting, so there is something to hit; a tap on one opens nothing.
  const noop = useCallback(() => undefined, []);
  useParcelLayer(map, parcels.data, painting, noop, pending, true);

  const d = overview.data;
  const queuedByLot = useMemo(() => {
    const m = new Map<number, QueuedAfter>();
    // A saved After stays until the list has refetched with it, so the row does not flicker back.
    for (const q of afters) if (q.phase !== "done" || (q.savedAt ?? 0) > wrap.dataUpdatedAt) m.set(q.lotId, q);
    return m;
  }, [afters, wrap.dataUpdatedAt]);
  const all = useMemo<WrapLot[]>(
    () => (wrap.data ?? NONE).map((l) => ({ ...l, status: pending.get(`l:${l.id}`) ?? l.status, queued: queuedByLot.get(l.id) ?? null })),
    [wrap.data, pending, queuedByLot],
  );
  const byId = useMemo(() => new Map(all.map((l) => [l.id, l])), [all]);
  const counts = useMemo(
    () => ({ needsAfter: all.filter(FILTERS.needsAfter).length, notDone: all.filter(FILTERS.notDone).length, all: all.length }),
    [all],
  );
  // Nearest first from the phone; with no position, by address.
  const rows = useMemo(() => {
    const shown = all.filter(FILTERS[filter]).map((l) => ({ lot: l, m: me ? distanceM(me, l) : null }));
    return me
      ? shown.sort((a, b) => (a.m ?? 0) - (b.m ?? 0))
      : shown.sort((a, b) => lotTitle(a.lot).localeCompare(lotTitle(b.lot), "en", { numeric: true }));
  }, [all, filter, me]);
  // The strip fits to the lots of the chosen chip, once per chip; later fixes and refetches keep the user's view.
  const fitKey = filter;

  const shownIds = useMemo(() => new Set(rows.map((r) => r.lot.id)), [rows]);
  // A work lot opens Done / Not done; any other lot on the strip (Not todo, Do not touch) its sheet.
  const open = useCallback(
    (id: number): void => {
      setSelected(id);
      if (byId.has(id)) setFlow({ lotId: id, step: "choose" });
      else setSheet(id);
      setFollow(false);
      const l = overview.data?.lots.find((x) => x.id === id);
      if (map && l) map.panTo([l.lat, l.lng], { animate: true });
    },
    [byId, overview.data, map],
  );
  const flowLot = flow ? (byId.get(flow.lotId) ?? null) : null;
  const choose = (s: WrapChoice): void => {
    if (!flowLot) return;
    if (flowLot.status !== s) lotWrites.set({ lotId: flowLot.id, parcelId: null }, { status: s });
    // Only Done takes an After: a lot not finished looks the same as its Before.
    const camera = s === "done" && flowLot.hasBefore && !hasAfter(flowLot);
    setFlow(camera ? { lotId: flowLot.id, step: "camera" } : null);
  };
  const markers = useMemo<MapMarker[]>(() => {
    // Nothing until the list is in too: a first fit to the CC alone would still be zooming when the
    // list's fit comes, and Leaflet drops a setView during a zoom animation.
    if (!d || !wrap.data) return [];
    const out: MapMarker[] = [];
    for (const l of d.lots) {
      const status = pending.get(`l:${l.id}`) ?? l.status;
      out.push({
        id: `lot-${l.id}`,
        kind: "lot",
        lat: l.lat,
        lng: l.lng,
        status,
        geometry: l.geometry,
        parcelId: l.parcelId,
        mine: l.crewId !== null || status === "not_todo",
        selected: l.id === selected,
        // The strip fits to the listed lots; the rest are context.
        noFit: !shownIds.has(l.id),
        title: l.address ?? undefined,
        onClick: painting ? undefined : () => open(l.id),
      });
      const w = byId.get(l.id);
      if (w ? FILTERS.needsAfter(w) : l.needsAfter) {
        out.push({ id: `cam-${l.id}`, kind: "camera", lat: l.lat, lng: l.lng, noFit: true, title: l.address ?? undefined, onClick: painting ? undefined : () => open(l.id) });
      }
    }
    out.push({ id: "cc", kind: "cc", lat: d.cc.lat, lng: d.cc.lng, name: `CC ${d.cc.name}`, letter: d.cc.letter, noFit: shownIds.size > 0 });
    if (me) out.push({ id: "me", kind: "me", lat: me.lat, lng: me.lng, accuracy: me.accuracy, noFit: true });
    return out;
  }, [d, wrap.data, pending, byId, selected, shownIds, me, open, painting]);

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

  const failed = (overview.isError && !d) || (wrap.isError && !wrap.data);

  return (
    <div className="flex h-full min-h-[420px] flex-col">
      <div className={`relative h-[56dvh] min-h-[240px] shrink-0 border-b border-line ${painting ? "[&_.leaflet-container]:cursor-crosshair" : ""}`}>
        <MapView markers={markers} fitKey={fitKey} label="Wrap up map" className="absolute inset-0" onReady={setMap} />
        {(!d || !wrap.data) && <div aria-hidden="true" className="absolute inset-0 z-[500] animate-pulse bg-surface-2/60" />}
        <PaintFrame paint={paint} />
        <PaintBar paint={paint} crews={d?.crews ?? []} />
        {!painting && (
          <div className="pointer-events-none absolute right-3 bottom-3 left-3 z-[1000] flex flex-wrap justify-end gap-2">
            {me && !follow && (
              <Button
                variant="secondary"
                data-recenter
                className="pointer-events-auto shadow-lg"
                onClick={() => {
                  if (!map) return;
                  map.setView([me.lat, me.lng], Math.max(map.getZoom(), 17), { animate: true });
                  window.setTimeout(() => setFollow(true), 400);
                }}
              >
                <RecenterIcon />
                Recenter
              </Button>
            )}
            <Button
              variant="secondary"
              data-paint
              className="pointer-events-auto shadow-lg"
              onClick={() => {
                setFlow(null);
                paint.open();
              }}
              disabled={!d || !map}
            >
              <PaintIcon />
              Paint
            </Button>
          </div>
        )}
      </div>
      <div className="shrink-0 border-b border-line bg-surface px-3 py-2 nav:px-5">
        <Segmented
          tabs
          label="Lots"
          value={filter}
          onChange={setFilter}
          options={[
            { value: "needsAfter", label: "Needs After", count: counts.needsAfter },
            { value: "notDone", label: "Not done", count: counts.notDone },
            { value: "all", label: "All", count: counts.all },
          ]}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {failed ? (
          <EmptyState
            title="Lots not loaded"
            description="Check the connection"
            action={
              <Button
                onClick={() => {
                  void overview.refetch();
                  void wrap.refetch();
                }}
              >
                Retry
              </Button>
            }
          />
        ) : !wrap.data ? (
          <ul aria-hidden="true" className="divide-y divide-line">
            {[0, 1, 2, 3].map((i) => (
              <li key={i} className="h-[56px] animate-pulse bg-surface-2/40" />
            ))}
          </ul>
        ) : rows.length === 0 ? (
          <EmptyState title={filter === "needsAfter" ? "All Afters taken" : filter === "notDone" ? "All lots done" : "No work lots"} />
        ) : (
          <ul data-wrap-list className="mx-auto max-w-3xl divide-y divide-line">
            {rows.map(({ lot, m }) => (
              <li key={lot.id}>
                <button
                  type="button"
                  data-wrap-lot={lot.id}
                  onClick={() => open(lot.id)}
                  className={`flex w-full min-w-0 items-center gap-2.5 px-3 py-1.5 text-left nav:px-5 ${lot.id === selected ? "bg-surface-2" : "hover:bg-surface-2"}`}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold">{lotTitle(lot)}</span>
                    <span className="mt-0.5 flex min-w-0 items-center gap-2">
                      <StatusPill status={lotPill(lot.status)} />
                      <span className="truncate text-sm text-muted">{lot.crewName ?? "No crew"}</span>
                    </span>
                  </span>
                  <PhotoMark kind="Before" thumb={lot.beforeThumb} />
                  <PhotoMark kind="After" thumb={lot.afterThumb} queued={lot.queued} />
                  <span className="w-14 shrink-0 text-right text-sm font-semibold whitespace-nowrap text-muted tabular-nums">{m !== null ? distance(m) : ""}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <LotSheet parcel={sheetParcel} crews={d?.crews ?? []} lots={lotWrites} onClose={() => setSheet(null)} />
      <WrapChooser
        open={flow?.step === "choose" && flowLot !== null}
        title={flowLot ? lotTitle(flowLot) : ""}
        status={flowLot?.status ?? null}
        onChoose={choose}
        onDetails={() => {
          if (!flowLot) return;
          setFlow(null);
          setSheet(flowLot.id);
        }}
        onClose={() => setFlow(null)}
      />
      {flow?.step === "camera" && flowLot && (
        <AfterCamera
          title={lotTitle(flowLot)}
          onShot={(blobs) => {
            queueAfter(flowLot.id, blobs, me);
            setFlow(null);
          }}
          onClose={() => setFlow(null)}
        />
      )}
    </div>
  );
};
