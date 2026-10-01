import { useCallback, useMemo, useRef, useState } from "react";
import { Button, ButtonLink } from "../../../components/Button.tsx";
import { EmptyState } from "../../../components/EmptyState.tsx";
import { Field } from "../../../components/Field.tsx";
import { Page } from "../../../components/Page.tsx";
import { Panel, Stat } from "../../../components/Panel.tsx";
import { Chips } from "../../../components/Segmented.tsx";
import { Sheet } from "../../../components/Sheet.tsx";
import { SkeletonList } from "../../../components/Skeleton.tsx";
import { plural } from "../../../components/admin/format.ts";
import { RectIcon } from "../../../components/admin/icons.tsx";
import { MapMode } from "../../../components/admin/MapMode.tsx";
import { errorText, Notice, type NoticeValue } from "../../../components/admin/Notice.tsx";
import { bboxText, useRectDraw, type BBox } from "../../../components/admin/rect.ts";
import { dateTime, lotTitle } from "../../../lib/format.ts";
import { trpc, type RouterOutputs } from "../../../lib/trpc.ts";
import { noEvent } from "../common.ts";
import { GradeSheet, type SheetParcel } from "./GradeSheet.tsx";
import { GRADE_LABEL, GRADES, type Grade } from "./style.ts";
import { SurveyMap, type MapParcel } from "./SurveyMap.tsx";

type Row = RouterOutputs["plan"]["survey"]["list"][number];

/** The server refuses a bigger rectangle (about 5 km a side). */
const MAX_LOAD_DEG = 0.06;
/** Unsurveyed parcels are drawn from this zoom in, so a laptop can grade a parcel nobody drove past. */
const CONTEXT_ZOOM = 17;
const PAGE_ROWS = 100;

const GRADE_DOT: Record<Grade, string> = { high: "bg-crew", low: "bg-warn", clear: "bg-muted" };

const GradeTag = ({ grade }: { grade: Grade }) => (
  <span className="inline-flex items-center gap-1.5 font-semibold">
    <span aria-hidden="true" className={`h-2.5 w-2.5 rounded-sm ${GRADE_DOT[grade]}`} />
    {GRADE_LABEL[grade]}
  </span>
);

// #region load parcels sheet
const LoadSheet = ({ bbox, onClose, onRedraw, notify }: { bbox: BBox | null; onClose: () => void; onRedraw: () => void; notify: (n: NoticeValue) => void }) => {
  const utils = trpc.useUtils();
  const load = trpc.plan.parcels.loadBbox.useMutation({
    onSuccess: (r) => {
      void utils.plan.parcels.invalidate();
      void utils.plan.survey.invalidate();
      notify({ tone: "ok", text: r.fetched === 0 ? "No parcels in that area" : `${plural(r.fetched, "parcel")} loaded` });
      onClose();
    },
    onError: (e) => notify({ tone: "error", text: errorText(e, "Parcel layer not answering. Try again in a minute.") }),
  });
  if (!bbox) return null;
  const tooBig = bbox[2] - bbox[0] > MAX_LOAD_DEG || bbox[3] - bbox[1] > MAX_LOAD_DEG;
  return (
    <Sheet
      open
      onClose={onClose}
      title="Load parcels"
      footer={
        tooBig ? (
          <Button block size="lg" variant="secondary" onClick={onRedraw}>
            Redraw
          </Button>
        ) : (
          <Button block size="lg" busy={load.isPending} onClick={() => load.mutate({ bbox })}>
            {load.isPending ? "Loading…" : "Load parcels"}
          </Button>
        )
      }
    >
      <div className="space-y-3 pb-2">
        <Stat value={bboxText(bbox)} label="Area" />
        {tooBig && <p className="font-semibold">Area too large. Draw a smaller rectangle.</p>}
      </div>
    </Sheet>
  );
};
// #endregion

export const SurveyPage = () => {
  const utils = trpc.useUtils();
  const [dayId, setDayId] = useState<number | null>(null);
  const daysQ = trpc.admin.days.list.useQuery(undefined, { retry: false });
  const list = trpc.plan.survey.list.useQuery(dayId === null ? undefined : { dayId }, { retry: false });
  const sidesQ = trpc.plan.survey.sides.useQuery(dayId === null ? undefined : { dayId }, { retry: false });
  const cache = trpc.plan.parcels.stats.useQuery();
  const [view, setView] = useState<{ bbox: BBox; zoom: number } | null>(null);
  const contextQ = trpc.plan.parcels.inBbox.useQuery(
    { bbox: view?.bbox ?? [0, 0, 0, 0], limit: 1500 },
    { enabled: view !== null && view.zoom >= CONTEXT_ZOOM, placeholderData: (prev) => prev, staleTime: 60_000 },
  );
  const [drawing, setDrawing] = useState(false);
  const [sheetBBox, setSheetBBox] = useState<BBox | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [focus, setFocus] = useState<{ lat: number; lng: number; n: number } | null>(null);
  const [gradeFilter, setGradeFilter] = useState<Grade | "all">("all");
  const [search, setSearch] = useState("");
  const [shown, setShown] = useState(PAGE_ROWS);
  const [notice, setNotice] = useState<NoticeValue>(null);
  const clearNotice = useCallback(() => setNotice(null), []);
  const rect = useRectDraw();

  const rows = list.data ?? [];
  const surveyed = useMemo<MapParcel[]>(() => {
    const out: MapParcel[] = [];
    for (const r of rows) if (r.lat !== null && r.lng !== null) out.push({ parcelId: r.parcelId, lat: r.lat, lng: r.lng, geometry: r.geometry, grade: r.grade, address: r.address });
    return out;
  }, [rows]);
  const surveyedIds = useMemo(() => new Set(rows.map((r) => r.parcelId)), [rows]);
  const context = useMemo<MapParcel[]>(
    () =>
      view && view.zoom >= CONTEXT_ZOOM
        ? (contextQ.data?.parcels ?? [])
            .filter((p) => !surveyedIds.has(p.parcelId))
            .map((p) => ({ parcelId: p.parcelId, lat: p.lat, lng: p.lng, geometry: p.geometry, grade: null, address: p.address }))
        : [],
    [contextQ.data, surveyedIds, view],
  );
  const sides = sidesQ.data?.sides ?? [];
  const rules = sidesQ.data?.rules;
  const mapSides = useMemo(() => sides.map((s) => ({ key: s.key, band: s.band, outline: s.outline })), [sides]);

  const count = (g: Grade): number => rows.filter((r) => r.grade === g).length;
  const darkSides = sides.filter((s) => s.band === "dark").length;

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => (gradeFilter === "all" || r.grade === gradeFilter) && (!q || (r.address ?? r.parcelId).toLowerCase().includes(q)));
  }, [rows, gradeFilter, search]);

  const selected = useMemo<SheetParcel | null>(() => {
    if (!selectedId) return null;
    const r = rows.find((x) => x.parcelId === selectedId);
    if (r) return { parcelId: r.parcelId, address: lotTitle(r), grade: r.grade, note: r.note };
    const c = context.find((x) => x.parcelId === selectedId);
    return c ? { parcelId: c.parcelId, address: lotTitle({ address: c.address, parcelId: c.parcelId }), grade: null } : null;
  }, [selectedId, rows, context]);

  const tag = trpc.plan.survey.tag.useMutation({
    onSuccess: () => {
      void utils.plan.survey.invalidate();
      void utils.plan.parcels.inBbox.invalidate();
      setSelectedId(null);
    },
  });

  const mapBox = useRef<HTMLDivElement>(null);
  const openRow = (r: Row): void => {
    mapBox.current?.scrollIntoView({ block: "nearest" });
    setSelectedId(r.parcelId);
    if (r.lat !== null && r.lng !== null) setFocus({ lat: r.lat, lng: r.lng, n: Date.now() });
  };

  const stopDrawing = (): void => {
    setDrawing(false);
    rect.reset();
  };

  const onMapClick = (lat: number, lng: number): void => {
    const b = rect.tap(lat, lng);
    if (b) setSheetBBox(b);
  };

  const rectPoints = rect.lines[0]?.points ?? null;

  if (noEvent(list.error)) {
    return (
      <Page title="Survey" wide>
        <Panel>
          <EmptyState title="No active event" />
        </Panel>
      </Page>
    );
  }

  const days = daysQ.data ?? [];

  return (
    <Page
      title="Survey"
      wide
      actions={
        <>
          <Button size="sm" variant={drawing ? "primary" : "secondary"} onClick={() => (drawing ? stopDrawing() : (rect.reset(), setDrawing(true)))}>
            <RectIcon />
            Load parcels
          </Button>
          <ButtonLink href="/plan/survey/drive" size="sm">
            Drive mode
          </ButtonLink>
        </>
      }
    >
      <div className="space-y-4">
        <Notice value={notice} onClear={clearNotice} />
        {list.isLoading ? (
          <SkeletonList rows={1} className="h-16" />
        ) : (
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-7">
            <Stat value={rows.length} label="Surveyed" />
            <Stat value={count("high")} label="High" tone="crew" />
            <Stat value={count("low")} label="Low" tone="warn" />
            <Stat value={count("clear")} label="Clear" tone="muted" />
            <Stat value={sides.length} label="Block sides" />
            <Stat value={darkSides} label={`Sides with ${rules?.darkAt ?? 10}+`} tone="crew" />
            <Stat value={cache.data?.count ?? 0} label="Parcels loaded" />
          </div>
        )}
        {days.length > 1 && (
          <Chips
            label="Day"
            value={dayId ?? "all"}
            onChange={(v) => {
              setDayId(v === "all" ? null : v);
              setShown(PAGE_ROWS);
            }}
            options={[{ value: "all" as const, label: "All days" }, ...days.map((d) => ({ value: d.id, label: d.label }))]}
          />
        )}
        <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[minmax(0,1fr)_15rem]">
          <div ref={mapBox} className="relative h-[62dvh] min-h-96 overflow-hidden rounded-2xl ring-1 ring-line">
            <SurveyMap
              parcels={surveyed}
              context={context}
              sides={mapSides}
              selectedId={selectedId}
              onParcel={setSelectedId}
              onMapClick={drawing ? onMapClick : undefined}
              rect={rectPoints}
              corner={rect.step === 2 ? rect.corner : null}
              onView={(bbox, zoom) => setView({ bbox, zoom })}
              focus={focus}
              fitKey={`day-${dayId ?? "all"}`}
            />
            {drawing && <MapMode label="Load parcels" detail={rect.step === 1 ? "Corner 1 of 2" : "Corner 2 of 2"} onCancel={stopDrawing} />}
          </div>
          <Panel title="Key">
            <ul className="space-y-2 text-sm">
              {GRADES.map((g) => (
                <li key={g} className="flex items-baseline justify-between gap-2">
                  <GradeTag grade={g} />
                  <span className="text-right text-muted">{rules?.gradeMeaning[g] ?? ""}</span>
                </li>
              ))}
            </ul>
            <h3 className="mt-4 mb-2 text-sm font-semibold">Block side, work parcels</h3>
            <ul className="space-y-2 text-sm">
              {(["none", "light", "mid", "dark"] as const).map((b) => (
                <li key={b} className="flex items-center gap-2">
                  <span
                    aria-hidden="true"
                    className={`h-3 w-8 rounded-sm ${b === "none" ? "border border-dashed border-muted" : b === "light" ? "border-2 border-crew/45" : b === "mid" ? "border-[3px] border-crew/75" : "border-4 border-crew"}`}
                  />
                  {rules?.bands[b] ?? ""}
                </li>
              ))}
            </ul>
          </Panel>
        </div>
        <Panel
          title={list.isLoading ? "Parcels" : plural(filtered.length, "parcel")}
          flush
          actions={
            rows.length > 0 ? (
              <Chips
                label="Grade"
                value={gradeFilter}
                onChange={(v) => {
                  setGradeFilter(v);
                  setShown(PAGE_ROWS);
                }}
                options={[{ value: "all" as const, label: "All" }, ...GRADES.map((g) => ({ value: g, label: GRADE_LABEL[g] }))]}
              />
            ) : undefined
          }
        >
          {list.isLoading ? (
            <div className="p-4">
              <SkeletonList rows={4} className="h-10" />
            </div>
          ) : rows.length === 0 && dayId !== null ? (
            <EmptyState title={`No parcels on ${days.find((d) => d.id === dayId)?.label ?? "this day"}`} />
          ) : rows.length === 0 ? (
            <EmptyState
              title="No parcels surveyed"
              action={
                <ButtonLink href="/plan/survey/drive" variant="secondary">
                  Drive mode
                </ButtonLink>
              }
            />
          ) : (
            <>
              <div className="border-b border-line p-3">
                <Field
                  label="Search"
                  type="search"
                  value={search}
                  onChange={(e) => {
                    setSearch(e.target.value);
                    setShown(PAGE_ROWS);
                  }}
                  autoComplete="off"
                  className="max-w-sm"
                />
              </div>
              {filtered.length === 0 ? (
                <EmptyState title="No matches" />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead className="bg-surface-2 text-muted">
                      <tr>
                        <th className="px-4 py-2 font-semibold">Address</th>
                        <th className="px-4 py-2 font-semibold">Grade</th>
                        <th className="px-4 py-2 font-semibold">By</th>
                        <th className="px-4 py-2 font-semibold">When</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line">
                      {filtered.slice(0, shown).map((r) => (
                        <tr
                          key={r.parcelId}
                          onClick={() => openRow(r)}
                          className={`cursor-pointer hover:bg-surface-2 ${r.parcelId === selectedId ? "bg-brand/25" : ""}`}
                        >
                          <td className="px-4 py-2">
                            <button type="button" className="min-h-10 text-left font-semibold" onClick={(e) => (e.stopPropagation(), openRow(r))}>
                              {lotTitle(r)}
                            </button>
                            {r.note && <div className="max-w-md truncate text-muted">{r.note}</div>}
                          </td>
                          <td className="px-4 py-2">
                            <GradeTag grade={r.grade} />
                          </td>
                          <td className="px-4 py-2">{r.by}</td>
                          <td className="px-4 py-2 whitespace-nowrap tabular-nums">{dateTime(r.at)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {filtered.length > shown && (
                    <div className="border-t border-line p-3 text-center">
                      <Button variant="secondary" onClick={() => setShown((n) => n + PAGE_ROWS)}>
                        {`Show ${Math.min(PAGE_ROWS, filtered.length - shown)} more`}
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </Panel>
      </div>
      <LoadSheet
        bbox={sheetBBox}
        onClose={() => {
          setSheetBBox(null);
          stopDrawing();
        }}
        onRedraw={() => {
          setSheetBBox(null);
          rect.reset();
        }}
        notify={setNotice}
      />
      <GradeSheet
        parcel={selected}
        onClose={() => {
          setSelectedId(null);
          tag.reset();
        }}
        onSave={(grade, note) => selected && tag.mutate({ parcelId: selected.parcelId, grade, note, side: "tap" })}
        busy={tag.isPending}
        error={tag.error ? errorText(tag.error) : null}
        showHistory
      />
    </Page>
  );
};
