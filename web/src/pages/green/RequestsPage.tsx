import { useEffect, useMemo, useState } from "react";
import { Button } from "../../components/Button.tsx";
import { EmptyState } from "../../components/EmptyState.tsx";
import { useNewRequestChime, useNow, useSoundSetting, type GreenRequest } from "../../components/green/hooks.ts";
import { RequestCard } from "../../components/green/RequestCard.tsx";
import { FilterSelect, Segmented, SkeletonList, SoundIcon, ToggleChip, useFlash } from "../../components/green/ui.tsx";
import { trpc } from "../../lib/trpc.ts";

type Column = "open" | "assigned" | "en_route" | "closed";

const COLUMNS: ReadonlyArray<{ key: Column; label: string; empty: string }> = [
  { key: "open", label: "Open", empty: "No open requests" },
  { key: "assigned", label: "Assigned", empty: "Nothing assigned" },
  { key: "en_route", label: "En route", empty: "No trucks en route" },
  { key: "closed", label: "Closed", empty: "Nothing closed yet" },
];

const CLOSED_PAGE = 20;

const columnOf = (r: GreenRequest): Column => (r.status === "delivered" || r.status === "cancelled" ? "closed" : r.status);

export const RequestsPage = () => {
  const now = useNow();
  const [company, setCompany] = useState<number | null>(null);
  const [tab, setTab] = useState<Column>("open");
  const [closedShown, setClosedShown] = useState(CLOSED_PAGE);
  const [sound, setSound] = useSoundSetting();
  const [flash, showFlash] = useFlash();

  const list = trpc.green.requests.useQuery(undefined, { refetchInterval: 60_000 });
  const trucks = trpc.green.trucks.useQuery();
  const overview = trpc.green.overview.useQuery();
  useNewRequestChime(list.data, sound);

  // First load opens the first column that has something waiting.
  const [picked, setPicked] = useState(false);
  useEffect(() => {
    if (picked || !list.data) return;
    setPicked(true);
    const first = (["open", "assigned", "en_route"] as const).find((k) => list.data.some((r) => columnOf(r) === k));
    if (first) setTab(first);
  }, [list.data, picked]);

  const groups = useMemo(() => {
    const out: Record<Column, GreenRequest[]> = { open: [], assigned: [], en_route: [], closed: [] };
    for (const r of list.data ?? []) {
      if (company !== null && r.companyId !== company) continue;
      out[columnOf(r)].push(r);
    }
    // Oldest first while waiting, so the longest wait is on top; newest first once closed.
    for (const k of ["open", "assigned", "en_route"] as const) out[k].sort((a, b) => a.createdAt - b.createdAt);
    out.closed.sort((a, b) => (b.deliveredAt ?? b.cancelledAt ?? b.createdAt) - (a.deliveredAt ?? a.cancelledAt ?? a.createdAt));
    return out;
  }, [list.data, company]);

  const companies = overview.data?.companies ?? [];
  const truckList = trucks.data ?? [];

  const renderColumn = (key: Column) => {
    const col = COLUMNS.find((c) => c.key === key)!;
    const rows = groups[key];
    const shown = key === "closed" ? rows.slice(0, closedShown) : rows;
    return (
      <div className="space-y-3">
        {rows.length === 0 && (
          <div className="rounded-2xl border-2 border-dashed border-line px-4 py-10 text-center font-semibold text-muted">{company !== null ? `${col.empty}, this company` : col.empty}</div>
        )}
        {shown.map((r) => (
          <RequestCard key={r.id} request={r} trucks={truckList} now={now} onDone={showFlash} />
        ))}
        {key === "closed" && rows.length > shown.length && (
          <Button variant="secondary" block onClick={() => setClosedShown((n) => n + CLOSED_PAGE)}>
            More ({rows.length - shown.length})
          </Button>
        )}
      </div>
    );
  };

  return (
    <div className="mx-auto w-full max-w-[1600px] px-4 py-4 nav:px-6 nav:py-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold tracking-tight">Requests</h1>
        <div className="flex flex-wrap items-center gap-2">
          {companies.length > 0 && (
            <FilterSelect label="Company" value={company ?? ""} onChange={(e) => setCompany(e.target.value ? Number(e.target.value) : null)} className="w-44">
              <option value="">All companies</option>
              {companies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </FilterSelect>
          )}
          <ToggleChip on={sound} onChange={setSound}>
            <SoundIcon on={sound} />
            Sound
          </ToggleChip>
        </div>
      </div>
      {list.isLoading ? (
        <SkeletonList rows={4} />
      ) : list.isError ? (
        <EmptyState title="Requests not loaded" description="Check the connection" action={<Button onClick={() => void list.refetch()}>Retry</Button>} />
      ) : (
        <>
          <Segmented
            label="Status"
            value={tab}
            onChange={setTab}
            options={COLUMNS.map((c) => ({ value: c.key, label: c.label, count: groups[c.key].length }))}
            className="mb-4 xl:hidden"
            stacked
          />
          <div className="xl:hidden">{renderColumn(tab)}</div>
          <div className="hidden gap-4 xl:grid xl:grid-cols-4">
            {COLUMNS.map((c) => (
              <section key={c.key} aria-label={c.label} className="min-w-0">
                <h2 className="mb-3 flex items-center gap-2 text-sm font-bold tracking-wide text-muted uppercase">
                  {c.label}
                  <span className="rounded-full bg-surface-2 px-2 py-0.5 text-xs text-ink tabular-nums ring-1 ring-line">{groups[c.key].length}</span>
                </h2>
                {renderColumn(c.key)}
              </section>
            ))}
          </div>
        </>
      )}
      <div className="pointer-events-none fixed inset-x-0 bottom-[max(1.5rem,env(safe-area-inset-bottom))] z-[1200] flex justify-center">{flash}</div>
    </div>
  );
};
