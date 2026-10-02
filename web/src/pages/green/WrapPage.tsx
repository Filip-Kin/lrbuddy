import type { Map as LeafletMap } from "leaflet";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "../../components/Button.tsx";
import { EmptyState } from "../../components/EmptyState.tsx";
import { RecenterIcon } from "../../components/driver/icons.tsx";
import { LotSheet, type GreenParcel } from "../../components/green/MapSheets.tsx";
import { useSetLot } from "../../components/LotStatusControl.tsx";
import { CameraIcon } from "../../components/photos/icons.tsx";
import { Segmented } from "../../components/Segmented.tsx";
import { lotPill, StatusPill } from "../../components/StatusPill.tsx";
import { distance, lotTitle } from "../../lib/format.ts";
import { MapView, type MapMarker } from "../../lib/map/MapView.tsx";
import { photoUrl } from "../../lib/photos.ts";
import { geolocation } from "../../lib/safe.ts";
import { trpc, type RouterOutputs } from "../../lib/trpc.ts";
import { distanceM } from "../plan/survey/geo.ts";

type WrapLot = RouterOutputs["green"]["wrap"][number];
type Filter = "needsAfter" | "notDone" | "all";
const NONE: readonly WrapLot[] = [];

const FILTERS: Record<Filter, (l: WrapLot) => boolean> = {
  needsAfter: (l) => l.hasBefore && !l.hasAfter,
  notDone: (l) => l.status === "open" || l.status === "in_progress",
  all: () => true,
};

/** One photo kind on a row: the newest thumb when taken, a hollow camera when missing. */
const PhotoMark = ({ kind, thumb }: { kind: "Before" | "After"; thumb: number | null }) => (
  <span data-photo={kind.toLowerCase()} data-taken={thumb !== null} className="flex flex-col items-center gap-0.5">
    {thumb !== null ? (
      <img src={photoUrl(thumb, true)} alt={kind} loading="lazy" className="h-8 w-8 rounded-md bg-surface-2 object-cover ring-1 ring-line" />
    ) : (
      <span role="img" aria-label={`No ${kind.toLowerCase()}`} className="grid h-8 w-8 place-items-center rounded-md text-muted ring-1 ring-inset ring-line ring-dashed">
        <CameraIcon size={16} />
      </span>
    )}
    <span className="text-[10px] leading-none font-semibold text-muted">{kind}</span>
  </span>
);

/**
 * Wrap up: the After photo round at the end of the day. A map strip with the lots, the camera
 * badge on lots with a Before and no After, and the blue dot; below it the work lots nearest
 * first. A row opens the lot sheet, whose After tile is one tap from the camera.
 */
export const WrapPage = () => {
  const overview = trpc.green.overview.useQuery(undefined, { refetchInterval: 30_000 });
  const wrap = trpc.green.wrap.useQuery(undefined, { refetchInterval: 60_000 });
  const lotWrites = useSetLot("green");
  const [filter, setFilter] = useState<Filter>("needsAfter");
  // The highlighted lot stays highlighted after its sheet closes.
  const [selected, setSelected] = useState<number | null>(null);
  const [sheet, setSheet] = useState<number | null>(null);
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

  const d = overview.data;
  const all = wrap.data ?? NONE;
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
  const open = useCallback(
    (id: number): void => {
      setSelected(id);
      setSheet(id);
      setFollow(false);
      const l = overview.data?.lots.find((x) => x.id === id);
      if (map && l) map.panTo([l.lat, l.lng], { animate: true });
    },
    [overview.data, map],
  );
  const markers = useMemo<MapMarker[]>(() => {
    // Nothing until the list is in too: a first fit to the CC alone would still be zooming when the
    // list's fit comes, and Leaflet drops a setView during a zoom animation.
    if (!d || !wrap.data) return [];
    const out: MapMarker[] = [];
    for (const l of d.lots) {
      const status = lotWrites.pending.get(`l:${l.id}`) ?? l.status;
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
        onClick: () => open(l.id),
      });
      if (l.needsAfter) {
        out.push({ id: `cam-${l.id}`, kind: "camera", lat: l.lat, lng: l.lng, noFit: true, title: l.address ?? undefined, onClick: () => open(l.id) });
      }
    }
    out.push({ id: "cc", kind: "cc", lat: d.cc.lat, lng: d.cc.lng, name: `CC ${d.cc.name}`, letter: d.cc.letter, noFit: shownIds.size > 0 });
    if (me) out.push({ id: "me", kind: "me", lat: me.lat, lng: me.lng, accuracy: me.accuracy, noFit: true });
    return out;
  }, [d, wrap.data, lotWrites.pending, selected, shownIds, me, open]);

  const sheetLot = sheet !== null ? (d?.lots.find((l) => l.id === sheet) ?? null) : null;
  const sheetParcel: GreenParcel | null = sheetLot
    ? {
        lotId: sheetLot.id,
        parcelId: sheetLot.parcelId,
        address: sheetLot.address,
        status: lotWrites.pending.get(`l:${sheetLot.id}`) ?? sheetLot.status,
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
      <div className="relative h-[56dvh] min-h-[240px] shrink-0 border-b border-line">
        <MapView markers={markers} fitKey={fitKey} label="Wrap up map" className="absolute inset-0" onReady={setMap} />
        {(!d || !wrap.data) && <div aria-hidden="true" className="absolute inset-0 z-[500] animate-pulse bg-surface-2/60" />}
        {me && !follow && (
          <div className="pointer-events-none absolute right-3 bottom-3 z-[1000]">
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
                  <PhotoMark kind="After" thumb={lot.afterThumb} />
                  <span className="w-14 shrink-0 text-right text-sm font-semibold whitespace-nowrap text-muted tabular-nums">{m !== null ? distance(m) : ""}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <LotSheet parcel={sheetParcel} crews={d?.crews ?? []} lots={lotWrites} onClose={() => setSheet(null)} />
    </div>
  );
};
