import { useState } from "react";
import { dateTime, lotTitle } from "../../lib/format.ts";
import { KIND_LABEL, photoUrl, type PhotoKind } from "../../lib/photos.ts";
import type { RouterOutputs } from "../../lib/trpc.ts";
import { Button } from "../Button.tsx";
import { EmptyState } from "../EmptyState.tsx";
import { Skeleton } from "../Skeleton.tsx";
import { lotPill, StatusPill } from "../StatusPill.tsx";
import { CameraIcon } from "./icons.tsx";
import { PhotoViewer } from "./PhotoViewer.tsx";

export type Pair = RouterOutputs["green"]["photos"]["pairs"][number];

const Half = ({ pair, kind }: { pair: Pair; kind: PhotoKind }) => {
  const p = pair[kind];
  return (
    <div className="relative aspect-[4/3] bg-surface-2">
      {p ? (
        <img src={photoUrl(p.id, true)} alt="" loading="lazy" className="h-full w-full object-cover" />
      ) : (
        <span className="absolute inset-0 grid place-items-center text-sm font-semibold text-muted">{`No ${kind}`}</span>
      )}
      <span className="absolute top-1.5 left-1.5 rounded-full bg-black/65 px-2 py-0.5 text-xs font-semibold text-white">{KIND_LABEL[kind]}</span>
    </div>
  );
};

const PairCard = ({ pair, onOpen }: { pair: Pair; onOpen: () => void }) => {
  const title = lotTitle(pair);
  const who = [pair.crewName, pair.companyName].filter(Boolean).join(", ");
  return (
    <li className="min-w-0">
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Photos, ${title}`}
        className="block w-full overflow-hidden rounded-2xl bg-surface text-left ring-1 ring-line hover:ring-ink/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
      >
        <div className="grid grid-cols-2 gap-0.5 bg-line">
          <Half pair={pair} kind="before" />
          <Half pair={pair} kind="after" />
        </div>
        <div className="space-y-1 p-3">
          <div className="font-bold break-words">{title}</div>
          <div className="truncate text-sm text-muted">{who || "No crew"}</div>
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted">
            <StatusPill status={lotPill(pair.status)} />
            <span>{dateTime(pair.latestAt)}</span>
          </div>
        </div>
      </button>
    </li>
  );
};

/** Pairs newest first, the viewer behind a tap. Loading, error, empty and filtered-empty each have their own state. */
export const PhotoGallery = ({
  pairs,
  total,
  isLoading,
  isError,
  onRetry,
  onClearFilters,
}: {
  pairs: readonly Pair[] | undefined;
  total: number;
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  onClearFilters: () => void;
}) => {
  const [viewing, setViewing] = useState<{ lotId: number; photoId: number } | null>(null);
  if (isLoading) {
    return (
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-busy="true">
        {Array.from({ length: 3 }, (_, i) => (
          <Skeleton key={i} className="h-64 rounded-2xl" />
        ))}
      </div>
    );
  }
  if (isError || !pairs) return <EmptyState title="Photos not loaded" action={<Button onClick={onRetry}>Retry</Button>} />;
  if (total === 0) return <EmptyState icon={<CameraIcon size={40} />} title="No photos yet" />;
  if (pairs.length === 0)
    return (
      <EmptyState
        title="No pairs match"
        action={
          <Button variant="secondary" onClick={onClearFilters}>
            Clear filters
          </Button>
        }
      />
    );
  return (
    <>
      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {pairs.map((p) => (
          <PairCard key={p.lotId} pair={p} onOpen={() => setViewing({ lotId: p.lotId, photoId: (p.before ?? p.after)!.id })} />
        ))}
      </ul>
      {viewing && <PhotoViewer lotId={viewing.lotId} startId={viewing.photoId} onClose={() => setViewing(null)} />}
    </>
  );
};
