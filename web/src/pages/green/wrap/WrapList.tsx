import { useMemo } from "react";
import { Button } from "../../../components/Button.tsx";
import { EmptyState } from "../../../components/EmptyState.tsx";
import { CameraIcon } from "../../../components/photos/icons.tsx";
import { Segmented } from "../../../components/Segmented.tsx";
import { Sheet } from "../../../components/Sheet.tsx";
import { lotPill, StatusPill } from "../../../components/StatusPill.tsx";
import { distance, lotTitle } from "../../../lib/format.ts";
import type { LotStatus } from "../../../lib/lotStatus.ts";
import { photoUrl } from "../../../lib/photos.ts";
import { tirePhotoUrl, type TirePile } from "../../../lib/tires.ts";
import { TireGlyph } from "../../../components/TirePile.tsx";
import type { RouterOutputs } from "../../../lib/trpc.ts";
import { metres, type LatLng } from "../flag/pick.ts";
import type { QueuedAfter } from "./afterQueue.ts";

/** A wrap lot with this phone's unsent writes on it: a status tap or stroke, an After still in the queue. */
export type WrapLot = Omit<RouterOutputs["green"]["wrap"][number], "status"> & { status: LotStatus; queued: QueuedAfter | null };
export type Filter = "needsAfter" | "notDone" | "all";

/** A tire pile in Wrap up (SPEC 29) with its photo still in the queue, if any. */
export type WrapTire = TirePile & { queued: QueuedAfter | null };

/** A pile needs its photo until one is taken or on its way. */
export const tireNeedsPhoto = (t: WrapTire): boolean => t.photoAt === null && (t.queued === null || t.queued.phase === "failed");

/** An After on its way counts as taken; one the server refused does not. */
export const hasAfter = (l: WrapLot): boolean => l.hasAfter || (l.queued !== null && l.queued.phase !== "failed");

export const FILTERS: Record<Filter, (l: WrapLot) => boolean> = {
  // A Not done lot needs no After: nothing changed on it.
  needsAfter: (l) => l.hasBefore && !hasAfter(l) && l.status !== "not_done",
  notDone: (l) => l.status !== "done",
  all: () => true,
};

/** One photo kind on a row: the newest thumb when taken (or the local one while it uploads), a hollow camera when missing. */
const PhotoMark = ({ kind, thumb, queued = null }: { kind: "Before" | "After" | "Photo"; thumb: number | string | null; queued?: QueuedAfter | null }) => (
  <span data-photo={kind.toLowerCase()} data-taken={thumb !== null || (queued !== null && queued.phase !== "failed")} data-upload={thumb === null && queued ? queued.phase : undefined} className="flex flex-col items-center gap-0.5">
    {thumb !== null ? (
      <img src={typeof thumb === "string" ? thumb : photoUrl(thumb, true)} alt={kind} loading="lazy" className="h-8 w-8 rounded-md bg-surface-2 object-cover ring-1 ring-line" />
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

/** A work lot's row: address, status, crew, Before and After marks, distance. */
const WrapLotRow = ({ lot, m, picked, onPick }: { lot: WrapLot; m: number | null; picked: number | null; onPick: (id: number) => void }) => (
  <li>
    <button
      type="button"
      data-wrap-lot={lot.id}
      aria-current={lot.id === picked ? "true" : undefined}
      onClick={() => onPick(lot.id)}
      className={`flex w-full min-w-0 items-center gap-2.5 px-3 py-1.5 text-left ${lot.id === picked ? "bg-surface-2" : "hover:bg-surface-2"}`}
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
);

/**
 * Wrap up's list behind the strip's List button (SPEC 28): Needs After, Not done and All, nearest
 * first from the phone, tire piles with them (SPEC 29). A tap on a row picks that lot or pile for the camera and closes the sheet.
 */
export const WrapList = ({
  open,
  onClose,
  lots,
  loaded,
  failed,
  onRetry,
  filter,
  onFilter,
  me,
  picked,
  onPick,
  tires,
  pickedTire,
  onPickTire,
}: {
  open: boolean;
  onClose: () => void;
  lots: readonly WrapLot[];
  loaded: boolean;
  failed: boolean;
  onRetry: () => void;
  filter: Filter;
  onFilter: (f: Filter) => void;
  me: LatLng | null;
  picked: number | null;
  onPick: (id: number) => void;
  /** Tire piles: in Needs After until their photo is taken, and in All (SPEC 29). */
  tires: readonly WrapTire[];
  pickedTire: number | null;
  onPickTire: (id: number) => void;
}) => {
  const tiresFor = (f: Filter): WrapTire[] => (f === "needsAfter" ? tires.filter(tireNeedsPhoto) : f === "all" ? [...tires] : []);
  const counts = useMemo(
    () => ({
      needsAfter: lots.filter(FILTERS.needsAfter).length + tires.filter(tireNeedsPhoto).length,
      notDone: lots.filter(FILTERS.notDone).length,
      all: lots.length + tires.length,
    }),
    [lots, tires],
  );
  // Nearest first from the phone; with no position, by address, tire piles last.
  type Row = { kind: "lot"; lot: WrapLot; m: number | null } | { kind: "tire"; tire: WrapTire; m: number | null };
  const rows = useMemo<Row[]>(() => {
    const shown: Row[] = [...lots.filter(FILTERS[filter]).map((l): Row => ({ kind: "lot", lot: l, m: me ? metres(me, l) : null })), ...tiresFor(filter).map((t): Row => ({ kind: "tire", tire: t, m: me ? metres(me, t) : null }))];
    const title = (r: Row): string => (r.kind === "lot" ? lotTitle(r.lot) : "~");
    return me ? shown.sort((a, b) => (a.m ?? 0) - (b.m ?? 0)) : shown.sort((a, b) => title(a).localeCompare(title(b), "en", { numeric: true }));
  }, [lots, tires, filter, me]);
  return (
    <Sheet open={open} onClose={onClose} title="Lots">
      <div data-wrap-sheet className="-mx-5">
        <div className="sticky top-0 z-10 border-b border-line bg-surface px-3 pb-2">
          <Segmented
            tabs
            label="Lots"
            value={filter}
            onChange={onFilter}
            options={[
              { value: "needsAfter", label: "Needs After", count: counts.needsAfter },
              { value: "notDone", label: "Not done", count: counts.notDone },
              { value: "all", label: "All", count: counts.all },
            ]}
          />
        </div>
        {failed ? (
          <EmptyState title="Lots not loaded" description="Check the connection" action={<Button onClick={onRetry}>Retry</Button>} />
        ) : !loaded ? (
          <ul aria-hidden="true" className="divide-y divide-line">
            {[0, 1, 2, 3].map((i) => (
              <li key={i} className="h-[56px] animate-pulse bg-surface-2/40" />
            ))}
          </ul>
        ) : rows.length === 0 ? (
          <EmptyState title={filter === "needsAfter" ? "All Afters taken" : filter === "notDone" ? "All lots done" : "No work lots"} />
        ) : (
          <ul data-wrap-list className="divide-y divide-line">
            {rows.map((r) =>
              r.kind === "tire" ? (
                <li key={`t${r.tire.id}`}>
                  <button
                    type="button"
                    data-wrap-tire={r.tire.id}
                    aria-current={r.tire.id === pickedTire ? "true" : undefined}
                    onClick={() => onPickTire(r.tire.id)}
                    className={`flex w-full min-w-0 items-center gap-2.5 px-3 py-1.5 text-left ${r.tire.id === pickedTire ? "bg-surface-2" : "hover:bg-surface-2"}`}
                  >
                    <TireGlyph size={28} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold">Tire pile</span>
                      <span className="mt-0.5 block truncate text-sm text-muted">{r.tire.madeBy}</span>
                    </span>
                    <PhotoMark kind="Photo" thumb={r.tire.photoAt !== null ? tirePhotoUrl(r.tire, true) : null} queued={r.tire.queued} />
                    <span className="w-14 shrink-0 text-right text-sm font-semibold whitespace-nowrap text-muted tabular-nums">{r.m !== null ? distance(r.m) : ""}</span>
                  </button>
                </li>
              ) : (
                <WrapLotRow key={r.lot.id} lot={r.lot} m={r.m} picked={picked} onPick={onPick} />
              ),
            )}
          </ul>
        )}
      </div>
    </Sheet>
  );
};
