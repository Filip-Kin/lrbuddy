import { useMemo, useState, type ReactNode } from "react";
import { Button } from "../../components/Button.tsx";
import { EmptyState } from "../../components/EmptyState.tsx";
import { Page } from "../../components/Page.tsx";
import { Chips } from "../../components/admin/Chips.tsx";
import { dayDate, phoneText, plural } from "../../components/admin/format.ts";
import { PrintIcon } from "../../components/admin/icons.tsx";
import { Panel, Skeleton } from "../../components/admin/Panel.tsx";
import { useMe } from "../../lib/session.ts";
import { trpc, type RouterOutputs } from "../../lib/trpc.ts";
import { useDayParam } from "./useDayParam.ts";

type Sheet = RouterOutputs["admin"]["print"]["sheet"];
type CrewSheet = Sheet["crewPages"][number];
type CcSheet = Sheet["ccPages"][number];
type Shirt = CrewSheet["greenShirts"][number];
type Kind = "all" | "crews" | "ccs";

/**
 * Paper rules. The app shell is a fixed-height flex column with a scrolling
 * main; on paper everything has to flow, one sheet per page.
 */
const PRINT_CSS = `
@media print {
  @page { size: letter portrait; margin: 0.45in; }
  html, body, #root { height: auto !important; overflow: visible !important; background: #fff !important; }
  #root .h-dvh { height: auto !important; display: block !important; }
  #root main { overflow: visible !important; }
  .lrb-sheets { gap: 0 !important; padding: 0 !important; max-width: none !important; }
  .lrb-sheet { break-after: page; page-break-after: always; break-inside: avoid; box-shadow: none !important; border: 0 !important; border-radius: 0 !important; margin: 0 !important; padding: 0 !important; width: auto !important; min-height: 0 !important; aspect-ratio: auto !important; }
  .lrb-sheet:last-child { break-after: auto; page-break-after: auto; }
  .lrb-print-hide { display: none !important; }
}
`;

/** Qr SVG from the server, sized by its box. */
const Qr = ({ svg, label, className }: { svg: string; label: string; className: string }) => (
  <div role="img" aria-label={label} className={`[&>svg]:block [&>svg]:h-full [&>svg]:w-full ${className}`} dangerouslySetInnerHTML={{ __html: svg }} />
);

/** Fixed paper colours: sheets look the same on screen in dark mode as they do printed. */
const Paper = ({ children }: { children: ReactNode }) => (
  <article className="lrb-sheet mx-auto flex w-full max-w-[8.5in] flex-col overflow-hidden rounded-xl bg-white p-5 text-[#0e3038] shadow-lg ring-1 ring-black/10 sm:aspect-[8.5/11] sm:p-10">
    {children}
  </article>
);

const Header = ({ event, day }: { event: string; day: Sheet["day"] }) => (
  <header className="flex items-center justify-between gap-3 border-b-2 border-[#0e3038] pb-2 text-sm font-semibold">
    <span className="flex items-center gap-2">
      <span aria-hidden="true" className="h-3 w-3 rounded-sm bg-[#fddd08] ring-1 ring-[#0e3038]" />
      LR Buddy{event ? `, ${event}` : ""}
    </span>
    <span>
      {day.label}, {dayDate(day.date)}
    </span>
  </header>
);

const Shirts = ({ shirts }: { shirts: readonly Shirt[] }) =>
  shirts.length === 0 ? null : (
    <table className="w-full text-left text-sm sm:text-base">
      <caption className="pb-1 text-left text-xs font-bold tracking-wider uppercase">Green shirts</caption>
      <tbody>
        {shirts.map((g) => (
          <tr key={`${g.name}-${g.phone ?? ""}`} className="border-t border-[#d1d3d4]">
            <td className="py-1.5 pr-2 font-semibold">{g.name}</td>
            <td className="py-1.5 pr-2">{g.roleLabel ?? ""}</td>
            <td className="py-1.5 text-right font-mono whitespace-nowrap">{g.phone ? phoneText(g.phone) : ""}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );

const CrewPage = ({ page, event, day }: { page: CrewSheet; event: string; day: Sheet["day"] }) => (
  <Paper>
    <Header event={event} day={day} />
    <div className="mt-4 flex flex-wrap items-end justify-between gap-x-6 gap-y-1">
      <h2 className="text-5xl font-black tracking-tight sm:text-6xl">{page.name}</h2>
      {page.companyName && <p className="text-2xl font-bold sm:text-3xl">{page.companyName}</p>}
    </div>
    <p className="mt-1 text-lg">
      <span className="font-semibold">CC {page.ccName ?? ""}</span>
      {page.ccAddress ? `, ${page.ccAddress}` : ""}
    </p>
    <div className="my-4 flex flex-1 flex-col items-center justify-center gap-2">
      <Qr svg={page.qrSvg} label={`QR code for ${page.name}`} className="aspect-square w-full max-w-[3.4in]" />
      <p className="text-center text-lg font-bold">Scan to join {page.name}</p>
      <p className="text-center font-mono text-xs break-all">{page.url}</p>
    </div>
    <div className="space-y-3">
      {page.leadName && (
        <p className="text-base">
          <span className="text-xs font-bold tracking-wider uppercase">Red shirt</span>
          <span className="ml-2 font-semibold">{page.leadName}</span>
        </p>
      )}
      <Shirts shirts={page.greenShirts} />
    </div>
  </Paper>
);

const CcPage = ({ page, event, day }: { page: CcSheet; event: string; day: Sheet["day"] }) => (
  <Paper>
    <Header event={event} day={day} />
    <h2 className="mt-4 text-5xl font-black tracking-tight sm:text-6xl">CC {page.name}</h2>
    {page.address && <p className="mt-1 text-lg">{page.address}</p>}
    <div className="mt-5 grid gap-5 sm:grid-cols-[1fr_auto]">
      <div className="space-y-4">
        <div className="rounded-xl border-2 border-[#0e3038] px-4 py-3">
          <div className="text-xs font-bold tracking-wider uppercase">Green code</div>
          <div className="font-mono text-4xl font-black tracking-[0.25em] sm:text-5xl">{page.greenCode ?? ""}</div>
        </div>
        <p className="text-base">
          <span className="text-xs font-bold tracking-wider uppercase">Sign in</span>
          <span className="ml-2 font-mono break-all">{page.loginUrl}</span>
        </p>
      </div>
      <Qr svg={page.loginQrSvg} label="QR code for the sign-in page" className="aspect-square w-40 justify-self-center sm:w-44" />
    </div>
    <div className="mt-6 flex-1 space-y-5">
      <table className="w-full text-left">
        <caption className="pb-1 text-left text-xs font-bold tracking-wider uppercase">Trucks</caption>
        <tbody>
          {page.trucks.length === 0 ? (
            <tr className="border-t border-[#d1d3d4]">
              <td className="py-2">No trucks</td>
            </tr>
          ) : (
            page.trucks.map((t) => (
              <tr key={t.code} className="border-t border-[#d1d3d4]">
                <td className="py-2 pr-2 text-lg font-semibold">{t.name}</td>
                <td className="py-2 pr-2">{t.driverName ?? ""}</td>
                <td className="py-2 text-right font-mono text-2xl font-black tracking-[0.2em]">{t.code}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
      <Shirts shirts={page.greenShirts} />
    </div>
  </Paper>
);

export const PrintPage = () => {
  const { days, day, setDay, loading, noEvent } = useDayParam();
  const me = useMe();
  const sheet = trpc.admin.print.sheet.useQuery({ dayId: day?.id ?? 0 }, { enabled: day !== null });
  const [kind, setKind] = useState<Kind>("all");
  const [cc, setCc] = useState<string>("all");
  const data = sheet.data;
  const event = me.data && me.data.role === "admin" ? (me.data.event?.name ?? "") : "";
  const ccNames = useMemo(() => (data ? data.ccPages.map((p) => p.name) : []), [data]);
  const crewPages = (data?.crewPages ?? []).filter((p) => cc === "all" || p.ccName === cc);
  const ccPages = (data?.ccPages ?? []).filter((p) => cc === "all" || p.name === cc);
  const showCrews = kind !== "ccs";
  const showCcs = kind !== "crews";
  const pageCount = (showCrews ? crewPages.length : 0) + (showCcs ? ccPages.length : 0);

  if (loading) {
    return (
      <Page title="Print" wide>
        <Skeleton rows={3} />
      </Page>
    );
  }
  if (noEvent || !day) {
    return (
      <Page title="Print">
        <Panel>
          <EmptyState title={noEvent ? "No active event" : "No days"} />
        </Panel>
      </Page>
    );
  }

  return (
    <>
      <style>{PRINT_CSS}</style>
      <div className="lrb-print-hide">
        <Page
          title="Print"
          wide
          actions={
            <Button size="lg" onClick={() => window.print()} disabled={pageCount === 0}>
              <PrintIcon />
              {pageCount > 0 ? `Print ${plural(pageCount, "page")}` : "Print"}
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
              {ccNames.length > 1 && (
                <Chips label="Command center" value={cc} onChange={setCc} options={[{ value: "all", label: "All CCs" }, ...ccNames.map((n) => ({ value: n, label: `CC ${n}` }))]} />
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
          <div className="lrb-sheets mx-auto flex max-w-[8.5in] flex-col gap-6 px-4 pb-10 nav:px-0">
            {showCcs && ccPages.map((p) => <CcPage key={`cc-${p.ccId}`} page={p} event={event} day={data.day} />)}
            {showCrews && crewPages.map((p) => <CrewPage key={`crew-${p.crewId}`} page={p} event={event} day={data.day} />)}
          </div>
        )
      )}
    </>
  );
};
