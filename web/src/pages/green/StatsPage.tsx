import type { ReactNode } from "react";
import { Button } from "../../components/Button.tsx";
import { EmptyState } from "../../components/EmptyState.tsx";
import { Card } from "../../components/green/ui.tsx";
import { Skeleton } from "../../components/Skeleton.tsx";
import { duration } from "../../lib/format.ts";
import { trpc } from "../../lib/trpc.ts";

const Tile = ({ label, value, sub, className = "" }: { label: string; value: ReactNode; sub?: string; className?: string }) => (
  <Card className={`min-w-0 ${className}`}>
    <div className="text-sm font-semibold text-muted">{label}</div>
    <div className="mt-1 text-3xl font-extrabold tracking-tight tabular-nums">{value}</div>
    {sub && <div className="mt-0.5 text-sm text-muted">{sub}</div>}
  </Card>
);

/** One series of horizontal bars, value labels at the end. Bars share one scale. */
const Bars = ({ rows, tone, empty }: { rows: ReadonlyArray<{ key: string; label: string; value: number; sub?: string }>; tone: "ink" | "green"; empty: string }) => {
  if (rows.length === 0) return <p className="rounded-2xl border-2 border-dashed border-line px-4 py-8 text-center font-semibold text-muted">{empty}</p>;
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <ul className="space-y-3">
      {rows.map((r) => (
        <li key={r.key} className="grid grid-cols-[minmax(0,8rem)_minmax(0,1fr)] items-center gap-3 sm:grid-cols-[minmax(0,11rem)_minmax(0,1fr)]">
          <span className="truncate text-sm font-semibold">{r.label}</span>
          <span className="flex min-w-0 items-center gap-2">
            <span className="h-3 min-w-0 flex-1">
              <span
                className={`block h-full rounded-r ${tone === "green" ? "bg-brand-green" : "bg-ink"}`}
                style={{ width: `${(r.value / max) * 100}%`, minWidth: r.value > 0 ? 4 : 0 }}
              />
            </span>
            <span className="w-16 shrink-0 text-right text-sm tabular-nums">
              <span className="font-bold">{r.value}</span>
              {r.sub && <span className="ml-1 text-muted">{r.sub}</span>}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
};

const LOT_SEGMENTS = [
  { key: "done", label: "Done", cls: "bg-brand-green" },
  { key: "in_progress", label: "In progress", cls: "bg-brand" },
  { key: "not_done", label: "Not done", cls: "bg-not-done" },
  { key: "do_not_touch", label: "Do not touch", cls: "bg-warn" },
  { key: "open", label: "Todo", cls: "bg-crew" },
] as const;

export const StatsPage = () => {
  const q = trpc.green.stats.useQuery(undefined, { refetchInterval: 60_000 });
  const overview = trpc.green.overview.useQuery();
  const s = q.data;
  const scope = overview.data ? `CC ${overview.data.cc.name}, ${overview.data.day.label}` : null;

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-4 nav:px-6 nav:py-6">
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-bold tracking-tight">Stats</h1>
        {scope && <span className="text-sm font-semibold text-muted">{scope}</span>}
      </div>
      {q.isLoading ? (
        <div className="space-y-4" aria-busy="true">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-24" />
            ))}
          </div>
          <Skeleton className="h-64" />
        </div>
      ) : q.isError || !s ? (
        <EmptyState title="Stats not loaded" description="Check the connection" action={<Button onClick={() => void q.refetch()}>Retry</Button>} />
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
            <Tile label="Open" value={s.open} sub={`${s.onTruck} on a truck`} />
            <Tile label="Delivered" value={s.delivered} sub={s.cancelled > 0 ? `${s.cancelled} cancelled` : "requests"} />
            <Tile label="Median to deliver" value={s.medianDeliverMs === null ? "None" : duration(s.medianDeliverMs)} />
            <Tile label="Active crews" value={`${s.activeCrews}/${s.totalCrews}`} sub="last 30 min" />
            <Tile label="Photographed" value={s.photographed} sub={`${s.missingAfter} missing after`} className="col-span-2 md:col-span-1" />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <h2 className="mb-4 text-lg font-bold">Requests by type</h2>
              <Bars tone="ink" empty="No requests yet" rows={s.requestsByType.map((r) => ({ key: r.label, label: r.label, value: r.count }))} />
            </Card>
            <Card>
              <h2 className="mb-4 text-lg font-bold">Lots done by company</h2>
              <Bars tone="green" empty="No crews yet" rows={s.lotsDoneByCompany.map((r) => ({ key: r.company, label: r.company, value: r.done }))} />
            </Card>
          </div>

          <Card>
            <div className="mb-3 flex items-baseline justify-between gap-2">
              <h2 className="text-lg font-bold">Lots</h2>
              <span className="text-sm text-muted tabular-nums">{s.lotsTotal} total</span>
            </div>
            {s.lotsTotal === 0 ? (
              <p className="rounded-2xl border-2 border-dashed border-line px-4 py-8 text-center font-semibold text-muted">No lots at this CC</p>
            ) : (
              <>
                <div className="flex h-4 gap-0.5 overflow-hidden rounded-full" aria-hidden="true">
                  {LOT_SEGMENTS.map((seg) => {
                    const n = s.lotsByStatus[seg.key];
                    return n > 0 ? <span key={seg.key} className={seg.cls} style={{ flexGrow: n, flexBasis: 0 }} /> : null;
                  })}
                </div>
                <ul className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
                  {LOT_SEGMENTS.map((seg) => (
                    <li key={seg.key} className="flex items-center gap-2 text-sm">
                      <span aria-hidden="true" className={`h-3 w-3 shrink-0 rounded-sm ${seg.cls}`} />
                      <span className="font-semibold">{seg.label}</span>
                      <span className="ml-auto tabular-nums">
                        {s.lotsByStatus[seg.key]}
                        <span className="ml-1 text-muted">{Math.round((s.lotsByStatus[seg.key] / s.lotsTotal) * 100)}%</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </Card>
        </div>
      )}
    </div>
  );
};
