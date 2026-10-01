import type { Map as LeafletMap } from "leaflet";
import { keepPreviousData } from "@tanstack/react-query";
import { useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { Button, ButtonLink } from "../../../components/Button.tsx";
import { EmptyState } from "../../../components/EmptyState.tsx";
import { Panel, Stat } from "../../../components/Panel.tsx";
import { Skeleton } from "../../../components/Skeleton.tsx";
import { MapView } from "../../../lib/map/MapView.tsx";
import { trpc } from "../../../lib/trpc.ts";
import { noEvent } from "../common.ts";
import { CapacityInputs, Legend } from "./parts.tsx";
import {
  assignedLabel,
  BAND_LABEL,
  crewLoad,
  loadText,
  parityLabel,
  SWATCH,
  titleCase,
  useCapacity,
  useFitOnce,
  useSidesLayer,
  type DrawnSide,
  type Side,
  type SideClick,
} from "./sides.ts";

// #region table
type Col = "street" | "from" | "to" | "side" | "high" | "low" | "work" | "parcels" | "assigned";

const COLS: ReadonlyArray<{ col: Col; label: string; num?: boolean }> = [
  { col: "street", label: "Street" },
  { col: "from", label: "From" },
  { col: "to", label: "To" },
  { col: "side", label: "Side" },
  { col: "high", label: "High", num: true },
  { col: "low", label: "Low", num: true },
  { col: "work", label: "Work", num: true },
  { col: "parcels", label: "Parcels", num: true },
  { col: "assigned", label: "Assigned" },
];

const sortValue = (s: Side, col: Col): string | number => {
  switch (col) {
    case "street":
      return s.street;
    case "from":
      return s.fromCross ?? (s.block !== null ? String(s.block).padStart(6, "0") : "");
    case "to":
      return s.toCross ?? "";
    case "side":
      return s.parity;
    case "high":
      return s.high;
    case "low":
      return s.low;
    case "work":
      return s.workCount;
    case "parcels":
      return s.parcelCount;
    case "assigned":
      return assignedLabel(s.assignment) ?? "";
  }
};

const compare = (a: Side, b: Side, col: Col, dir: 1 | -1): number => {
  const x = sortValue(a, col);
  const y = sortValue(b, col);
  const c = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
  // Empty text sorts last either way; ties fall back to most work, then street.
  if (c !== 0) {
    if (x === "" && y !== "") return 1;
    if (y === "" && x !== "") return -1;
    return c * dir;
  }
  return b.workCount - a.workCount || a.street.localeCompare(b.street) || a.key.localeCompare(b.key);
};
/** A cross street, cut to one line; the full name is in the title. */
const CrossCell = ({ name, block = null }: { name: string | null; block?: number | null }) => {
  const text = name ? titleCase(name) : block !== null ? `${block} block` : null;
  return text ? (
    <td className="max-w-28 truncate px-1.5 py-2 whitespace-nowrap" title={text}>
      {text}
    </td>
  ) : (
    <td className="px-1.5 py-2 text-muted">None</td>
  );
};
// #endregion

export const BlocksPage = () => {
  const [cap, setCap] = useCapacity();
  const list = trpc.plan.blocks.list.useQuery(undefined, { retry: false });
  const shapes = trpc.plan.blocks.shapes.useQuery(undefined, { retry: false, staleTime: 60_000 });
  const totals = trpc.plan.blocks.totals.useQuery({ perCrewParcels: cap.parcels, perCrewHigh: cap.high }, { retry: false, placeholderData: keepPreviousData });
  const [sort, setSort] = useState<{ col: Col; dir: 1 | -1 }>({ col: "work", dir: -1 });
  const [sel, setSel] = useState<Set<string>>(() => new Set());
  const anchor = useRef<string | null>(null);
  const rows = useRef(new Map<string, HTMLTableRowElement>());
  const [map, setMap] = useState<LeafletMap | null>(null);

  const sides = list.data ?? [];
  const byKey = useMemo(() => new Map(sides.map((s) => [s.key, s])), [sides]);
  const sorted = useMemo(() => [...sides].sort((a, b) => compare(a, b, sort.col, sort.dir)), [sides, sort]);

  const drawn = useMemo<DrawnSide[]>(
    () =>
      (shapes.data ?? []).flatMap((sh) => {
        const s = byKey.get(sh.key);
        return s ? [{ key: sh.key, ring: sh.ring, classes: `lrb-side-${s.band}${sel.has(sh.key) ? " lrb-side-sel" : ""}` }] : [];
      }),
    [shapes.data, byKey, sel],
  );

  const focus = (s: Side): void => {
    if (!map) return;
    const at: [number, number] = [s.center.lat, s.center.lng];
    if (map.getZoom() < 16) map.setView(at, 16);
    else map.panTo(at);
  };

  const onMapSide = ({ key, toggle }: SideClick): void => {
    setSel((prev) => {
      if (!toggle) return new Set([key]);
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    anchor.current = key;
    rows.current.get(key)?.scrollIntoView({ block: "nearest" });
  };
  useSidesLayer(map, drawn, onMapSide);

  const fitPoints = useMemo<Array<[number, number]>>(
    () =>
      sides.flatMap((s): Array<[number, number]> => [
        [s.bbox[1], s.bbox[0]],
        [s.bbox[3], s.bbox[2]],
      ]),
    [sides],
  );
  useFitOnce(map, sides.length > 0 ? "all" : null, fitPoints);

  const onRow = (s: Side, e: MouseEvent): void => {
    if (e.shiftKey && anchor.current && byKey.has(anchor.current)) {
      const keys = sorted.map((r) => r.key);
      const a = keys.indexOf(anchor.current);
      const b = keys.indexOf(s.key);
      const range = keys.slice(Math.min(a, b), Math.max(a, b) + 1);
      setSel((prev) => new Set([...prev, ...range]));
    } else if (e.metaKey || e.ctrlKey) {
      setSel((prev) => {
        const next = new Set(prev);
        if (next.has(s.key)) next.delete(s.key);
        else next.add(s.key);
        return next;
      });
      anchor.current = s.key;
    } else {
      setSel(new Set([s.key]));
      anchor.current = s.key;
    }
    focus(s);
  };

  const picked = useMemo(() => sides.filter((s) => sel.has(s.key)), [sides, sel]);
  const pickedHigh = picked.reduce((n, s) => n + s.high, 0);
  const pickedLow = picked.reduce((n, s) => n + s.low, 0);

  const sortBy = (col: Col): void =>
    setSort((prev) => (prev.col === col ? { col, dir: prev.dir === 1 ? -1 : 1 } : { col, dir: COLS.find((c) => c.col === col)?.num ? -1 : 1 }));

  let body: ReactNode;
  if (list.isLoading) {
    body = (
      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[minmax(0,4fr)_minmax(0,7fr)]">
        <Skeleton className="h-[50dvh] lg:h-full" />
        <Skeleton className="h-[50dvh] lg:h-full" />
      </div>
    );
  } else if (noEvent(list.error)) {
    body = (
      <Panel>
        <EmptyState title="No active event" />
      </Panel>
    );
  } else if (list.isError) {
    body = (
      <Panel>
        <EmptyState title="Blocks not loaded" description="Check the connection" action={<Button onClick={() => void list.refetch()}>Retry</Button>} />
      </Panel>
    );
  } else if (sides.length === 0) {
    body = (
      <Panel>
        <EmptyState title="No block sides surveyed" action={<ButtonLink href="/plan/survey">Survey</ButtonLink>} />
      </Panel>
    );
  } else {
    body = (
      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[minmax(0,4fr)_minmax(0,7fr)]">
        <div className="flex min-h-0 flex-col gap-2">
          <div className="relative h-[50dvh] min-h-72 overflow-hidden rounded-2xl ring-1 ring-line lg:h-auto lg:flex-1">
            <MapView markers={[]} label="Block sides map" className="absolute inset-0" onReady={setMap} />
          </div>
          <Legend
            items={[
              ...(["none", "light", "mid", "dark"] as const).map((b) => ({ swatch: SWATCH[b], label: BAND_LABEL[b] })),
              { swatch: SWATCH.sel, label: "Selected" },
            ]}
          />
        </div>

        <section aria-label="Block sides" className="flex min-h-0 flex-col overflow-hidden rounded-2xl bg-surface ring-1 ring-line">
          <div className="flex min-h-14 flex-wrap items-center gap-x-4 gap-y-1 border-b border-line px-4 py-2" role="status" aria-live="polite">
            {picked.length === 0 ? (
              <span className="font-semibold">
                {sides.length.toLocaleString("en-US")} block sides
              </span>
            ) : (
              <>
                <span className="font-semibold">{picked.length === 1 ? "1 side" : `${picked.length} sides`}</span>
                <span className="text-sm text-muted tabular-nums">
                  {pickedHigh + pickedLow} work, {pickedHigh} high, {loadText(crewLoad(pickedHigh, pickedLow, cap))} crews
                </span>
                <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setSel(new Set())}>
                  Clear
                </Button>
              </>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 z-10 bg-surface-2 text-left text-xs text-muted uppercase">
                <tr>
                  {COLS.map((c) => {
                    const on = sort.col === c.col;
                    return (
                      <th key={c.col} aria-sort={on ? (sort.dir === 1 ? "ascending" : "descending") : "none"} className={`px-1.5 py-1 font-semibold whitespace-nowrap first:pl-4 last:pr-4 ${c.num ? "text-right" : ""}`}>
                        <button type="button" onClick={() => sortBy(c.col)} className={`relative inline-flex min-h-10 items-center uppercase ${on ? "text-ink" : ""}`}>
                          {c.label}
                          {on && (
                            <span aria-hidden="true" className="absolute bottom-0 left-1/2 -translate-x-1/2 text-[9px] leading-none">
                              {sort.dir === 1 ? "▲" : "▼"}
                            </span>
                          )}
                        </button>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {sorted.map((s) => {
                  const on = sel.has(s.key);
                  const who = assignedLabel(s.assignment);
                  return (
                    <tr
                      key={s.key}
                      ref={(el) => {
                        if (el) rows.current.set(s.key, el);
                        else rows.current.delete(s.key);
                      }}
                      onClick={(e) => onRow(s, e)}
                      aria-selected={on}
                      className={`cursor-pointer border-t border-line select-none ${on ? "bg-brand/25" : "hover:bg-surface-2"}`}
                    >
                      <td className="max-w-32 truncate py-2 pr-1.5 pl-4 font-semibold whitespace-nowrap" title={titleCase(s.street)}>
                        {titleCase(s.street)}
                      </td>
                      <CrossCell name={s.fromCross} block={s.block} />
                      <CrossCell name={s.toCross} />
                      <td className="px-1.5 py-2">{parityLabel(s.parity)}</td>
                      <td className="px-1.5 py-2 text-right tabular-nums">{s.high}</td>
                      <td className="px-1.5 py-2 text-right tabular-nums">{s.low}</td>
                      <td className="px-1.5 py-2 text-right font-semibold tabular-nums">
                        <span className="inline-flex items-center gap-1.5">
                          <span aria-hidden="true" className={`h-2.5 w-2.5 rounded-sm ${SWATCH[s.band]}`} />
                          {s.workCount}
                        </span>
                      </td>
                      <td className="px-1.5 py-2 text-right tabular-nums">{s.parcelCount}</td>
                      <td className="min-w-20 py-2 pr-4 pl-1.5">{s.assignment && who ? (
                          <>
                            <span>{assignedLabel(s.assignment, false)}</span>{" "}
                            <span className="whitespace-nowrap text-muted">{s.assignment.dayLabel}</span>
                          </>
                        ) : (
                          <span className="text-muted">None</span>
                        )}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    );
  }

  const t = totals.data;
  return (
    <div className="flex min-h-full flex-col gap-4 px-4 py-4 nav:px-6 nav:py-5 lg:h-full">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h1 className="text-2xl font-bold tracking-tight">Blocks</h1>
        <CapacityInputs value={cap} onChange={setCap} />
      </div>
      {t && t.sides > 0 && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
          <Stat value={t.workParcels} label="Work parcels" />
          <Stat value={t.high} label="High" tone="crew" />
          <Stat value={t.low} label="Low" tone="warn" />
          <Stat value={t.sidesDark} label="Sides 10+" />
          <Stat value={`${t.assignedSides} of ${t.sides}`} label="Sides assigned" tone="green" />
          <Stat value={t.crewsNeeded} label="Crews needed" tone="brand" />
        </div>
      )}
      {body}
    </div>
  );
};
