import { useMemo } from "react";
import { Button, ButtonLink } from "../../components/Button.tsx";
import { EmptyState } from "../../components/EmptyState.tsx";
import { lotTitle, type CrewLot } from "../../components/crew/format.ts";
import { DirectionsIcon } from "../../components/crew/Icons.tsx";
import { LotStatusControl, useLotStatus, type LotStatus } from "../../components/crew/LotStatusControl.tsx";
import { SkeletonList } from "../../components/Skeleton.tsx";
import { Page } from "../../components/Page.tsx";
import { lotPill, StatusPill } from "../../components/StatusPill.tsx";
import { distance, mapsDirections } from "../../lib/format.ts";
import { trpc } from "../../lib/trpc.ts";

const COUNT_ORDER: LotStatus[] = ["done", "in_progress", "open", "skipped"];
const COUNT_LABEL: Record<LotStatus, string> = { done: "Done", in_progress: "In progress", open: "Open", skipped: "Skipped" };

const LotRow = ({ lot, onStatus, error }: { lot: CrewLot; onStatus: (s: LotStatus) => void; error: string | null }) => (
  <li className="rounded-2xl bg-surface p-3 ring-1 ring-line">
    <div className="flex items-start gap-2">
      <div className="min-w-0 flex-1 pt-0.5">
        <h3 className="text-lg leading-snug font-bold break-words">{lotTitle(lot)}</h3>
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
  const status = useLotStatus();
  const counts = useMemo(() => {
    const c: Record<LotStatus, number> = { open: 0, in_progress: 0, done: 0, skipped: 0 };
    for (const l of q.data ?? []) c[l.status] += 1;
    return c;
  }, [q.data]);
  const lots = q.data ?? [];
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
          <span className="mr-1 text-sm font-bold tracking-wide text-muted uppercase">{assigned ? "Assigned" : "Within 400 m"}</span>
          {COUNT_ORDER.filter((s) => counts[s] > 0).map((s) => (
            <StatusPill key={s} status={lotPill(s)} label={`${COUNT_LABEL[s]} ${counts[s]}`} className="text-sm" />
          ))}
        </div>
        <ul className="space-y-3">
          {lots.map((l) => (
            <LotRow key={l.id} lot={l} onStatus={(s) => status.set(l.id, s)} error={status.errorFor === l.id ? status.error : null} />
          ))}
        </ul>
      </div>
    );

  return <Page title="Lots">{body}</Page>;
};
