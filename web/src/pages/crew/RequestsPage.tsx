import { useMemo, useState, type ReactNode } from "react";
import { Button, ButtonLink } from "../../components/Button.tsx";
import { EmptyState } from "../../components/EmptyState.tsx";
import { crewCanCancel, isActive, qtyText, type CrewRequest } from "../../components/crew/format.ts";
import { PlusIcon } from "../../components/crew/Icons.tsx";
import { RequestCard, TypeBadge } from "../../components/crew/RequestCard.tsx";
import { SkeletonList } from "../../components/Skeleton.tsx";
import { useNow } from "../../components/crew/useNow.ts";
import { Page } from "../../components/Page.tsx";
import { Sheet } from "../../components/Sheet.tsx";
import { trpc } from "../../lib/trpc.ts";

const Section = ({ title, count, children }: { title: string; count: number; children: ReactNode }) => (
  <section className="space-y-3">
    <h2 className="flex items-center gap-2 text-sm font-bold tracking-wide text-muted uppercase">
      {title}
      <span className="rounded-full bg-surface-2 px-2 py-0.5 text-xs tabular-nums">{count}</span>
    </h2>
    {children}
  </section>
);

const CancelSheet = ({ r, onClose }: { r: CrewRequest | null; onClose: () => void }) => {
  const utils = trpc.useUtils();
  const cancel = trpc.crew.cancel.useMutation({
    onSuccess: () => {
      onClose();
    },
    onSettled: () => {
      void utils.crew.myRequests.invalidate();
      void utils.crew.map.invalidate();
    },
  });
  const close = (): void => {
    cancel.reset();
    onClose();
  };
  return (
    <Sheet
      open={!!r}
      onClose={close}
      title="Cancel request"
      footer={
        <div className="grid grid-cols-[1fr_1.6fr] gap-2">
          <Button variant="secondary" size="lg" onClick={close}>
            Keep
          </Button>
          <Button variant="danger" size="lg" busy={cancel.isPending} onClick={() => r && cancel.mutate({ id: r.id })}>
            Cancel request
          </Button>
        </div>
      }
    >
      {r && (
        <div className="space-y-3 pb-2">
          <div className="flex items-center gap-3">
            <TypeBadge typeKey={r.typeKey} />
            <div className="min-w-0">
              <p className="text-lg font-bold break-words">{r.typeLabel}</p>
              <p className="text-muted">{qtyText(r.qty, r.unit)}</p>
            </div>
          </div>
          {cancel.error && (
            <p role="alert" className="text-sm font-semibold">
              {cancel.error.message || "Not cancelled"}
            </p>
          )}
        </div>
      )}
    </Sheet>
  );
};

export const RequestsPage = () => {
  const q = trpc.crew.myRequests.useQuery(undefined, { refetchInterval: 60_000 });
  const now = useNow();
  const [cancelId, setCancelId] = useState<number | null>(null);
  const { active, earlier } = useMemo(() => {
    const rows = q.data ?? [];
    return { active: rows.filter(isActive), earlier: rows.filter((r) => !isActive(r)) };
  }, [q.data]);
  const toCancel = q.data?.find((r) => r.id === cancelId) ?? null;

  const newButton = (
    <ButtonLink href="/request">
      <PlusIcon size={20} />
      New request
    </ButtonLink>
  );

  let body: ReactNode;
  if (q.isLoading) body = <SkeletonList rows={3} className="h-28" />;
  else if (q.isError)
    body = (
      <EmptyState
        title="Requests not loaded"
        action={
          <Button variant="secondary" onClick={() => void q.refetch()}>
            Retry
          </Button>
        }
      />
    );
  else if (active.length === 0 && earlier.length === 0) body = <EmptyState title="No requests yet" action={newButton} />;
  else
    body = (
      <div className="space-y-6">
        <Section title="Active" count={active.length}>
          {active.length === 0 ? (
            <p className="rounded-2xl bg-surface-2 px-4 py-5 text-center font-semibold text-muted">Nothing on the way</p>
          ) : (
            active.map((r) => (
              <RequestCard
                key={r.id}
                r={r}
                now={now}
                action={
                  crewCanCancel(r) ? (
                    <Button variant="danger" block onClick={() => setCancelId(r.id)}>
                      Cancel
                    </Button>
                  ) : undefined
                }
              />
            ))
          )}
        </Section>
        {earlier.length > 0 && (
          <Section title="Earlier" count={earlier.length}>
            {earlier.map((r) => (
              <RequestCard key={r.id} r={r} now={now} />
            ))}
          </Section>
        )}
      </div>
    );

  return (
    <Page title="Requests" actions={q.data && q.data.length > 0 ? newButton : undefined}>
      {body}
      <CancelSheet r={toCancel} onClose={() => setCancelId(null)} />
    </Page>
  );
};
