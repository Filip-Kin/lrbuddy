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
import type { RouterOutputs } from "../../../lib/trpc.ts";
import { metres, type LatLng } from "../flag/pick.ts";
import type { QueuedAfter } from "./afterQueue.ts";

/** A wrap lot with this phone's unsent writes on it: a status tap or stroke, an After still in the queue. */
export type WrapLot = Omit<RouterOutputs["green"]["wrap"][number], "status"> & { status: LotStatus; queued: QueuedAfter | null };
export type Filter = "needsAfter" | "notDone" | "all";

/** An After on its way counts as taken; one the server refused does not. */
export const hasAfter = (l: WrapLot): boolean => l.hasAfter || (l.queued !== null && l.queued.phase !== "failed");

export const FILTERS: Record<Filter, (l: WrapLot) => boolean> = {
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
 * Wrap up's list behind the strip's List button (SPEC 28): Needs After, Not done and All, nearest
 * first from the phone. A tap on a row picks that lot for the camera and closes the sheet.
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
}) => {
  const counts = useMemo(
    () => ({ needsAfter: lots.filter(FILTERS.needsAfter).length, notDone: lots.filter(FILTERS.notDone).length, all: lots.length }),
    [lots],
  );
  // Nearest first from the phone; with no position, by address.
  const rows = useMemo(() => {
    const shown = lots.filter(FILTERS[filter]).map((l) => ({ lot: l, m: me ? metres(me, l) : null }));
    return me
      ? shown.sort((a, b) => (a.m ?? 0) - (b.m ?? 0))
      : shown.sort((a, b) => lotTitle(a.lot).localeCompare(lotTitle(b.lot), "en", { numeric: true }));
  }, [lots, filter, me]);
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
            {rows.map(({ lot, m }) => (
              <li key={lot.id}>
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
            ))}
          </ul>
        )}
      </div>
    </Sheet>
  );
};
