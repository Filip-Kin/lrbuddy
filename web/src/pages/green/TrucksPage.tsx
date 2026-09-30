import { Button } from "../../components/Button.tsx";
import { EmptyState } from "../../components/EmptyState.tsx";
import { ContactButtons } from "../../components/green/Contact.tsx";
import { useNow } from "../../components/green/hooks.ts";
import { StockList } from "../../components/green/StockList.tsx";
import { Card, Fact, SkeletonList } from "../../components/green/ui.tsx";
import { StatusPill } from "../../components/StatusPill.tsx";
import { ago } from "../../lib/format.ts";
import { trpc } from "../../lib/trpc.ts";

/** A truck unseen for 15 minutes gets no new requests; the card says so. */
const STALE_MS = 15 * 60_000;

export const TrucksPage = () => {
  const now = useNow();
  const q = trpc.green.trucks.useQuery(undefined, { refetchInterval: 60_000 });
  const rows = q.data ?? [];
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-4 nav:px-6 nav:py-6">
      <h1 className="mb-4 text-2xl font-bold tracking-tight">Trucks</h1>
      {q.isLoading ? (
        <SkeletonList rows={2} className="h-72" />
      ) : q.isError ? (
        <EmptyState title="Trucks not loaded" description="Check the connection" action={<Button onClick={() => void q.refetch()}>Retry</Button>} />
      ) : rows.length === 0 ? (
        <EmptyState title="No trucks at this CC" />
      ) : (
        <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {rows.map((t) => {
            const stale = t.status !== "offline" && (t.lastSeenAt === null || now - t.lastSeenAt > STALE_MS);
            return (
              <li key={t.id}>
                <Card className="flex h-full flex-col gap-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h2 className="truncate text-lg font-bold">{t.name}</h2>
                      <p className="truncate text-sm text-muted">{t.driverName ?? "No driver"}</p>
                    </div>
                    <div className="flex shrink-0 flex-wrap justify-end gap-1">
                      {t.lowStock && <StatusPill status="low" />}
                      {stale ? <StatusPill status="offline" label="No signal" /> : <StatusPill status={t.status} />}
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <Fact label="Stops left">{t.stopsLeft}</Fact>
                    <Fact label="Last seen">{ago(t.lastSeenAt, now)}</Fact>
                  </div>
                  <section aria-label={`${t.name} stock`}>
                    <h3 className="mb-2 text-xs font-bold text-muted uppercase">Stock</h3>
                    <StockList stock={t.stock} compact />
                  </section>
                  <div className="mt-auto">
                    <ContactButtons phone={t.driverPhone} who={t.driverName ?? t.name} />
                  </div>
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};
