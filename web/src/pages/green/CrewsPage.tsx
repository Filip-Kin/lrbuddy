import { useMemo, useState } from "react";
import { Button } from "../../components/Button.tsx";
import { EmptyState } from "../../components/EmptyState.tsx";
import { ContactButtons } from "../../components/green/Contact.tsx";
import { useNow, type GreenCrew } from "../../components/green/hooks.ts";
import { ACTIVE_MS } from "../../components/green/MapSheets.tsx";
import { Card, Fact, FilterSelect } from "../../components/green/ui.tsx";
import { SkeletonList } from "../../components/Skeleton.tsx";
import { ago } from "../../lib/format.ts";
import { trpc } from "../../lib/trpc.ts";

const Presence = ({ crew, now }: { crew: GreenCrew; now: number }) => {
  const active = crew.lastSeenAt !== null && now - crew.lastSeenAt <= ACTIVE_MS;
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold ${active ? "bg-brand-green/15 text-ink" : "bg-surface-2 text-muted"}`}
    >
      {active && <span aria-hidden="true" className="h-2 w-2 rounded-full bg-brand-green" />}
      {active ? "Active" : crew.lastSeenAt === null ? "Not joined" : "Away"}
    </span>
  );
};

export const CrewsPage = () => {
  const now = useNow();
  const q = trpc.green.crews.useQuery(undefined, { refetchInterval: 60_000 });
  const [company, setCompany] = useState<string>("");
  const companies = useMemo(() => {
    const m = new Map<number, string>();
    for (const c of q.data ?? []) if (c.companyId !== null && c.companyName) m.set(c.companyId, c.companyName);
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [q.data]);
  const rows = (q.data ?? []).filter((c) => company === "" || c.companyId === Number(company));

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-4 nav:px-6 nav:py-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold tracking-tight">
          Crews {q.data && <span className="font-semibold text-muted tabular-nums">{rows.length}</span>}
        </h1>
        {companies.length > 1 && (
          <FilterSelect label="Company" value={company} onChange={(e) => setCompany(e.target.value)} className="w-48">
            <option value="">All companies</option>
            {companies.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </FilterSelect>
        )}
      </div>
      {q.isLoading ? (
        <SkeletonList rows={4} className="h-44" />
      ) : q.isError ? (
        <EmptyState title="Crews not loaded" description="Check the connection" action={<Button onClick={() => void q.refetch()}>Retry</Button>} />
      ) : rows.length === 0 ? (
        <EmptyState title="No crews at this CC" />
      ) : (
        <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {rows.map((c) => (
            <li key={c.id}>
              <Card className="flex h-full flex-col gap-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="truncate text-lg font-bold">{c.name}</h2>
                    <p className="truncate text-sm text-muted">{c.companyName ?? "No company"}</p>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <Presence crew={c} now={now} />
                    {c.lastSeenAt !== null && <span className="text-xs text-muted tabular-nums">{ago(c.lastSeenAt, now)}</span>}
                  </div>
                </div>
                <Fact label="Lead">{c.leadName ?? "None"}</Fact>
                <div className="grid grid-cols-3 gap-3">
                  <Fact label="Headcount">{c.headcount ?? "None"}</Fact>
                  <Fact label="Open requests">
                    {c.openRequests > 0 ? (
                      <span className="inline-flex items-center gap-1.5">
                        <span aria-hidden="true" className="h-2 w-2 rounded-full bg-crew" />
                        {c.openRequests}
                      </span>
                    ) : (
                      0
                    )}
                  </Fact>
                  <Fact label="Lots done">{c.lotsDone}</Fact>
                </div>
                <div className="mt-auto">
                  <ContactButtons phone={c.leadPhone} who={c.leadName ?? c.name} />
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
