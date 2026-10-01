import type { Map as LeafletMap } from "leaflet";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button, ButtonLink } from "../../../components/Button.tsx";
import { EmptyState } from "../../../components/EmptyState.tsx";
import { RectIcon } from "../../../components/admin/icons.tsx";
import { MapMode } from "../../../components/admin/MapMode.tsx";
import { errorText, Notice, type NoticeValue } from "../../../components/admin/Notice.tsx";
import { Panel, Stat } from "../../../components/Panel.tsx";
import { Sheet } from "../../../components/Sheet.tsx";
import { Skeleton } from "../../../components/Skeleton.tsx";
import { Switch } from "../../../components/Switch.tsx";
import { ToggleChip } from "../../../components/Segmented.tsx";
import { MapView, type MapMarker } from "../../../lib/map/MapView.tsx";
import { useOnewayLayer } from "../../../lib/map/onewayLayer.ts";
import { AlleyLayer } from "../../../components/alleys/AlleyLayer.tsx";
import {
  insideRect,
  rectFromRing,
  rectPolygon,
  rectSize,
  STEP_LABEL,
  useOrientedRect,
  type OrientedRect,
} from "../../../lib/map/orientedRect.ts";
import { trpc, type RouterOutputs } from "../../../lib/trpc.ts";
import { useAdminLive } from "../../admin/live.ts";
import { noEvent } from "../common.ts";
import { CapacityBar, InlineNumber, InlineSelect, Legend } from "../blocks/parts.tsx";
import {
  BAND_LABEL,
  crewLoad,
  loadText,
  SWATCH,
  useAreasLayer,
  useCapacity,
  useFitOnce,
  useSidesLayer,
  type Capacity,
  type DrawnArea,
  type DrawnSide,
  type Side,
  type SideClick,
} from "../blocks/sides.ts";

type Company = RouterOutputs["plan"]["assignments"]["companies"][number];
type CrewRow = RouterOutputs["plan"]["crews"]["list"][number];
type Cc = RouterOutputs["admin"]["ccs"]["list"][number];

/** "GM 9, GM 10 & GM 11", the way the sheet names a shared area. */
const joinNames = (names: readonly string[]): string => (names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} & ${names[names.length - 1]}`);

const plural = (n: number, one: string, many = `${one}s`): string => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

// #region company card
const CompanyCard = ({
  company,
  ccId,
  ccName,
  cap,
  work,
  target,
  targetCrews,
  areaCrew,
  onPick,
  onPickCrew,
  onArea,
  onHeadcount,
  onBuild,
  building,
  cardRef,
}: {
  cardRef: (el: HTMLLIElement | null) => void;
  company: Company;
  ccId: number;
  ccName: (id: number) => string;
  cap: Capacity;
  /** Assigned work per crew id. */
  work: Map<number, { high: number; low: number }>;
  target: boolean;
  /** Crews picked for Assign to; several share one area. */
  targetCrews: ReadonlySet<number>;
  areaCrew: number | null;
  onPick: () => void;
  onPickCrew: (crewId: number) => void;
  onArea: (crewId: number) => void;
  onHeadcount: (n: number) => void;
  onBuild: () => void;
  building: boolean;
}) => {
  const here = company.crews.filter((c) => c.ccId === ccId);
  const away = company.crews.length - here.length;
  const load = crewLoad(company.assigned.high, company.assigned.low, cap);
  return (
    <li ref={cardRef} className={`scroll-my-2 space-y-2.5 rounded-xl p-3 ${target ? "bg-surface-2 ring-2 ring-ink" : "ring-1 ring-line"}`}>
      <div className="flex items-center justify-between gap-2">
        <button type="button" onClick={onPick} aria-pressed={target} className="min-h-10 min-w-0 flex-1 truncate rounded-lg text-left text-base font-bold hover:underline">
          {company.name}
        </button>
        <InlineNumber label="People" value={company.headcount} onCommit={onHeadcount} />
      </div>
      <CapacityBar load={load} capacity={company.crewCapacity} label={`${plural(company.assigned.sides, "side")}, ${plural(company.assigned.work, "parcel")}`} />
      {here.length > 0 && (
        <ul className="space-y-1">
          {here.map((c) => {
            const w = work.get(c.id) ?? { high: 0, low: 0 };
            const l = crewLoad(w.high, w.low, cap);
            const over = l > 1 + 1e-9;
            const picked = targetCrews.has(c.id);
            return (
              <li key={c.id} className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => onPickCrew(c.id)}
                  aria-pressed={picked}
                  className={`flex min-h-10 min-w-0 flex-1 items-center gap-2 rounded-lg px-2 text-left text-sm ${picked ? "bg-brand text-on-brand" : "hover:bg-surface-2"}`}
                >
                  <span className="shrink-0 font-semibold">{c.name}</span>
                  <span className={`min-w-0 truncate ${picked ? "" : "text-muted"}`}>{c.leadName ?? ""}</span>
                  {c.areaLabel && c.areaLabel !== c.name && (
                    <span title={c.areaLabel} className="shrink-0 rounded-md px-1.5 py-0.5 text-xs font-bold ring-1 ring-current">
                      Shared
                    </span>
                  )}
                  <span className="ml-auto flex shrink-0 items-center gap-1.5 tabular-nums">
                    {Math.round(w.high + w.low)}
                    <span aria-hidden="true" className="h-1.5 w-10 overflow-hidden rounded-full bg-surface-2 ring-1 ring-line ring-inset">
                      <span className={`block h-full rounded-full ${over ? "bg-warn" : "bg-brand-green"}`} style={{ width: `${Math.min(100, l * 100)}%` }} />
                    </span>
                    {over && <span className="sr-only">Over</span>}
                  </span>
                </button>
                <Button size="sm" variant={areaCrew === c.id ? "primary" : "secondary"} onClick={() => onArea(c.id)} aria-label={`Area, ${c.areaLabel ?? c.name}`}>
                  Area
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      {away > 0 && <p className="text-xs text-muted">{plural(away, "crew")} at {[...new Set(company.crews.filter((c) => c.ccId !== ccId).map((c) => `CC ${ccName(c.ccId)}`))].join(", ")}</p>}
      {company.crews.length === 0 && company.headcount > 0 && (
        <Button size="sm" variant="secondary" busy={building} onClick={onBuild}>
          Build {plural(company.crewCapacity, "crew")}
        </Button>
      )}
    </li>
  );
};
// #endregion

// #region publish sheet
const PublishSheet = ({
  open,
  dayLabel,
  sides,
  crewRows,
  onClose,
  onPublish,
  busy,
}: {
  open: boolean;
  dayLabel: string;
  sides: readonly Side[];
  crewRows: readonly CrewRow[];
  onClose: () => void;
  onPublish: (resetAreas: boolean) => void;
  busy: boolean;
}) => {
  const [reset, setReset] = useState(false);
  const work = sides.reduce((n, s) => n + s.workCount, 0);
  const areaIds = new Set(sides.map((s) => s.assignment?.areaId).filter((x): x is number => x != null));
  const crews = new Set([
    ...sides.map((s) => s.assignment?.crewId).filter((x): x is number => x != null),
    ...crewRows.filter((c) => c.areaId !== null && areaIds.has(c.areaId)).map((c) => c.id),
  ]).size;
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={`Publish ${dayLabel}`}
      footer={
        <Button block size="lg" busy={busy} disabled={sides.length === 0} onClick={() => onPublish(reset)}>
          {sides.length === 0 ? "Nothing assigned" : `Publish ${plural(work, "lot")}`}
        </Button>
      }
    >
      <div className="space-y-4 pb-2">
        <div className="grid grid-cols-3 gap-2">
          <Stat value={sides.length} label="Block sides" />
          <Stat value={work} label="Work parcels" />
          <Stat value={crews} label="Crews" />
        </div>
        <Switch checked={reset} onChange={setReset} label="Reset crew areas" />
      </div>
    </Sheet>
  );
};
// #endregion

export const AssignmentsPage = () => {
  const utils = trpc.useUtils();
  const [cap] = useCapacity();
  const daysQ = trpc.admin.days.list.useQuery(undefined, { retry: false });
  const ccsQ = trpc.admin.ccs.list.useQuery(undefined, { retry: false });
  const sidesQ = trpc.plan.blocks.list.useQuery(undefined, { retry: false });
  const shapesQ = trpc.plan.blocks.shapes.useQuery(undefined, { retry: false, staleTime: 60_000 });
  const allCompanies = trpc.admin.companies.list.useQuery(undefined, { retry: false });

  const [dayPick, setDayPick] = useState<number | null>(null);
  const [ccPick, setCcPick] = useState<number | null>(null);
  const days = daysQ.data ?? [];
  const ccs: Cc[] = ccsQ.data ?? [];
  const dayId = dayPick ?? days.find((d) => ccs.some((c) => c.dayId === d.id))?.id ?? days[0]?.id ?? null;
  const day = days.find((d) => d.id === dayId) ?? null;
  const dayCcs = ccs.filter((c) => c.dayId === dayId);
  const cc = dayCcs.find((c) => c.id === ccPick) ?? dayCcs[0] ?? null;
  const ccId = cc?.id ?? null;
  const ccName = useCallback((id: number): string => ccs.find((c) => c.id === id)?.name ?? "", [ccs]);

  const companiesQ = trpc.plan.assignments.companies.useQuery({ dayId: dayId ?? 0, ccId }, { enabled: dayId !== null && ccId !== null, retry: false });
  const crewsQ = trpc.plan.crews.list.useQuery({ dayId: dayId ?? 0 }, { enabled: dayId !== null, retry: false });
  // Done and Do not touch from the green map, live (SPEC 19 Marks).
  useAdminLive();
  const dayOfQ = trpc.plan.assignments.dayOf.useQuery({ dayId: dayId ?? 0, ccId: ccId ?? 0 }, { enabled: dayId !== null && ccId !== null, retry: false });
  const companies = companiesQ.data ?? [];
  const crews: CrewRow[] = crewsQ.data ?? [];
  const sides = sidesQ.data ?? [];

  const [sel, setSel] = useState<Set<string>>(() => new Set());
  const [selRect, setSelRect] = useState<OrientedRect | null>(null);
  const [drawSel, setDrawSel] = useState(false);
  const [target, setTarget] = useState<number | null>(null);
  const [targetCrewIds, setTargetCrewIds] = useState<ReadonlySet<number>>(() => new Set());
  const [areaCrew, setAreaCrew] = useState<number | null>(null);
  const [areaDraft, setAreaDraft] = useState<OrientedRect | null>(null);
  const [drawArea, setDrawArea] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [notice, setNotice] = useState<NoticeValue>(null);
  const clearNotice = useCallback(() => setNotice(null), []);
  const [map, setMap] = useState<LeafletMap | null>(null);
  useOnewayLayer(map);

  const targetCompany = companies.find((c) => c.companyId === target) ?? null;
  const cards = useRef(new Map<number, HTMLLIElement>());
  useEffect(() => {
    if (target !== null) cards.current.get(target)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [target]);
  const targetCrews = targetCompany ? targetCompany.crews.filter((c) => c.ccId === ccId) : [];
  // Picked crews of the picked company at this CC, in crew order.
  const crewPicks = useMemo(() => targetCrews.filter((c) => targetCrewIds.has(c.id)).map((c) => c.id), [targetCrews, targetCrewIds]);
  const crewPickSet = useMemo(() => new Set(crewPicks), [crewPicks]);
  const toggleCrew = (crewId: number): void =>
    setTargetCrewIds((prev) => {
      const next = new Set(prev);
      if (next.has(crewId)) next.delete(crewId);
      else next.add(crewId);
      return next;
    });

  // #region mutations
  const refresh = (): void => {
    void utils.plan.blocks.invalidate();
    void utils.plan.assignments.dayOf.invalidate();
    void utils.plan.assignments.invalidate();
    void utils.plan.crews.invalidate();
  };
  const fail = (e: unknown): void => setNotice({ tone: "error", text: errorText(e) });
  const assign = trpc.plan.assignments.set.useMutation({ onSettled: refresh, onError: fail });
  const unassign = trpc.plan.assignments.clear.useMutation({ onSettled: refresh, onError: fail });
  const headcount = trpc.plan.assignments.setHeadcount.useMutation({ onSettled: refresh, onError: fail });
  const build = trpc.plan.assignments.buildCrews.useMutation({ onSettled: refresh, onError: fail });
  const publish = trpc.plan.assignments.publish.useMutation({ onSettled: refresh, onError: fail });
  const setArea = trpc.plan.crews.setArea.useMutation({ onSettled: () => void utils.plan.crews.invalidate(), onError: fail });
  // #endregion

  // #region selection
  const clearSelection = (): void => {
    setSel(new Set());
    setSelRect(null);
    setDrawSel(false);
  };
  const onSide = ({ key, toggle }: SideClick): void => {
    if (!toggle) {
      setSelRect(null);
      setSel((prev) => (prev.size === 1 && prev.has(key) ? new Set() : new Set([key])));
      return;
    }
    setSel((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const onSelRect = (r: OrientedRect): void => {
    setSelRect(r);
    setDrawSel(false);
    setSel(new Set(insideRect(sides.map((s) => ({ key: s.key, lat: s.center.lat, lng: s.center.lng })), r).map((s) => s.key)));
  };
  const selTool = useOrientedRect(map, { drawing: drawSel, value: areaCrew === null ? selRect : null, editable: true, onChange: onSelRect, onCancel: () => setDrawSel(false) });
  // #endregion

  // #region crew area
  const areaRow = crews.find((c) => c.id === areaCrew) ?? null;
  const areaName = areaRow ? (areaRow.areaLabel ?? areaRow.name) : "";
  const savedArea = useMemo(() => (areaRow?.area ? rectFromRing(areaRow.area.coordinates[0] ?? []) : null), [areaRow]);
  const areaValue = areaCrew === null ? null : (areaDraft ?? savedArea);
  const onAreaChange = (r: OrientedRect): void => {
    if (areaCrew === null) return;
    setAreaDraft(r);
    setDrawArea(false);
    setArea.mutate({ crewId: areaCrew, area: rectPolygon(r) });
  };
  const areaTool = useOrientedRect(map, { drawing: drawArea, value: areaValue, editable: true, onChange: onAreaChange, onCancel: () => setDrawArea(false) });
  const editArea = (crewId: number): void => {
    setDrawSel(false);
    setAreaDraft(null);
    if (areaCrew === crewId) {
      setAreaCrew(null);
      setDrawArea(false);
      return;
    }
    setAreaCrew(crewId);
    const row = crews.find((c) => c.id === crewId);
    setDrawArea(!row?.area);
  };
  const stopArea = (): void => {
    setAreaCrew(null);
    setAreaDraft(null);
    setDrawArea(false);
  };
  // #endregion

  // #region map layers
  const drawn = useMemo<DrawnSide[]>(() => {
    const byKey = new Map(sides.map((s) => [s.key, s]));
    return (shapesQ.data ?? []).flatMap((sh) => {
      const s = byKey.get(sh.key);
      if (!s) return [];
      const a = s.assignment;
      let classes = !a ? `lrb-side-${s.band}` : a.dayId === dayId && a.ccId === ccId ? "lrb-side-here" : "lrb-side-away";
      const crewMatch =
        crewPicks.length === 0 ||
        (a?.crewId != null && crewPickSet.has(a.crewId)) ||
        (a?.areaId != null && crews.some((c) => c.areaId === a.areaId && crewPickSet.has(c.id)));
      if (a && target !== null && a.companyId === target && a.dayId === dayId && crewMatch) classes += " lrb-side-focus";
      // Block sides carry no field status (Filip, 2026-10-01): status colour is the lot outlines' alone.
      if (sel.has(s.key)) classes += " lrb-side-sel";
      return [{ key: s.key, ring: sh.ring, classes }];
    });
  }, [sides, shapesQ.data, dayId, ccId, target, crewPicks, crewPickSet, crews, sel]);
  useSidesLayer(map, drawn, onSide, drawSel || drawArea);

  // One outline per area, labelled the way the company sheet prints it ("GM 9, GM 10 & GM 11").
  const areas = useMemo<DrawnArea[]>(() => {
    const editing = areaRow?.areaId ?? null;
    const dnt = new Set((dayOfQ.data?.areas ?? []).filter((a) => a.doNotTouch).map((a) => a.id));
    const out = new Map<number, DrawnArea>();
    for (const c of crews) {
      if (c.ccId !== ccId || c.areaId === null || !c.area || c.areaId === editing || c.id === areaCrew) continue;
      if (!out.has(c.areaId)) out.set(c.areaId, { id: c.areaId, label: c.areaLabel ?? c.name, ring: c.area.coordinates[0] ?? [], doNotTouch: dnt.has(c.areaId) });
    }
    return [...out.values()];
  }, [crews, ccId, areaCrew, areaRow, dayOfQ.data]);
  useAreasLayer(map, areas);

  const markers = useMemo<MapMarker[]>(() => (cc ? [{ id: `cc-${cc.id}`, kind: "cc", lat: cc.lat, lng: cc.lng, name: `CC ${cc.name}`, letter: cc.letter, noFit: true }] : []), [cc]);

  const fitPoints = useMemo<Array<[number, number]>>(() => {
    const pts: Array<[number, number]> = [];
    for (const s of sides) {
      const a = s.assignment;
      if (a && a.dayId === dayId && a.ccId === ccId) pts.push([s.bbox[1], s.bbox[0]], [s.bbox[3], s.bbox[2]]);
    }
    if (cc) pts.push([cc.lat, cc.lng]);
    if (pts.length <= 1) for (const s of sides) pts.push([s.bbox[1], s.bbox[0]], [s.bbox[3], s.bbox[2]]);
    return pts;
  }, [sides, dayId, ccId, cc]);
  useFitOnce(map, sidesQ.data && ccId !== null ? `${dayId}-${ccId}` : null, fitPoints);
  // #endregion

  // Work assigned per crew, for the crew rows.
  const crewWork = useMemo(() => {
    const m = new Map<number, { high: number; low: number }>();
    const add = (id: number, high: number, low: number): void => {
      const w = m.get(id) ?? { high: 0, low: 0 };
      w.high += high;
      w.low += low;
      m.set(id, w);
    };
    for (const s of sides) {
      const a = s.assignment;
      if (a?.crewId != null) add(a.crewId, s.high, s.low);
      else if (a?.areaId != null) {
        // A shared area's sides are split at Publish; until then each crew carries an even share.
        const members = crews.filter((c) => c.areaId === a.areaId);
        for (const c of members) add(c.id, s.high / members.length, s.low / members.length);
      }
    }
    return m;
  }, [sides, crews]);

  const picked = useMemo(() => sides.filter((s) => sel.has(s.key)), [sides, sel]);
  const pickedWork = picked.reduce((n, s) => n + s.workCount, 0);
  const pickedAssigned = picked.filter((s) => s.assignment).length;
  const daySides = useMemo(() => sides.filter((s) => s.assignment?.dayId === dayId), [sides, dayId]);

  const doAssign = (): void => {
    if (dayId === null || ccId === null || target === null || picked.length === 0) return;
    const names = targetCrews.filter((c) => crewPickSet.has(c.id)).map((c) => c.name);
    const who = names.length > 0 ? joinNames(names) : (targetCompany?.name ?? "Company");
    // Several crews share one area; the drawn rectangle, when there is one, is its outline.
    const area = crewPicks.length > 1 && selRect ? rectPolygon(selRect) : null;
    assign.mutate(
      { dayId, ccId, companyId: target, crewIds: crewPicks, area, keys: picked.map((s) => s.key) },
      {
        onSuccess: (r) => {
          setNotice({ tone: "ok", text: `${plural(r.assigned, "side")} to ${who}` });
          clearSelection();
        },
      },
    );
  };
  const doUnassign = (): void => {
    const keys = picked.filter((s) => s.assignment).map((s) => s.key);
    if (keys.length === 0) return;
    unassign.mutate(
      { keys },
      {
        onSuccess: (r) => {
          setNotice({ tone: "ok", text: `${plural(r.cleared, "side")} unassigned` });
          clearSelection();
        },
      },
    );
  };

  const otherCompanies = (allCompanies.data ?? []).filter((c) => !companies.some((x) => x.companyId === c.id));
  const [addCompany, setAddCompany] = useState<string>("");
  const [addPeople, setAddPeople] = useState<number>(10);
  const addValue = otherCompanies.some((c) => String(c.id) === addCompany) ? addCompany : String(otherCompanies[0]?.id ?? "");

  // #region render
  const loading = daysQ.isLoading || ccsQ.isLoading || sidesQ.isLoading;
  let content: ReactNode;
  if (loading) {
    content = (
      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[22rem_minmax(0,1fr)]">
        <Skeleton className="h-96 lg:h-full" />
        <Skeleton className="h-[50dvh] lg:h-full" />
      </div>
    );
  } else if (noEvent(daysQ.error) || noEvent(sidesQ.error)) {
    content = (
      <Panel>
        <EmptyState title="No active event" />
      </Panel>
    );
  } else if (sidesQ.isError || daysQ.isError || ccsQ.isError) {
    content = (
      <Panel>
        <EmptyState title="Assignments not loaded" description="Check the connection" action={<Button onClick={() => void sidesQ.refetch()}>Retry</Button>} />
      </Panel>
    );
  } else if (sides.length === 0) {
    content = (
      <Panel>
        <EmptyState title="No block sides surveyed" action={<ButtonLink href="/plan/survey">Survey</ButtonLink>} />
      </Panel>
    );
  } else if (!day || !cc || ccId === null || dayId === null) {
    content = (
      <Panel>
        <EmptyState
          title={day ? `No command centers on ${day.label}` : "No days"}
          action={day ? <ButtonLink href={`/admin/days/${day.id}`}>{`Set up ${day.label}`}</ButtonLink> : <ButtonLink href="/admin">Event</ButtonLink>}
        />
      </Panel>
    );
  } else {
    const busyAssign = assign.isPending || unassign.isPending;
    content = (
      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[22rem_minmax(0,1fr)]">
        <section aria-label="Companies" className="flex min-h-0 flex-col overflow-hidden rounded-2xl bg-surface ring-1 ring-line">
          <div className="flex min-h-14 items-center justify-between gap-2 border-b border-line px-4 py-2">
            <h2 className="text-base font-bold">Companies</h2>
            <span className="text-sm text-muted tabular-nums">{plural(companies.reduce((n, c) => n + c.headcount, 0), "person", "people")}</span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {companiesQ.isLoading ? (
              <div className="space-y-2">
                <Skeleton className="h-28" />
                <Skeleton className="h-28" />
              </div>
            ) : companies.length === 0 ? (
              <EmptyState title={`No companies on ${day.label}`} />
            ) : (
              <ul className="space-y-2">
                {companies.map((c) => (
                  <CompanyCard
                    key={c.companyId}
                    cardRef={(el) => {
                      if (el) cards.current.set(c.companyId, el);
                      else cards.current.delete(c.companyId);
                    }}
                    company={c}
                    ccId={ccId}
                    ccName={ccName}
                    cap={cap}
                    work={crewWork}
                    target={target === c.companyId}
                    targetCrews={target === c.companyId ? crewPickSet : new Set<number>()}
                    areaCrew={areaCrew}
                    onPick={() => {
                      setTarget(target === c.companyId ? null : c.companyId);
                      setTargetCrewIds(new Set());
                    }}
                    onPickCrew={(id) => {
                      if (target !== c.companyId) {
                        setTarget(c.companyId);
                        setTargetCrewIds(new Set([id]));
                      } else toggleCrew(id);
                    }}
                    onArea={editArea}
                    onHeadcount={(n) => headcount.mutate({ companyId: c.companyId, dayId, ccId: c.attendCcId, headcount: n })}
                    onBuild={() =>
                      build.mutate(
                        { dayId, ccId, companyId: c.companyId },
                        { onSuccess: (r) => setNotice({ tone: "ok", text: `${plural(r.length, "crew")} for ${c.name}` }) },
                      )
                    }
                    building={build.isPending && build.variables?.companyId === c.companyId}
                  />
                ))}
              </ul>
            )}
            {otherCompanies.length > 0 && (
              <form
                className="mt-3 space-y-2 rounded-xl border-2 border-dashed border-line p-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  const id = Number(addValue);
                  if (!id) return;
                  headcount.mutate({ companyId: id, dayId, ccId, headcount: addPeople }, { onSuccess: () => setTarget(id) });
                }}
              >
                <InlineSelect label="Company" value={addValue} onChange={setAddCompany}>
                  {otherCompanies.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </InlineSelect>
                <div className="flex items-center justify-between gap-2">
                  <InlineNumber label="People" value={addPeople} min={1} onCommit={setAddPeople} />
                  <Button type="submit" size="sm" variant="secondary" busy={headcount.isPending && headcount.variables?.companyId === Number(addValue)}>
                    Add company
                  </Button>
                </div>
              </form>
            )}
          </div>
        </section>

        <div className="flex min-h-0 flex-col gap-2">
          <section aria-label="Selection" className="flex flex-wrap items-center gap-2 rounded-2xl bg-surface px-3 py-2 ring-1 ring-line">
            <Button
              size="sm"
              variant={drawSel ? "primary" : "secondary"}
              onClick={() => {
                stopArea();
                setDrawSel(!drawSel);
              }}
            >
              <RectIcon />
              Select area
            </Button>
            <span className="min-w-24 text-sm font-semibold tabular-nums" role="status" aria-live="polite">
              {picked.length === 0 ? "No sides selected" : `${plural(picked.length, "side")}, ${plural(pickedWork, "parcel")}`}
            </span>
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <InlineSelect
                label="Assign to"
                className="w-56"
                value={target === null ? "" : String(target)}
                onChange={(v) => {
                  setTarget(v === "" ? null : Number(v));
                  setTargetCrewIds(new Set());
                }}
              >
                <option value="">Company</option>
                {companies.map((c) => (
                  <option key={c.companyId} value={c.companyId}>
                    {c.name}
                  </option>
                ))}
              </InlineSelect>
              <Button size="sm" disabled={picked.length === 0 || target === null} busy={assign.isPending} onClick={doAssign}>
                Assign
              </Button>
              <Button size="sm" variant="secondary" disabled={pickedAssigned === 0 || busyAssign} busy={unassign.isPending} onClick={doUnassign}>
                Unassign
              </Button>
              <Button size="sm" variant="ghost" disabled={picked.length === 0 && !selRect} onClick={clearSelection}>
                Clear
              </Button>
            </div>
            {targetCrews.length > 0 && (
              <div role="group" aria-label="Crews" className="flex w-full flex-wrap items-center gap-2 border-t border-line pt-2">
                <span className="text-sm font-semibold text-muted">Crews</span>
                {targetCrews.map((c) => (
                  <ToggleChip key={c.id} on={crewPickSet.has(c.id)} onChange={() => toggleCrew(c.id)}>
                    {c.name}
                  </ToggleChip>
                ))}
                {crewPicks.length > 1 && <span className="text-sm font-semibold">Shared, {joinNames(targetCrews.filter((c) => crewPickSet.has(c.id)).map((c) => c.name))}</span>}
              </div>
            )}
          </section>
          <div className="relative h-[60dvh] min-h-80 overflow-hidden rounded-2xl ring-1 ring-line lg:h-auto lg:flex-1">
            <MapView markers={markers} label="Assignments map" className="absolute inset-0" onReady={setMap} />
            <AlleyLayer map={map} />
            {drawSel && <MapMode label="Select area" detail={selTool.step ? STEP_LABEL[selTool.step] : undefined} onCancel={() => setDrawSel(false)} />}
            {areaRow && (
              <MapMode
                label={`Area, ${areaName}`}
                detail={drawArea ? (areaTool.step ? STEP_LABEL[areaTool.step] : undefined) : areaValue ? rectSize(areaValue) : undefined}
                onCancel={stopArea}
                cancelLabel="Done"
                action={
                  !drawArea ? (
                    <Button size="sm" variant="secondary" onClick={() => setDrawArea(true)}>
                      Redraw
                    </Button>
                  ) : undefined
                }
              />
            )}
          </div>
          <Legend
            items={[
              ...(["none", "light", "mid", "dark"] as const).map((b) => ({ swatch: SWATCH[b], label: BAND_LABEL[b] })),
              { swatch: SWATCH.here, label: `CC ${cc.name}` },
              { swatch: SWATCH.away, label: "Elsewhere" },
              { swatch: SWATCH.sel, label: "Selected" },
              { swatch: SWATCH.done, label: "Done" },
              { swatch: SWATCH.dnt, label: "Do not touch" },
              { swatch: "swatch-oneway", label: "One way" },
              { swatch: "swatch-alley", label: "Alley" },
            ]}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-full flex-col gap-3 px-4 py-4 nav:px-6 nav:py-5 lg:h-full">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <h1 className="mr-auto text-2xl font-bold tracking-tight">Assignments</h1>
        {days.length > 0 && (
          <InlineSelect
            label="Day"
            className="w-48"
            value={dayId === null ? "" : String(dayId)}
            onChange={(v) => {
              setDayPick(Number(v));
              clearSelection();
              stopArea();
            }}
          >
            {days.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
          </InlineSelect>
        )}
        {dayCcs.length > 0 && (
          <InlineSelect
            label="CC"
            className="w-44"
            value={ccId === null ? "" : String(ccId)}
            onChange={(v) => {
              setCcPick(Number(v));
              clearSelection();
              stopArea();
            }}
          >
            {dayCcs.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </InlineSelect>
        )}
        <Button disabled={!day || daySides.length === 0} onClick={() => setPublishOpen(true)}>
          Publish to field app
        </Button>
      </div>
      <Notice value={notice} onClear={clearNotice} />
      {content}
      <PublishSheet
        open={publishOpen && day !== null}
        dayLabel={day?.label ?? ""}
        sides={daySides}
        crewRows={crews}
        busy={publish.isPending}
        onClose={() => setPublishOpen(false)}
        onPublish={(resetAreas) => {
          if (dayId === null) return;
          publish.mutate(
            { dayId, resetAreas },
            {
              onSuccess: (r) => {
                setPublishOpen(false);
                const parts = [`${plural(r.added, "lot")} added`, `${r.updated.toLocaleString("en-US")} updated`];
                if (r.kept > 0) parts.push(`${r.kept.toLocaleString("en-US")} done kept`);
                if (r.removed > 0) parts.push(`${r.removed.toLocaleString("en-US")} removed`);
                if (r.areas > 0) parts.push(plural(r.areas, "area"));
                setNotice({ tone: "ok", text: parts.join(", ") });
              },
            },
          );
        }}
      />
    </div>
  );
  // #endregion
};
