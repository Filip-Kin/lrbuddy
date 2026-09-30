import { useState } from "react";
import { Link } from "wouter";
import { Button } from "../../components/Button.tsx";
import { EmptyState } from "../../components/EmptyState.tsx";
import { Page } from "../../components/Page.tsx";
import { Sheet } from "../../components/Sheet.tsx";
import { StatusPill } from "../../components/StatusPill.tsx";
import { CancelSheet } from "../../components/driver/CancelSheet.tsx";
import { useDriverActions, useNewStopBuzz, useNow, useWakeLock, type DriverQueue } from "../../components/driver/hooks.ts";
import { TruckIcon } from "../../components/driver/icons.tsx";
import { QueueSkeleton } from "../../components/driver/Skeleton.tsx";
import { CcStopCard, NextStopCard, StopDetails, StopRow } from "../../components/driver/StopCard.tsx";
import { distance, duration } from "../../lib/format.ts";
import { trpc } from "../../lib/trpc.ts";

const summary = (q: DriverQueue): string | null => {
  const n = q.stops.length;
  if (n === 0) return null;
  const parts = [n === 1 ? "1 stop" : `${n} stops`];
  if (q.route && q.route.distanceM > 0) parts.push(distance(q.route.distanceM), duration(q.route.durationS * 1000));
  return parts.join(" · ");
};

export const QueuePage = () => {
  useWakeLock();
  const now = useNow();
  const q = trpc.driver.queue.useQuery(undefined, { refetchInterval: 30_000 });
  useNewStopBuzz(q.data?.stops);
  const actions = useDriverActions();
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [cancelKey, setCancelKey] = useState<string | null>(null);

  const data = q.data;
  const stops = data?.stops ?? [];
  const openIdx = stops.findIndex((s) => s.key === openKey);
  const open = openIdx >= 0 ? stops[openIdx]! : null;
  const cancelStop = stops.find((s) => s.key === cancelKey) ?? null;
  const [next, ...later] = stops;
  // Parked at the CC with room on the truck: offer Restocked without the Restock round trip.
  const showCc = !!data && (data.returning || (data.atCc && data.belowCapacity));

  const headerActions = data && (
    <>
      {data.lowStock && (
        <Link href="/stock" className="inline-flex min-h-10 items-center" aria-label="Low stock, open Stock">
          <StatusPill status="low" />
        </Link>
      )}
      {data.returning ? (
        <StatusPill status="returning" />
      ) : (
        <Button variant={data.lowStock ? "primary" : "secondary"} busy={actions.setReturning.isPending} onClick={() => actions.setReturning.mutate({ returning: true })}>
          Restock
        </Button>
      )}
    </>
  );

  return (
    <Page title="Queue" actions={headerActions}>
      {q.isLoading ? (
        <QueueSkeleton />
      ) : q.isError || !data ? (
        <EmptyState
          title="Queue not loaded"
          action={
            <Button variant="secondary" onClick={() => void q.refetch()}>
              Retry
            </Button>
          }
        />
      ) : (
        <div className="space-y-4">
          {summary(data) && <p className="-mt-2 text-sm font-semibold text-muted">{summary(data)}</p>}

          {next ? (
            <NextStopCard stop={next} n={0} heading="Next stop" actions={actions} now={now} onCancel={() => setCancelKey(next.key)} />
          ) : showCc ? null : (
            <EmptyState icon={<TruckIcon size={40} />} title="No stops" />
          )}

          {later.length > 0 && (
            <section aria-labelledby="later-h" className="space-y-2">
              <h2 id="later-h" className="text-sm font-bold text-muted">
                After that
              </h2>
              <ol className="space-y-2">
                {later.map((s, i) => (
                  <li key={s.key}>
                    <StopRow stop={s} n={i + 2} now={now} onOpen={() => setOpenKey(s.key)} />
                  </li>
                ))}
              </ol>
            </section>
          )}

          {showCc && <CcStopCard q={data} actions={actions} now={now} next={!next} />}
        </div>
      )}

      <Sheet open={!!open} onClose={() => setOpenKey(null)} title={open ? `Stop ${openIdx + 1}` : "Stop"}>
        {open && (
          <div className="pb-2">
            <StopDetails
              stop={open}
              n={0}
              heading=""
              actions={actions}
              now={now}
              onCancel={() => {
                setOpenKey(null);
                setCancelKey(open.key);
              }}
            />
          </div>
        )}
      </Sheet>
      <CancelSheet stop={cancelStop} actions={actions} onClose={() => setCancelKey(null)} />
    </Page>
  );
};
