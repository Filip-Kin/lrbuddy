import { useState } from "react";
import { trpc } from "../../lib/trpc.ts";
import { Button } from "../Button.tsx";
import { Skeleton } from "../Skeleton.tsx";
import { PhotoSlot } from "./PhotoSlot.tsx";
import { PhotoViewer } from "./PhotoViewer.tsx";

const noOpen = (): void => undefined;

/**
 * Before and After tiles side by side for one lot, with the viewer behind a
 * tap. A bare parcel (`lotId` null) gets both tiles too: `ensureLot` makes it
 * a Todo lot before the first photo goes up.
 */
export const LotPhotos = ({ lotId, ensureLot }: { lotId: number | null; ensureLot?: () => Promise<number> }) => {
  const q = trpc.shared.lotPhotos.useQuery({ lotId: lotId ?? 0 }, { enabled: lotId !== null });
  const [viewing, setViewing] = useState<number | null>(null);
  // Same tree for a bare parcel and for its new lot while the photos load, so an upload under way keeps its tile.
  if (ensureLot && (lotId === null || q.isLoading)) {
    const ref = lotId ?? ensureLot;
    return (
      <section aria-label="Photos" className="grid grid-cols-2 gap-3">
        <PhotoSlot lotId={ref} kind="before" photoId={null} canAdd onOpen={noOpen} />
        <PhotoSlot lotId={ref} kind="after" photoId={null} canAdd onOpen={noOpen} />
      </section>
    );
  }
  if (lotId === null) return null;
  if (q.isLoading) {
    return (
      <div className="grid grid-cols-2 gap-3" aria-busy="true">
        <Skeleton className="aspect-[4/3] rounded-2xl" />
        <Skeleton className="aspect-[4/3] rounded-2xl" />
      </div>
    );
  }
  if (q.isError || !q.data) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-2xl bg-surface-2 px-4 py-3">
        <span className="font-semibold">Photos not loaded</span>
        <Button variant="secondary" size="sm" onClick={() => void q.refetch()}>
          Retry
        </Button>
      </div>
    );
  }
  const newest = (kind: "before" | "after"): number | null => q.data.photos.find((p) => p.kind === kind)?.id ?? null;
  return (
    <section aria-label="Photos" className="grid grid-cols-2 gap-3">
      <PhotoSlot lotId={lotId} kind="before" photoId={newest("before")} canAdd={q.data.canAdd} onOpen={setViewing} />
      <PhotoSlot lotId={lotId} kind="after" photoId={newest("after")} canAdd={q.data.canAdd} onOpen={setViewing} />
      {viewing !== null && <PhotoViewer lotId={lotId} startId={viewing} onClose={() => setViewing(null)} />}
    </section>
  );
};
