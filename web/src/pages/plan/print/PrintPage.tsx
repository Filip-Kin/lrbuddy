import { useCallback, useMemo, useState } from "react";
import { Button } from "../../../components/Button.tsx";
import { EmptyState } from "../../../components/EmptyState.tsx";
import { Page } from "../../../components/Page.tsx";
import { Panel } from "../../../components/Panel.tsx";
import { Chips, ToggleChip } from "../../../components/Segmented.tsx";
import { SkeletonList } from "../../../components/Skeleton.tsx";
import { plural } from "../../../components/admin/format.ts";
import { PrintIcon } from "../../../components/admin/icons.tsx";
import { useMe } from "../../../lib/session.ts";
import { trpc } from "../../../lib/trpc.ts";
import { useDayParam } from "../../admin/useDayParam.ts";
import { printCss } from "./paper.ts";
import { ccMapKey, CcPage, CompanyPage, companyMapKey, crewMapKeys, CrewPage, type CrewSheet } from "./sheets.tsx";

/**
 * `/plan/print` (SPEC 16 and 19): one landscape company map per company per
 * CC, then one Letter sheet per crew with two maps, then one per CC. A toggle
 * row picks the sections. `[data-print-ready]` and the Print button wait for
 * every map's tiles.
 */
export const PrintPage = () => {
  const { days, day, setDay, loading, noEvent } = useDayParam();
  const me = useMe();
  const sheet = trpc.plan.print.sheets.useQuery({ dayId: day?.id ?? 0 }, { enabled: day !== null });
  const [showCompanies, setShowCompanies] = useState(true);
  const [showCrews, setShowCrews] = useState(true);
  const [showCcs, setShowCcs] = useState(true);
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
  // Company maps in CC order, companies by name within each CC (the server's order).
  const companyPages = useMemo(
    () => (data?.companyPages ?? []).filter((p) => (cc === "all" || p.ccId === cc) && data?.ccPages.some((c) => c.ccId === p.ccId)),
    [data, cc],
  );
  const pageCount = (showCompanies ? companyPages.length : 0) + (showCrews ? crewPages.length : 0) + (showCcs ? ccPages.length : 0);
  const expected = useMemo(() => {
    const all = data?.ccPages ?? [];
    return [
      ...(showCompanies ? companyPages.map(companyMapKey) : []),
      ...(showCrews ? crewPages.flatMap((p) => crewMapKeys(p, all)) : []),
      ...(showCcs ? ccPages.map(ccMapKey) : []),
    ];
  }, [data, companyPages, crewPages, ccPages, showCompanies, showCrews, showCcs]);
  const mapsLeft = expected.filter((k) => !ready.has(k)).length;
  const allReady = !!data && mapsLeft === 0;

  if (loading) {
    return (
      <Page title="Print" full>
        <SkeletonList rows={3} className="h-14" />
      </Page>
    );
  }
  if (noEvent || !day) {
    return (
      <div data-print-ready="">
        <Page title="Print" full>
          <Panel>
            <EmptyState title={noEvent ? "No active event" : "No days"} />
          </Panel>
        </Page>
      </div>
    );
  }

  return (
    <div data-print-ready={allReady || (!!data && pageCount === 0) ? "" : undefined}>
      <style>{printCss(showCompanies && companyPages.length > 0)}</style>
      <div className="lrb-print-hide">
        <Page
          title="Print"
          full
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
              <div role="group" aria-label="Sections" className="flex flex-wrap gap-2">
                <ToggleChip on={showCompanies} onChange={setShowCompanies}>
                  Company maps <span className="tabular-nums">{companyPages.length}</span>
                </ToggleChip>
                <ToggleChip on={showCrews} onChange={setShowCrews}>
                  Crew sheets <span className="tabular-nums">{crewPages.length}</span>
                </ToggleChip>
                <ToggleChip on={showCcs} onChange={setShowCcs}>
                  CC sheets <span className="tabular-nums">{ccPages.length}</span>
                </ToggleChip>
              </div>
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
            <EmptyState
              title={
                data && data.ccPages.length === 0
                  ? "No command centers on this day"
                  : !showCompanies && !showCrews && !showCcs
                    ? "No sections picked"
                    : "No crews on this day"
              }
            />
          </Panel>
        </div>
      ) : (
        data && (
          <div className="lrb-sheets mx-auto flex flex-col gap-6 px-4 pb-10 sm:px-0">
            {showCompanies &&
              companyPages.map((p) => {
                const ccPage = data.ccPages.find((c) => c.ccId === p.ccId);
                return ccPage ? <CompanyPage key={p.key} page={p} cc={ccPage} day={data.day} onReady={onReady} /> : null;
              })}
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
