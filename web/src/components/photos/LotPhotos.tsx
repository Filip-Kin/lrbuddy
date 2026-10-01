import { useState } from "react";
import { trpc } from "../../lib/trpc.ts";
import { Button } from "../Button.tsx";
import { Skeleton } from "../Skeleton.tsx";
import { PhotoSlot } from "./PhotoSlot.tsx";
import { PhotoViewer } from "./PhotoViewer.tsx";

/** Before and After tiles side by side for one lot, with the viewer behind a tap. */
export const LotPhotos = ({ lotId }: { lotId: number }) => {
  const q = trpc.shared.lotPhotos.useQuery({ lotId });
  const [viewing, setViewing] = useState<number | null>(null);
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
