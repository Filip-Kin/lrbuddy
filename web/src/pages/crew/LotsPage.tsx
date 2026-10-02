import { useMemo, useState } from "react";
import { Button, ButtonLink } from "../../components/Button.tsx";
import { EmptyState } from "../../components/EmptyState.tsx";
import { lotTitle, type CrewLot } from "../../components/crew/format.ts";
import { DirectionsIcon } from "../../components/crew/Icons.tsx";
import { LotStatusControl, useSetLot, type LotStatus } from "../../components/LotStatusControl.tsx";
import { ParcelSheet } from "../../components/ParcelSheet.tsx";
import { PhotoSlot } from "../../components/photos/PhotoSlot.tsx";
import { PhotoViewer } from "../../components/photos/PhotoViewer.tsx";
import { SkeletonList } from "../../components/Skeleton.tsx";
import { Page } from "../../components/Page.tsx";
import { lotPill, StatusPill } from "../../components/StatusPill.tsx";
import { distance, mapsDirections } from "../../lib/format.ts";
import { STATUS_LABEL } from "../../lib/lotStatus.ts";
import { trpc } from "../../lib/trpc.ts";

const COUNT_ORDER: LotStatus[] = ["open", "in_progress", "done", "not_done", "do_not_touch"];

const LotRow = ({
  lot,
  onStatus,
  error,
  onOpen,
  onPhoto,
}: {
  lot: CrewLot;
  onStatus: (s: LotStatus) => void;
  error: string | null;
  onOpen: () => void;
  onPhoto: (photoId: number) => void;
}) => (
  <li className="rounded-2xl bg-surface p-3 ring-1 ring-line">
    <div className="flex items-start gap-2">
      <div className="min-w-0 flex-1 pt-0.5">
        <h3 className="text-lg leading-snug font-bold break-words">
          <button type="button" onClick={onOpen} className="min-h-10 text-left underline-offset-4 hover:underline">
            {lotTitle(lot)}
          </button>
        </h3>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted">
          <StatusPill status={lotPill(lot.status)} />
          <span className="tabular-nums">{distance(lot.distanceM)}</span>
        </div>
      </div>
      <a
        href={mapsDirections(lot.lat, lot.lng)}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`Directions to ${lotTitle(lot)}`}
        className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-surface-2 text-ink ring-1 ring-inset ring-line active:brightness-95"
      >
        <DirectionsIcon size={22} />
      </a>
    </div>
    <div className="mt-3 flex items-start gap-2">
      <PhotoSlot size="inline" lotId={lot.id} kind="before" photoId={lot.photos.before} canAdd onOpen={onPhoto} address={lotTitle(lot)} />
      <PhotoSlot size="inline" lotId={lot.id} kind="after" photoId={lot.photos.after} canAdd onOpen={onPhoto} address={lotTitle(lot)} />
    </div>
    <div className="mt-3">
      <LotStatusControl status={lot.status} onChange={onStatus} label={`Status of ${lotTitle(lot)}`} />
    </div>
    {error && (
      <p role="alert" className="mt-2 text-sm font-semibold">
        {error}
      </p>
    )}
  </li>
);

export const LotsPage = () => {
  const q = trpc.crew.lots.useQuery(undefined, { refetchInterval: 60_000 });
  const status = useSetLot("crew");
  const lots = useMemo(() => (q.data ?? []).map((l) => ({ ...l, status: status.pending.get(`l:${l.id}`) ?? l.status })), [q.data, status.pending]);
  const counts = useMemo(() => {
    const c: Record<LotStatus, number> = { open: 0, in_progress: 0, done: 0, not_done: 0, do_not_touch: 0, not_todo: 0 };
    for (const l of lots) c[l.status] += 1;
    return c;
  }, [lots]);
  const [sheetId, setSheetId] = useState<number | null>(null);
  const [viewing, setViewing] = useState<{ lotId: number; photoId: number } | null>(null);
  const sheetLot = lots.find((l) => l.id === sheetId);
  const hasArea = trpc.crew.hasArea.useQuery().data ?? false;
  const assigned = lots.length > 0 && lots[0]!.mine;

  let body;
  if (q.isLoading) body = <SkeletonList rows={4} className="h-36" />;
  else if (q.isError)
    body = (
      <EmptyState
        title="Lots not loaded"
        action={
          <Button variant="secondary" onClick={() => void q.refetch()}>
            Retry
          </Button>
        }
      />
    );
  else if (lots.length === 0)
    body = (
      <EmptyState
        title="No lots nearby"
        action={
          <ButtonLink href="/cc" variant="secondary">
            Command center
          </ButtonLink>
        }
      />
    );
  else
    body = (
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="mr-1 text-sm font-bold tracking-wide text-muted uppercase">{hasArea ? "Area" : assigned ? "Assigned" : "Within 400 m"}</span>
          {COUNT_ORDER.filter((s) => counts[s] > 0).map((s) => (
            <StatusPill key={s} status={lotPill(s)} label={`${STATUS_LABEL[s]} ${counts[s]}`} className="text-sm" />
          ))}
        </div>
        <ul className="space-y-3">
          {lots.map((l) => (
            <LotRow
              key={l.id}
              lot={l}
              onStatus={(s) => status.set({ lotId: l.id, parcelId: null }, { status: s })}
              error={status.errorFor === `l:${l.id}` ? status.error : null}
              onOpen={() => setSheetId(l.id)}
              onPhoto={(photoId) => setViewing({ lotId: l.id, photoId })}
            />
          ))}
        </ul>
      </div>
    );

  return (
    <Page title="Lots">
      {body}
      <ParcelSheet
        parcel={sheetLot ? { lotId: sheetLot.id, parcelId: sheetLot.parcelId, address: sheetLot.address, status: sheetLot.status, grade: sheetLot.grade, note: sheetLot.note } : null}
        onClose={() => setSheetId(null)}
        onSet={status.set}
        ensureLot={status.ensure}
        error={status.error}
        errorFor={status.errorFor}
        crew={
          sheetLot && (
            <div className="flex flex-wrap items-center gap-2 text-sm text-muted">
              <span>{distance(sheetLot.distanceM)}</span>
              <span>{sheetLot.mine ? "Assigned" : "Nearby"}</span>
            </div>
          )
        }
      >
        {sheetLot && (
          <ButtonLink href={mapsDirections(sheetLot.lat, sheetLot.lng)} variant="secondary" block>
            <DirectionsIcon size={20} />
            Directions
          </ButtonLink>
        )}
      </ParcelSheet>
      {viewing && <PhotoViewer lotId={viewing.lotId} startId={viewing.photoId} onClose={() => setViewing(null)} />}
    </Page>
  );
};
