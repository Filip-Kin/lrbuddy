import { useCallback, useMemo, useState } from "react";
import { Button } from "../../../components/Button.tsx";
import { EmptyState } from "../../../components/EmptyState.tsx";
import { Page } from "../../../components/Page.tsx";
import { Panel } from "../../../components/Panel.tsx";
import { Chips } from "../../../components/Segmented.tsx";
import { SkeletonList } from "../../../components/Skeleton.tsx";
import { plural } from "../../../components/admin/format.ts";
import { PrintIcon } from "../../../components/admin/icons.tsx";
import { useMe } from "../../../lib/session.ts";
import { trpc } from "../../../lib/trpc.ts";
import { useDayParam } from "../../admin/useDayParam.ts";
import { PRINT_CSS } from "./paper.ts";
import { ccMapKey, CcPage, crewMapKeys, CrewPage, type CrewSheet } from "./sheets.tsx";

type Kind = "all" | "crews" | "ccs";

/**
 * `/plan/print` (SPEC 16): one Letter sheet per crew with two maps, then one
 * per CC. `[data-print-ready]` and the Print button wait for every map's tiles.
 */
export const PrintPage = () => {
  const { days, day, setDay, loading, noEvent } = useDayParam();
  const me = useMe();
  const sheet = trpc.plan.print.sheets.useQuery({ dayId: day?.id ?? 0 }, { enabled: day !== null });
  const [kind, setKind] = useState<Kind>("all");
  const [cc, setCc] = useState<number | "all">("all");
  const [ready, setReady] = useState<ReadonlySet<string>>(() => new Set());
  const onReady = useCallback((key: string, ok: boolean) => {
    setReady((prev) => {
      if (prev.has(key) === ok) return prev;
      const next = new Set(prev);
      if (ok) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  const data = sheet.data;
  const event = me.data && me.data.role === "admin" ? (me.data.event?.name ?? "") : "";
  const ccPages = useMemo(() => (data?.ccPages ?? []).filter((p) => cc === "all" || p.ccId === cc), [data, cc]);
  // Crews in CC order, so each CC's sheets come off the printer together.
  const crewPages = useMemo(() => {
    const order = new Map((data?.ccPages ?? []).map((p, i) => [p.ccId, i]));
    const rank = (p: CrewSheet): number => (p.ccId !== null ? (order.get(p.ccId) ?? 999) : 999);
    return (data?.crewPages ?? []).filter((p) => cc === "all" || p.ccId === cc).sort((a, b) => rank(a) - rank(b));
  }, [data, cc]);
  const showCrews = kind !== "ccs";
  const showCcs = kind !== "crews";
  const pageCount = (showCrews ? crewPages.length : 0) + (showCcs ? ccPages.length : 0);
  const expected = useMemo(() => {
    const all = data?.ccPages ?? [];
    return [...(showCrews ? crewPages.flatMap((p) => crewMapKeys(p, all)) : []), ...(showCcs ? ccPages.map(ccMapKey) : [])];
  }, [data, crewPages, ccPages, showCrews, showCcs]);
  const mapsLeft = expected.filter((k) => !ready.has(k)).length;
  const allReady = !!data && mapsLeft === 0;

  if (loading) {
    return (
      <Page title="Print" wide>
        <SkeletonList rows={3} className="h-14" />
      </Page>
    );
  }
  if (noEvent || !day) {
    return (
      <div data-print-ready="">
        <Page title="Print">
          <Panel>
            <EmptyState title={noEvent ? "No active event" : "No days"} />
          </Panel>
        </Page>
      </div>
    );
  }

  return (
    <div data-print-ready={allReady || (!!data && pageCount === 0) ? "" : undefined}>
      <style>{PRINT_CSS}</style>
      <div className="lrb-print-hide">
        <Page
          title="Print"
          wide
          actions={
            <Button size="lg" onClick={() => window.print()} disabled={pageCount === 0 || !allReady} busy={!!data && pageCount > 0 && !allReady}>
              <PrintIcon />
              {pageCount === 0 ? "Print" : allReady ? `Print ${plural(pageCount, "page")}` : `Loading maps, ${mapsLeft} left`}
            </Button>
          }
        >
          <div className="space-y-3">
            <Chips label="Day" value={day.id} options={days.map((d) => ({ value: d.id, label: d.label, badge: d.crewCount }))} onChange={setDay} />
            <div className="flex flex-wrap gap-2">
              <Chips
                label="Sheets"
                value={kind}
                onChange={setKind}
                options={[
                  { value: "all" as Kind, label: "All sheets" },
                  { value: "crews" as Kind, label: "Crews", badge: crewPages.length },
                  { value: "ccs" as Kind, label: "Command centers", badge: ccPages.length },
                ]}
              />
              {(data?.ccPages.length ?? 0) > 1 && (
                <Chips<number | "all">
                  label="Command center"
                  value={cc}
                  onChange={setCc}
                  options={[{ value: "all", label: "All CCs" }, ...(data?.ccPages ?? []).map((p) => ({ value: p.ccId, label: `CC ${p.name}` }))]}
                />
              )}
            </div>
          </div>
        </Page>
      </div>
      {sheet.isLoading ? (
        <div className="mx-auto max-w-[8.5in] px-4">
          <div className="aspect-[8.5/11] w-full animate-pulse rounded-xl bg-surface-2" aria-busy="true" aria-label="Loading" />
        </div>
      ) : pageCount === 0 ? (
        <div className="mx-auto max-w-2xl px-4">
          <Panel>
            <EmptyState title={data && data.ccPages.length === 0 ? "No command centers on this day" : "No crews on this day"} />
          </Panel>
        </div>
      ) : (
        data && (
          <div className="lrb-sheets mx-auto flex flex-col gap-6 px-4 pb-10 sm:px-0">
            {showCrews &&
              crewPages.map((p) => (
                <CrewPage key={`crew-${p.crewId}`} page={p} cc={data.ccPages.find((c) => c.ccId === p.ccId) ?? null} event={event} day={data.day} onReady={onReady} />
              ))}
            {showCcs && ccPages.map((p) => <CcPage key={`cc-${p.ccId}`} page={p} event={event} day={data.day} onReady={onReady} />)}
          </div>
        )
      )}
    </div>
  );
};
