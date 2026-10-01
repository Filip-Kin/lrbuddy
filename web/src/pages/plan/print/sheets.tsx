import { useMemo, type ReactNode } from "react";
import type { AreaPolygon } from "../../../../../server/db/schema.ts";
import { dayDate, phoneText, plural } from "../../../components/admin/format.ts";
import { lotTitle } from "../../../lib/format.ts";
import type { RouterOutputs } from "../../../lib/trpc.ts";
import { BLUE, DNT, GREY, INK, LOT_FILL, WORK, YELLOW } from "./paper.ts";
import { PrintMap, type LatLngPair, type PrintLayer } from "./PrintMap.tsx";

// #region types and helpers
export type Sheets = RouterOutputs["plan"]["print"]["sheets"];
export type CrewSheet = Sheets["crewPages"][number];
export type CcSheet = Sheets["ccPages"][number];
export type CompanySheet = Sheets["companyPages"][number];
type Shirt = CrewSheet["greenShirts"][number];
type PrintLot = CrewSheet["lots"][number];
export type OnReady = (key: string, ready: boolean) => void;

// SPEC 21 words: the grade is the size of a Todo lot.
const GRADE: Record<"high" | "low" | "clear", string> = { high: "Full day", low: "Light", clear: "" };
const BADGE: Record<"high" | "low", string> = { high: "F", low: "L" };

/** "lrbuddy.filipkin.com/login": the scheme is noise on paper and costs a line. */
const bareUrl = (u: string): string => u.replace(/^https?:\/\//, "");

const ring = (a: AreaPolygon | null): LatLngPair[] => (a?.coordinates[0] ?? []).flatMap((p) => (p[0] !== undefined && p[1] !== undefined ? [[p[1], p[0]] as LatLngPair] : []));

/** "5123 Garland" from "5123 Garland St"; the street name is on the basemap. */
const shortAddress = (l: PrintLot): string => lotTitle(l).replace(/\s+(St|Street|Ave|Avenue|Rd|Road|Blvd|Dr|Drive|Ct|Pl|Ter)\.?$/i, "");

/**
 * What the crew detail map fits: the crew's area and every one of its lots,
 * so a lot published outside a dragged rectangle still shows. Empty means no detail map.
 */
export const detailFit = (page: CrewSheet): LatLngPair[] => [...ring(page.area), ...page.lots.map((l) => [l.lat, l.lng] as LatLngPair)];

const ccFit = (cc: CcSheet): LatLngPair[] => {
  const [w, s, e, n] = cc.bounds;
  return [
    [s, w],
    [n, e],
  ];
};

/** Map keys a crew sheet reports, so the page knows what to wait for. */
export const crewMapKeys = (page: CrewSheet, ccs: readonly CcSheet[]): string[] => [
  ...(ccs.some((c) => c.ccId === page.ccId) ? [`crew-${page.crewId}-overview`] : []),
  ...(detailFit(page).length > 0 ? [`crew-${page.crewId}-detail`] : []),
];
export const ccMapKey = (cc: CcSheet): string => `cc-${cc.ccId}`;
export const companyMapKey = (page: CompanySheet): string => page.key;

/** "Monday" from "2026-09-28". */
const weekday = (ymd: string): string => {
  const d = new Date(`${ymd}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? ymd : d.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
};

const workLayers = (cc: CcSheet): PrintLayer[] =>
  cc.workLots.map((l) => ({ kind: "lot", key: `w${l.id}`, geometry: l.geometry, lat: l.lat, lng: l.lng, tone: l.status === "do_not_touch" ? "dnt" : "work" }));
// #endregion

// #region pieces
const Caps = ({ children }: { children: ReactNode }) => <div className="text-[10px] font-bold tracking-wider uppercase">{children}</div>;

/** One Letter page. On screen it is drawn at paper size from 640 px up. */
const Paper = ({ kind, children }: { kind: "crew" | "cc"; children: ReactNode }) => (
  <article data-sheet={kind} className="lrb-sheet lrb-sheet-port lrb-paper mx-auto flex w-full min-w-0 flex-col overflow-x-auto sm:overflow-x-visible rounded-xl bg-white p-4 shadow-lg ring-1 ring-black/10 sm:min-h-[11in] sm:w-[8.5in] sm:p-[0.45in]">
    {children}
  </article>
);

const Header = ({ event, day }: { event: string; day: Sheets["day"] }) => (
  <header className="flex items-center justify-between gap-3 border-b-2 border-[#0e3038] pb-1.5 text-sm font-semibold">
    <span className="flex items-center gap-2">
      <span aria-hidden="true" className="h-3 w-3 rounded-sm bg-[#fddd08] ring-1 ring-[#0e3038]" />
      LR Buddy{event ? `, ${event}` : ""}
    </span>
    <span>
      {day.label}, {dayDate(day.date)}
    </span>
  </header>
);

const Qr = ({ svg, label, className }: { svg: string; label: string; className: string }) => (
  <div role="img" aria-label={label} className={`[&>svg]:block [&>svg]:h-full [&>svg]:w-full ${className}`} dangerouslySetInnerHTML={{ __html: svg }} />
);

const Shirts = ({ shirts }: { shirts: readonly Shirt[] }) => (
  <table className="w-full text-left text-xs">
    <caption className="pb-0.5 text-left">
      <Caps>Green shirts</Caps>
    </caption>
    <tbody>
      {shirts.length === 0 ? (
        <tr className="border-t border-[#d1d3d4]">
          <td className="py-1">None</td>
        </tr>
      ) : (
        shirts.map((g) => (
          <tr key={`${g.name}-${g.phone ?? ""}`} className="border-t border-[#d1d3d4]">
            <td className="py-1 pr-2 font-semibold">{g.name}</td>
            <td className="py-1 text-right font-mono whitespace-nowrap">{g.phone ? phoneText(g.phone) : ""}</td>
          </tr>
        ))
      )}
    </tbody>
  </table>
);

/** Legend swatches drawn with the same strokes and fills as the map. */
const Swatch = ({ kind, letter }: { kind: "high" | "low" | "work" | "dnt" | "mine" | "other" | "crew" | "cc"; letter?: string | null }) => (
  <svg viewBox="0 0 22 14" width="22" height="14" aria-hidden="true" className="shrink-0">
    {kind === "dnt" ? (
      <>
        <rect x="2" y="2" width="18" height="10" fill={DNT} fillOpacity="0.12" stroke={DNT} strokeWidth="1.2" />
        <path d="M2 9l7-7M7 12l10-10M14 12l6-6" stroke={DNT} strokeWidth="1" />
      </>
    ) : kind === "high" || kind === "low" || kind === "work" ? (
      <rect x="2" y="2" width="18" height="10" fill={WORK} fillOpacity={LOT_FILL[kind]} stroke={INK} strokeWidth={kind === "work" ? 1 : 1.5} strokeDasharray={kind === "work" ? undefined : "4 3"} />
    ) : kind === "mine" ? (
      <>
        <rect x="4" y="3" width="14" height="8" fill="none" stroke={YELLOW} strokeWidth="5" />
        <rect x="4" y="3" width="14" height="8" fill="none" stroke={INK} strokeWidth="2.2" />
      </>
    ) : kind === "other" || kind === "crew" ? (
      <rect x="2" y="2" width="18" height="10" fill="none" stroke={kind === "other" ? GREY : INK} strokeWidth={kind === "other" ? 1.2 : 2} />
    ) : letter ? (
      <>
        <circle cx="11" cy="7" r="6.4" fill="#000" stroke="#fff" strokeWidth="1" />
        <text x="11" y="7" dy="0.35em" textAnchor="middle" fontSize="8" fontWeight="800" fill="#fff">
          {letter}
        </text>
      </>
    ) : (
      <path d="M11 0.8l2.4 4.4 4.9.6-3.6 3.3 1 4.8L11 11.5l-4.7 2.4 1-4.8-3.6-3.3 4.9-.6z" fill="#000" stroke="#fff" strokeWidth="1" />
    )}
  </svg>
);

const Legend = ({ items, letter }: { items: ReadonlyArray<[Parameters<typeof Swatch>[0]["kind"], string]>; letter?: string | null }) => (
  <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] font-semibold">
    {items.map(([kind, label]) => (
      <li key={kind} className="flex items-center gap-1.5">
        <Swatch kind={kind} letter={kind === "cc" ? letter : undefined} />
        {label}
      </li>
    ))}
  </ul>
);

/**
 * A captioned map. `fill` makes it take the height the rest of the page leaves
 * on paper size (never under 2 in), so a sheet with more rows below gets a
 * shorter map and still prints on one page.
 */
const MapBlock = ({ caption, fill = false, children }: { caption: string; fill?: boolean; children: ReactNode }) => (
  <section className={fill ? "mt-2 flex flex-col sm:min-h-[2.2in] sm:flex-[1_1_0]" : "mt-2"}>
    <Caps>{caption}</Caps>
    <div className={`mt-0.5 overflow-hidden rounded-md ring-1 ring-[#0e3038] ${fill ? "flex min-h-0 flex-1 flex-col" : ""}`}>{children}</div>
  </section>
);
// #endregion

// #region crew sheet
export const CrewPage = ({ page, cc, event, day, onReady }: { page: CrewSheet; cc: CcSheet | null; event: string; day: Sheets["day"]; onReady: OnReady }) => {
  const overview = useMemo(() => {
    if (!cc) return null;
    const layers: PrintLayer[] = [
      ...page.otherAreas.map((a): PrintLayer => ({ kind: "area", key: `a${a.areaId}`, ring: ring(a.area), tone: "other", label: a.name, hatch: a.doNotTouch })),
      ...workLayers(cc),
      { kind: "area", key: "mine", ring: ring(page.area), tone: "mine", label: page.areaName ?? page.name, hatch: page.areaDoNotTouch },
    ];
    return { fit: ccFit(cc), layers, cc: { lat: cc.lat, lng: cc.lng, name: cc.name, letter: cc.letter } };
  }, [page, cc]);

  const detail = useMemo(() => {
    const fit = detailFit(page);
    if (fit.length === 0) return null;
    const layers: PrintLayer[] = [
      { kind: "area", key: "mine", ring: ring(page.area), tone: "mine", hatch: page.areaDoNotTouch },
      ...page.lots.map(
        (l): PrintLayer => ({
          kind: "lot",
          key: `l${l.id}`,
          geometry: l.geometry,
          lat: l.lat,
          lng: l.lng,
          tone: l.status === "do_not_touch" ? "dnt" : l.grade === "high" ? "high" : "low",
          label: shortAddress(l),
          badge: l.grade === "high" || l.grade === "low" ? BADGE[l.grade] : undefined,
        }),
      ),
    ];
    return { fit, layers, cc: page.cc && page.ccName ? { lat: page.cc.lat, lng: page.cc.lng, name: page.ccName, letter: page.ccLetter } : null };
  }, [page]);

  const lead = [page.leadName, page.leadPhone ? phoneText(page.leadPhone) : null].filter((s): s is string => !!s).join(", ");

  return (
    <Paper kind="crew">
      <Header event={event} day={day} />
      <div className="mt-3 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-4xl leading-none font-black tracking-tight">{page.name}</h2>
          <dl className="mt-2 grid grid-cols-[auto_1fr] items-baseline gap-x-3 gap-y-1 text-sm">
            <dt>
              <Caps>CC</Caps>
            </dt>
            <dd className="font-semibold">
              {page.ccName ?? ""}
              {page.ccAddress ? <span className="font-normal">, {page.ccAddress}</span> : null}
            </dd>
            {lead && (
              <>
                <dt>
                  <Caps>Red shirt</Caps>
                </dt>
                <dd className="font-semibold">{lead}</dd>
              </>
            )}
            <dt>
              <Caps>Lots</Caps>
            </dt>
            <dd className="font-semibold">{page.lots.length}</dd>
          </dl>
        </div>
        <figure className="flex w-[1.3in] shrink-0 flex-col items-center gap-0.5">
          <Qr svg={page.qrSvg} label={`QR code for ${page.name}`} className="aspect-square w-full" />
          <figcaption className="text-xs font-bold">Join</figcaption>
        </figure>
      </div>

      {overview && (
        <MapBlock caption={`Overview, CC ${cc?.name ?? ""}`}>
          <PrintMap
            readyKey={`crew-${page.crewId}-overview`}
            onReady={onReady}
            fit={overview.fit}
            layers={overview.layers}
            cc={overview.cc}
            padding={14}
            className="h-[2.1in] w-full"
            label={`Overview map for ${page.name}`}
          />
        </MapBlock>
      )}
      {detail && (
        <MapBlock caption={`Area, ${page.name}`}>
          <PrintMap
            readyKey={`crew-${page.crewId}-detail`}
            onReady={onReady}
            fit={detail.fit}
            layers={detail.layers}
            cc={detail.cc}
            padding={22}
            className="h-[3.1in] w-full"
            label={`Area map for ${page.name}`}
          />
        </MapBlock>
      )}
      <div className="mt-1.5">
        <Legend
          letter={page.ccLetter}
          items={[
            ["high", "Todo, full day"],
            ["low", "Todo, light"],
            ["work", "Todo, other crews"],
            ["dnt", "Do not touch"],
            ["mine", page.areaName ?? page.name],
            ["other", "Other crews"],
            ["cc", "CC"],
          ]}
        />
      </div>

      <div className="mt-2 grid grid-cols-1 gap-4 sm:grid-cols-[1fr_2.5in]">
        <section className="min-w-0">
          <Caps>Lots</Caps>
          {page.lots.length === 0 ? (
            <p className="mt-1 text-sm">No lots</p>
          ) : (
            <ol className={`mt-0.5 gap-x-4 text-xs ${page.lots.length > 16 ? "sm:columns-3" : page.lots.length > 8 ? "sm:columns-2" : ""}`}>
              {page.lots.map((l) => (
                <li key={l.id} className={`flex break-inside-avoid justify-between gap-2 border-t border-[#d1d3d4] ${page.lots.length > 24 ? "" : "py-0.5"}`}>
                  <span className="min-w-0 truncate font-semibold">{lotTitle(l)}</span>
                  <span className="shrink-0">{l.grade ? GRADE[l.grade] : ""}</span>
                </li>
              ))}
            </ol>
          )}
        </section>
        <div className="space-y-2">
          <Shirts shirts={page.greenShirts} />
          <section className="rounded-md border-2 border-[#0e3038] px-2 py-1.5 text-xs">
            <Caps>Join</Caps>
            <dl className="mt-0.5 space-y-0.5">
              <div className="flex gap-2">
                <dt className="font-semibold">Sign in</dt>
                <dd className="min-w-0 font-mono break-all">{bareUrl(page.loginUrl)}</dd>
              </div>
              <dt className="font-semibold">Code</dt>
              <dd className="font-mono text-sm font-black whitespace-nowrap">{page.code}</dd>
            </dl>
          </section>
        </div>
      </div>
    </Paper>
  );
};
// #endregion

// #region cc sheet

export const CcPage = ({ page, event, day, onReady }: { page: CcSheet; event: string; day: Sheets["day"]; onReady: OnReady }) => {
  const overview = useMemo(
    () => ({
      fit: ccFit(page),
      layers: [...workLayers(page), ...page.areas.map((a): PrintLayer => ({ kind: "area", key: `a${a.areaId}`, ring: ring(a.area), tone: "crew", label: a.name, hatch: a.doNotTouch }))],
      cc: { lat: page.lat, lng: page.lng, name: page.name, letter: page.letter },
    }),
    [page],
  );
  return (
    <Paper kind="cc">
      <Header event={event} day={day} />
      <div className="mt-3 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-4xl leading-none font-black tracking-tight">CC {page.name}</h2>
          {page.address && <p className="mt-1 text-base">{page.address}</p>}
          <div className="mt-2 inline-block rounded-md border-2 border-[#0e3038] px-3 py-1.5">
            <Caps>Green code</Caps>
            <div className="font-mono text-3xl font-black tracking-[0.25em]">{page.greenCode ?? ""}</div>
          </div>
        </div>
        <figure className="flex w-[1.6in] shrink-0 flex-col items-center gap-0.5">
          <Qr svg={page.greenQrSvg ?? page.loginQrSvg} label={`QR code for green shirts at CC ${page.name}`} className="aspect-square w-[1.2in]" />
          <figcaption className="text-center">
            <span className="block text-xs font-bold">Green shirts, scan to join</span>
            <span className="block font-mono text-[10px] whitespace-nowrap">{bareUrl(page.loginUrl)}</span>
          </figcaption>
        </figure>
      </div>

      <MapBlock caption={`Overview, ${plural(page.workLots.length, "work lot")}`} fill>
        <PrintMap
          readyKey={ccMapKey(page)}
          onReady={onReady}
          fit={overview.fit}
          layers={overview.layers}
          cc={overview.cc}
          padding={16}
          className="h-[3in] w-full sm:h-auto sm:min-h-0 sm:flex-1"
          label={`Overview map for CC ${page.name}`}
        />
      </MapBlock>
      <div className="mt-1.5">
        <Legend
          letter={page.letter}
          items={[
            ["work", "Todo"],
            ["dnt", "Do not touch"],
            ["crew", "Crew area"],
            ["cc", "CC"],
          ]}
        />
      </div>

      <div className="mt-3 grid grid-cols-1 items-start gap-4 sm:grid-cols-2">
        <table className="w-full text-left text-xs">
          <caption className="pb-0.5 text-left">
            <Caps>Trucks</Caps>
          </caption>
          <tbody>
            {page.trucks.length === 0 ? (
              <tr className="border-t border-[#d1d3d4]">
                <td className="py-1" colSpan={3}>
                  None
                </td>
              </tr>
            ) : (
              page.trucks.map((t) => (
                <tr key={t.code} className="border-t border-[#d1d3d4]">
                  <td className="py-1 pr-2 align-middle">
                    {t.qrSvg && <Qr svg={t.qrSvg} label={`QR code for ${t.name}`} className="aspect-square w-[0.65in]" />}
                  </td>
                  <td className="py-1 pr-2 align-middle">
                    <div className="font-semibold">{t.name}</div>
                    <div>{t.driverName ?? ""}</div>
                  </td>
                  <td className="py-1 text-right align-middle font-mono text-base font-black tracking-[0.2em]">{t.code}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
        <Shirts shirts={page.greenShirts} />
      </div>

      <table className="mt-3 w-full text-left text-xs">
        <caption className="pb-0.5 text-left">
          <Caps>Crews</Caps>
        </caption>
        <thead>
          <tr className="text-[10px] tracking-wider uppercase">
            <th className="py-0.5 pr-2">Crew</th>
            <th className="py-0.5 pr-2">Red shirt</th>
            <th className="py-0.5 pr-2">Phone</th>
            <th className="py-0.5 pr-2 text-right">People</th>
            <th className="py-0.5 text-right">Lots</th>
          </tr>
        </thead>
        <tbody>
          {page.crews.length === 0 ? (
            <tr className="border-t border-[#d1d3d4]">
              <td className="py-1" colSpan={5}>
                None
              </td>
            </tr>
          ) : (
            page.crews.map((c) => (
              <tr key={c.crewId} className="border-t border-[#d1d3d4]">
                <td className="py-1 pr-2 font-semibold">{c.name}</td>
                <td className="py-1 pr-2">{c.leadName ?? ""}</td>
                <td className="py-1 pr-2 font-mono whitespace-nowrap">{c.leadPhone ? phoneText(c.leadPhone) : ""}</td>
                <td className="py-1 pr-2 text-right tabular-nums">{c.headcount ?? ""}</td>
                <td className="py-1 text-right tabular-nums">{c.lotCount}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </Paper>
  );
};
// #endregion

// #region company sheet
/** One landscape Letter page. On screen it is drawn at paper size from 640 px up. */
const Landscape = ({ children }: { children: ReactNode }) => (
  <article
    data-sheet="company"
    className="lrb-sheet lrb-sheet-land lrb-paper mx-auto flex w-full min-w-0 flex-col overflow-x-auto rounded-xl bg-white p-4 shadow-lg ring-1 ring-black/10 sm:h-[8.5in] sm:w-[11in] sm:overflow-hidden sm:p-[0.4in]"
  >
    {children}
  </article>
);

const AreaSwatch = ({ tone }: { tone: "company" | "faint" | "tint" | "work" | "dnt" | "cc" }) => (
  <svg viewBox="0 0 26 16" width="26" height="16" aria-hidden="true" className="shrink-0">
    {tone === "dnt" ? (
      <>
        <rect x="3" y="3" width="20" height="10" fill={DNT} fillOpacity="0.12" stroke={DNT} strokeWidth="1.2" />
        <path d="M3 10l7-7M8 13l10-10M15 13l8-8" stroke={DNT} strokeWidth="1" />
      </>
    ) : tone === "company" ? (
      <rect x="3" y="3" width="20" height="10" fill="none" stroke={BLUE} strokeWidth="3" />
    ) : tone === "faint" ? (
      <rect x="3" y="3" width="20" height="10" fill="none" stroke={GREY} strokeWidth="1.2" />
    ) : tone === "work" ? (
      <rect x="3" y="3" width="20" height="10" fill={WORK} fillOpacity={LOT_FILL.work} stroke={INK} strokeWidth="1" />
    ) : tone === "tint" ? (
      <rect x="1" y="1" width="24" height="14" fill={YELLOW} fillOpacity="0.3" stroke="none" />
    ) : (
      <circle cx="13" cy="8" r="7" fill={BLUE} stroke="#fff" strokeWidth="1.5" />
    )}
  </svg>
);

/**
 * SPEC 19, modelled on the printed "group maps" sheet: title with the
 * weekday and the CC's letter, the CC's address at the right, the company and
 * its crews with headcounts down the left, and the CC's day on the map: the
 * day's area tinted, this company's areas in thick blue with their names on
 * the top edge, other companies' areas thin grey, the CC as a blue lettered circle.
 */
export const CompanyPage = ({ page, cc, day, onReady }: { page: CompanySheet; cc: CcSheet; day: Sheets["day"]; onReady: OnReady }) => {
  const map = useMemo(() => {
    const [w, s, e, n] = cc.dayBounds;
    const mine = new Set(page.areaIds);
    const layers: PrintLayer[] = [
      { kind: "tint", key: "day", rings: cc.dayArea.map((r) => r.map(([lng, lat]) => [lat, lng] as LatLngPair)) },
      ...workLayers(cc),
      ...cc.areas.map((a): PrintLayer => ({ kind: "area", key: `a${a.areaId}`, ring: ring(a.area), tone: mine.has(a.areaId) ? "company" : "faint", label: mine.has(a.areaId) ? a.name : undefined, hatch: a.doNotTouch })),
    ];
    const fit: LatLngPair[] = [
      [s, w],
      [n, e],
    ];
    return { fit, layers, cc: { lat: cc.lat, lng: cc.lng, name: cc.name, letter: cc.letter, blue: true } };
  }, [page, cc]);
  const title = `${weekday(day.date)} group maps, ${cc.letter ?? cc.name}`;
  return (
    <Landscape>
      <header className="flex items-end justify-between gap-4 border-b-2 border-[#0e3038] pb-2">
        <h2 className="text-3xl leading-none font-black tracking-tight">{title}</h2>
        <p className="text-right text-lg leading-tight font-bold">
          CC{cc.address ? `, ${cc.address}` : `, ${cc.name}`}
        </p>
      </header>
      <div className="mt-3 flex min-h-0 flex-1 flex-col gap-4 sm:flex-row">
        <section aria-label="Legend" className="flex shrink-0 flex-col sm:w-[2.3in]">
          <div className="flex items-baseline justify-between gap-2 border-b-2 border-[#1f6fe5] pb-1 text-lg font-black text-[#1f6fe5]">
            <span className="min-w-0 truncate">{page.companyName}</span>
            <span className="tabular-nums">{page.headcount}</span>
          </div>
          <table className="mt-1 w-full text-left text-sm">
            <caption className="sr-only">Crews</caption>
            <tbody>
              {page.crews.map((c) => (
                <tr key={c.crewId} className="border-b border-[#d1d3d4]">
                  <td className="py-1 pr-2 font-bold">{c.name}</td>
                  <td className="py-1 text-right tabular-nums">{c.headcount ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <ul className="mt-auto space-y-1.5 pt-4 text-xs font-semibold">
            <li className="flex items-center gap-2">
              <AreaSwatch tone="company" />
              {page.short} areas
            </li>
            <li className="flex items-center gap-2">
              <AreaSwatch tone="faint" />
              Other companies
            </li>
            <li className="flex items-center gap-2">
              <AreaSwatch tone="work" />
              Todo
            </li>
            <li className="flex items-center gap-2">
              <AreaSwatch tone="dnt" />
              Do not touch
            </li>
            <li className="flex items-center gap-2">
              <AreaSwatch tone="tint" />
              {day.label} area
            </li>
            <li className="flex items-center gap-2">
              <AreaSwatch tone="cc" />
              CC {cc.name}
            </li>
          </ul>
        </section>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-md ring-1 ring-[#0e3038]">
          <PrintMap
            readyKey={companyMapKey(page)}
            onReady={onReady}
            fit={map.fit}
            layers={map.layers}
            cc={map.cc}
            padding={20}
            className="h-[5in] w-full sm:h-auto sm:min-h-0 sm:flex-1"
            label={`${page.companyName} areas at CC ${cc.name}`}
          />
        </div>
      </div>
    </Landscape>
  );
};
// #endregion
