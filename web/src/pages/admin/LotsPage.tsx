import type { Map as LeafletMap } from "leaflet";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button } from "../../components/Button.tsx";
import { EmptyState } from "../../components/EmptyState.tsx";
import { Field, Select, TextArea } from "../../components/Field.tsx";
import { Page } from "../../components/Page.tsx";
import { LotSheet as SharedLotSheet } from "../../components/LotSheet.tsx";
import { Sheet } from "../../components/Sheet.tsx";
import { lotPill, StatusPill } from "../../components/StatusPill.tsx";
import { Chips } from "../../components/Segmented.tsx";
import { plural, SOURCE_LABEL } from "../../components/admin/format.ts";
import { PinIcon, RectIcon, TrashIcon, UploadIcon } from "../../components/admin/icons.tsx";
import { MapMode } from "../../components/admin/MapMode.tsx";
import { errorText, Notice, type NoticeValue } from "../../components/admin/Notice.tsx";
import { Panel, Stat } from "../../components/Panel.tsx";
import { SkeletonList } from "../../components/Skeleton.tsx";
import { Segmented } from "../../components/Segmented.tsx";
import { MapView, type MapMarker } from "../../lib/map/MapView.tsx";
import { useOnewayLayer } from "../../lib/map/onewayLayer.ts";
import { useParcelLayer } from "../../lib/map/parcelLayer.ts";
import type { PaintTarget } from "../../lib/map/paintHit.ts";
import { PaintBar, PaintFrame, PaintIcon, usePaint } from "../../components/PaintBar.tsx";
import { FilterSelect } from "../../components/green/ui.tsx";
import { AlleyLayer } from "../../components/alleys/AlleyLayer.tsx";
import { insideRect, rectBBox, rectRing, rectSize, STEP_LABEL, useOrientedRect, type OrientedRect } from "../../lib/map/orientedRect.ts";
import { STATUS_LABEL, STATUS_ORDER } from "../../lib/lotStatus.ts";
import { trpc, type RouterOutputs } from "../../lib/trpc.ts";

type Lot = RouterOutputs["admin"]["lots"]["list"][number];
type Cc = RouterOutputs["admin"]["ccs"]["list"][number];
type LotStatus = Lot["status"];
type RectAction = "dlba" | "vacant" | "assign" | "remove";
type Mode = { kind: "idle" } | { kind: "add" } | { kind: "rect"; action: RectAction };

/** The server refuses bigger rectangles; about 25 by 33 km at Detroit's latitude. */
const MAX_SPAN_DEG = 0.3;

const STATUS_OPTIONS: ReadonlyArray<{ value: LotStatus; label: string }> = STATUS_ORDER.map((s) => ({ value: s, label: STATUS_LABEL[s] }));

const RECT_LABEL: Record<RectAction, string> = {
  dlba: "Import DLBA",
  vacant: "Vacant parcels",
  assign: "Assign CC",
  remove: "Remove area",
};

const ccLabel = (c: Cc): string => `${c.dayLabel}, CC ${c.name}`;

/** Every CC of the event, day first, for pickers. The day stays visible on the closed control. */
const CcOptions = ({ ccs }: { ccs: readonly Cc[] }) => (
  <>
    {ccs.map((c) => (
      <option key={c.id} value={c.id}>
        {ccLabel(c)}
      </option>
    ))}
  </>
);

// #region rectangle sheet
const RectSheet = ({
  action,
  rect,
  lots,
  ccs,
  onClose,
  onRedraw,
  notify,
}: {
  action: RectAction | null;
  /** Imports send the rectangle as a polygon; assign and remove take the lots whose centre is inside it. */
  rect: OrientedRect | null;
  lots: readonly Lot[];
  ccs: readonly Cc[];
  onClose: () => void;
  onRedraw: () => void;
  notify: (n: NoticeValue) => void;
}) => {
  const utils = trpc.useUtils();
  const open = action !== null && rect !== null;
  const bbox = useMemo(() => (rect ? rectBBox(rect) : null), [rect]);
  const ring = useMemo(() => (rect ? rectRing(rect) : null), [rect]);
  const tooBig = bbox !== null && (bbox[2] - bbox[0] > MAX_SPAN_DEG || bbox[3] - bbox[1] > MAX_SPAN_DEG);
  const inside = useMemo(() => (rect ? insideRect(lots, rect) : []), [lots, rect]);
  const [ccId, setCcId] = useState<number | "none">("none");
  useEffect(() => {
    if (open) setCcId(action === "assign" ? (ccs[0]?.id ?? "none") : "none");
  }, [open, action, ccs]);
  const ccName = ccId === "none" ? null : (ccs.find((c) => c.id === ccId)?.name ?? null);
  const assignedText = (n: number): string => (ccName && n > 0 ? `, ${plural(n, "lot")} to CC ${ccName}` : "");
  const ccSelect = (label: string) => (
    <Select label={label} value={ccId} onChange={(e) => setCcId(e.target.value === "none" ? "none" : Number(e.target.value))}>
      <option value="none">No CC</option>
      <CcOptions ccs={ccs} />
    </Select>
  );
  const importCc = ccId === "none" ? null : ccId;

  const refresh = (): void => {
    void utils.admin.lots.invalidate();
    void utils.admin.overview.invalidate();
    void utils.admin.export.counts.invalidate();
  };
  const finish = (text: string): void => {
    refresh();
    notify({ tone: "ok", text });
    onClose();
  };
  const fail = (e: unknown): void => notify({ tone: "error", text: errorText(e, "Import stopped. Try again.") });

  const dlba = trpc.admin.lots.importDlba.useMutation({
    onSuccess: (r) =>
      finish(
        r.fetched === 0
          ? "No Land Bank lots in that area"
          : `${plural(r.added, "lot")} added, ${r.updated.toLocaleString("en-US")} updated, ${r.outlines.toLocaleString("en-US")} outlines${assignedText(r.assigned)}`,
      ),
    onError: fail,
  });
  const vacantCount = trpc.admin.lots.countVacant.useQuery({ ring: ring ?? [] }, { enabled: open && ring !== null && action === "vacant" && !tooBig, retry: false, staleTime: 60_000 });
  const vacant = trpc.admin.lots.importVacant.useMutation({
    onSuccess: (r) => finish(`${plural(r.added, "lot")} added, ${r.updated.toLocaleString("en-US")} updated${assignedText(r.assigned)}`),
    onError: fail,
  });
  const target = ccId === "none" ? null : ccId;
  const moving = inside.filter((l) => l.ccId !== target);
  const assign = trpc.admin.lots.assignCc.useMutation({
    onSuccess: (r) => {
      const cc = ccs.find((c) => c.id === target);
      finish(cc ? `${plural(r.updated, "lot")} to CC ${cc.name}` : `${plural(r.updated, "lot")} without CC`);
    },
    onError: (e) => {
      refresh();
      fail(e);
    },
  });
  const assignInside = (): void => {
    if (moving.length) assign.mutate({ ids: moving.map((l) => l.id), ccId: target });
  };
  const remove = trpc.admin.lots.delete.useMutation({
    onSuccess: (r) => finish(`${plural(r.deleted, "lot")} removed`),
    onError: fail,
  });

  if (!open || !action || !rect || !bbox) return null;

  let body: ReactNode = null;
  let footer: ReactNode = null;
  if (tooBig) {
    body = <p className="font-semibold">Area too large. Draw a smaller rectangle.</p>;
    footer = (
      <Button block size="lg" variant="secondary" onClick={onRedraw}>
        Redraw
      </Button>
    );
  } else if (action === "dlba") {
    body = (
      <div className="space-y-4">
        <Stat value={plural(inside.length, "lot")} label="Already in this area" />
        {ccSelect("Command center")}
      </div>
    );
    footer = (
      <Button block size="lg" busy={dlba.isPending} onClick={() => ring && dlba.mutate({ ring, ccId: importCc })}>
        Import Land Bank lots
      </Button>
    );
  } else if (action === "vacant") {
    const n = vacantCount.data?.count;
    body = vacantCount.isLoading ? (
      <div className="h-16 animate-pulse rounded-xl bg-surface-2" aria-busy="true" aria-label="Counting" />
    ) : vacantCount.error ? (
      <p className="font-semibold">Parcel layer not answering. Try again in a minute.</p>
    ) : (
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-2">
          <Stat value={n ?? 0} label="Residential vacant" />
          <Stat value={inside.length} label="Lots already here" />
        </div>
        {ccSelect("Command center")}
      </div>
    );
    footer = (
      <Button block size="lg" busy={vacant.isPending} disabled={!n} onClick={() => ring && vacant.mutate({ ring, ccId: importCc })}>
        {n ? `Import ${plural(n, "parcel")}` : "Nothing to import"}
      </Button>
    );
  } else if (action === "assign") {
    body = (
      <div className="space-y-4">
        <Stat value={plural(inside.length, "lot")} label="In this area" />
        {ccSelect("Command center")}
      </div>
    );
    footer = (
      <Button block size="lg" busy={assign.isPending} disabled={moving.length === 0} onClick={assignInside}>
        {moving.length ? `Assign ${plural(moving.length, "lot")}` : inside.length ? (target === null ? "Already without CC" : "Already at this CC") : "No lots here"}
      </Button>
    );
  } else {
    body = <Stat value={plural(inside.length, "lot")} label="In this area" tone="warn" />;
    footer = (
      <Button block size="lg" variant="danger" busy={remove.isPending} disabled={inside.length === 0} onClick={() => remove.mutate({ ids: inside.map((l) => l.id) })}>
        {inside.length ? `Remove ${plural(inside.length, "lot")}` : "No lots here"}
      </Button>
    );
  }

  return (
    <Sheet open onClose={onClose} title={RECT_LABEL[action]} footer={footer}>
      <div className="space-y-3 pb-2">
        <p className="text-sm text-muted">Area {rectSize(rect)}</p>
        {body}
      </div>
    </Sheet>
  );
};
// #endregion

// #region lot sheet
const LotSheet = ({ lot, ccs, onClose, notify }: { lot: Lot | null; ccs: readonly Cc[]; onClose: () => void; notify: (n: NoticeValue) => void }) => {
  const utils = trpc.useUtils();
  const [ccId, setCcId] = useState<number | "none">("none");
  const [address, setAddress] = useState("");
  const [note, setNote] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => {
    if (!lot) return;
    setCcId(lot.ccId ?? "none");
    setAddress(lot.address ?? "");
    setNote(lot.note ?? "");
    setConfirmDelete(false);
  }, [lot?.id]);
  const refresh = (): void => {
    void utils.admin.lots.invalidate();
    void utils.admin.overview.invalidate();
  };
  const update = trpc.admin.lots.update.useMutation({ onSuccess: refresh, onError: (e) => notify({ tone: "error", text: errorText(e) }) });
  const del = trpc.admin.lots.delete.useMutation({
    onSuccess: () => {
      refresh();
      notify({ tone: "ok", text: `${lot?.address ?? "Lot"} removed` });
      onClose();
    },
  });
  if (!lot) return null;
  const dirty = (ccId === "none" ? null : ccId) !== lot.ccId || address.trim() !== (lot.address ?? "") || note.trim() !== (lot.note ?? "");
  const cc = ccs.find((c) => c.id === lot.ccId);
  const save = (): void =>
    update.mutate(
      { id: lot.id, ccId: ccId === "none" ? null : ccId, address: address.trim() || null, note: note.trim() || null },
      { onSuccess: () => onClose() },
    );
  return (
    <SharedLotSheet
      lot={lot}
      onClose={onClose}
      status={<Segmented label="Status" value={lot.status} options={STATUS_OPTIONS} onChange={(status) => update.mutate({ id: lot.id, status })} />}
      crew={
        <dl className="grid grid-cols-2 gap-2 text-sm">
          <div className="rounded-xl bg-surface-2 px-3 py-2">
            <dt className="text-muted">Source</dt>
            <dd className="font-semibold">{SOURCE_LABEL[lot.source] ?? lot.source}</dd>
          </div>
          <div className="rounded-xl bg-surface-2 px-3 py-2">
            <dt className="text-muted">Crew</dt>
            <dd className="font-semibold">{lot.crewName != null ? `${lot.crewName}${cc ? `, ${cc.dayLabel}` : ""}` : "None"}</dd>
          </div>
          {lot.parcelId && (
            <div className="col-span-2 rounded-xl bg-surface-2 px-3 py-2">
              <dt className="text-muted">Parcel</dt>
              <dd className="font-mono font-semibold break-all">{lot.parcelId}</dd>
            </div>
          )}
        </dl>
      }
      footer={
        confirmDelete ? (
          <div className="grid grid-cols-2 gap-2">
            <Button variant="secondary" size="lg" onClick={() => setConfirmDelete(false)}>
              Keep
            </Button>
            <Button variant="danger" size="lg" busy={del.isPending} onClick={() => del.mutate({ ids: [lot.id] })}>
              Remove lot
            </Button>
          </div>
        ) : (
          <div className="flex gap-2">
            <Button variant="danger" size="lg" onClick={() => setConfirmDelete(true)} aria-label="Remove lot">
              <TrashIcon />
            </Button>
            <Button size="lg" className="flex-1" disabled={!dirty} busy={update.isPending && update.variables?.status === undefined} onClick={save}>
              Save
            </Button>
          </div>
        )
      }
    >
      <Select label="Command center" value={ccId} onChange={(e) => setCcId(e.target.value === "none" ? "none" : Number(e.target.value))}>
        <option value="none">No CC</option>
        <CcOptions ccs={ccs} />
      </Select>
      <Field label="Address" value={address} onChange={(e) => setAddress(e.target.value)} maxLength={200} autoComplete="off" />
      <TextArea label="Note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} />
    </SharedLotSheet>
  );
};
// #endregion

// #region CSV sheet
const CsvSheet = ({ open, onClose, notify, ccs }: { open: boolean; onClose: () => void; notify: (n: NoticeValue) => void; ccs: readonly Cc[] }) => {
  const utils = trpc.useUtils();
  const [csv, setCsv] = useState("");
  const [ccId, setCcId] = useState<number | "none">("none");
  const [fileName, setFileName] = useState<string | null>(null);
  const importCsv = trpc.admin.lots.importCsv.useMutation({
    onSuccess: (r) => {
      void utils.admin.lots.invalidate();
      void utils.admin.overview.invalidate();
      if (r.errors.length === 0) {
        notify({ tone: "ok", text: `${plural(r.added, "lot")} added, ${r.updated.toLocaleString("en-US")} updated` });
        setCsv("");
        setFileName(null);
        onClose();
      }
    },
  });
  useEffect(() => {
    if (open) importCsv.reset();
  }, [open]);
  const rows = csv.trim() ? csv.trim().split(/\r?\n/).length - 1 : 0;
  const r = importCsv.data;
  // The same text imported once already; a second tap would only repeat it.
  const done = importCsv.isSuccess && importCsv.variables?.csv === csv;
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Import lots"
      footer={
        <Button
          block
          size="lg"
          disabled={rows < 1 || done}
          busy={importCsv.isPending}
          onClick={() => importCsv.mutate({ csv, ccId: ccId === "none" ? null : ccId })}
        >
          {done ? "Imported" : rows > 0 ? `Import ${plural(rows, "row")}` : "Import"}
        </Button>
      }
    >
      <div className="space-y-4 pb-2">
        <div className="rounded-xl bg-surface-2 px-4 py-3">
          <div className="text-sm text-muted">Columns</div>
          <code className="block font-mono text-sm">address, lat, lng, parcel_id</code>
        </div>
        <Select label="Command center" value={ccId} onChange={(e) => setCcId(e.target.value === "none" ? "none" : Number(e.target.value))}>
          <option value="none">No CC</option>
          <CcOptions ccs={ccs} />
        </Select>
        <label className="flex min-h-12 cursor-pointer items-center justify-center gap-2 rounded-xl bg-surface font-semibold ring-2 ring-line ring-inset hover:bg-surface-2">
          <UploadIcon />
          {fileName ?? "Choose CSV file"}
          <input
            type="file"
            accept=".csv,text/csv,text/plain"
            className="sr-only"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              setFileName(f.name);
              void f.text().then(setCsv);
            }}
          />
        </label>
        <TextArea label="CSV" value={csv} onChange={(e) => setCsv(e.target.value)} rows={6} spellCheck={false} />
        {r && (
          <div role="status" className="space-y-2 rounded-xl bg-surface-2 px-4 py-3">
            <p className="font-semibold">
              {plural(r.added, "lot")} added, {r.updated.toLocaleString("en-US")} updated, {plural(r.errors.length + r.skipped, "row")} skipped
            </p>
            {r.errors.length > 0 && (
              <ul className="max-h-40 list-inside list-disc overflow-y-auto text-sm">
                {r.errors.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            )}
          </div>
        )}
        {importCsv.error && <p role="alert" className="text-sm font-semibold">{errorText(importCsv.error)}</p>}
      </div>
    </Sheet>
  );
};
// #endregion

type Filter = "all" | "none" | number;

/** One place across days: a CC's lots belong to every day's row of it (SPEC 8). */
const siteKey = (c: Pick<Cc, "name" | "lat" | "lng">): string => `${c.name}|${c.lat.toFixed(4)}|${c.lng.toFixed(4)}`;
const noTap = (): void => undefined;

export const LotsPage = () => {
  const lotsQ = trpc.admin.lots.list.useQuery(undefined, { retry: false });
  const counts = trpc.admin.lots.counts.useQuery(undefined, { retry: false });
  const ccsQ = trpc.admin.ccs.list.useQuery(undefined, { retry: false });
  const utils = trpc.useUtils();
  const [mode, setMode] = useState<Mode>({ kind: "idle" });
  const [sheetRect, setSheetRect] = useState<OrientedRect | null>(null);
  const [lotId, setLotId] = useState<number | null>(null);
  const [csvOpen, setCsvOpen] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [notice, setNotice] = useState<NoticeValue>(null);
  const clear = useCallback(() => setNotice(null), []);
  const [map, setMap] = useState<LeafletMap | null>(null);
  useOnewayLayer(map);
  const drawingRect = mode.kind === "rect" && sheetRect === null;
  const rectTool = useOrientedRect(map, {
    drawing: drawingRect,
    value: mode.kind === "rect" ? sheetRect : null,
    onChange: setSheetRect,
    onCancel: () => setMode({ kind: "idle" }),
  });
  const lots = lotsQ.data ?? [];
  const ccs = ccsQ.data ?? [];

  // #region Paint (SPEC 23): at one CC, the Show filter's, else today's, else the first.
  const [paintCcPick, setPaintCc] = useState<number | null>(null);
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Detroit" });
  const paintCc = paintCcPick ?? (typeof filter === "number" ? filter : (ccs.find((c) => c.date === today)?.id ?? ccs[0]?.id ?? null));
  const paintSite = useMemo(() => {
    const cc = ccs.find((c) => c.id === paintCc);
    return cc ? new Set(ccs.filter((c) => siteKey(c) === siteKey(cc)).map((c) => c.id)) : new Set<number>();
  }, [ccs, paintCc]);
  const [paintOn, setPaintOn] = useState(false);
  const bare = trpc.admin.lots.parcels.useQuery({ ccId: paintCc ?? 0 }, { enabled: paintOn && paintCc !== null, retry: false });
  const paintTargets = useMemo<PaintTarget[]>(() => {
    const out: PaintTarget[] = lots
      .filter((l) => l.ccId === null || paintSite.has(l.ccId))
      .map((l) => ({ key: `l:${l.id}`, lotId: l.id, parcelId: l.parcelId, status: l.status, crewId: l.crewId, lat: l.lat, lng: l.lng, geometry: l.geometry }));
    for (const p of bare.data ?? []) out.push({ key: `p:${p.parcelId}`, lotId: null, parcelId: p.parcelId, status: null, crewId: null, lat: p.lat, lng: p.lng, geometry: p.geometry });
    return out;
  }, [lots, paintSite, bare.data]);
  const paint = usePaint(map, { kind: "admin", ccId: paintCc }, paintTargets);
  useEffect(() => setPaintOn(paint.on), [paint.on]);
  useParcelLayer(map, bare.data, paint.on, noTap, paint.pending, true);
  // #endregion
  const noEvent = lotsQ.error?.data?.code === "PRECONDITION_FAILED";

  const add = trpc.admin.lots.add.useMutation({
    onSuccess: (l) => {
      void utils.admin.lots.invalidate();
      void utils.admin.overview.invalidate();
      setNotice({ tone: "ok", text: l.address ? `Lot added, ${l.address}` : "Lot added" });
    },
    onError: (e) => setNotice({ tone: "error", text: errorText(e) }),
  });

  const stopMode = (): void => {
    setMode({ kind: "idle" });
    setSheetRect(null);
  };
  const startRect = (action: RectAction): void => {
    paint.close();
    setSheetRect(null);
    setMode({ kind: "rect", action });
  };

  const onMapClick = (lat: number, lng: number): void => {
    if (mode.kind === "add") add.mutate({ lat, lng });
  };

  // CC flags: one per place, not one per day.
  const ccMarkers = useMemo<MapMarker[]>(() => {
    const seen = new Map<string, Cc>();
    for (const c of ccs) {
      const key = `${c.name}|${c.lat.toFixed(4)}|${c.lng.toFixed(4)}`;
      if (!seen.has(key)) seen.set(key, c);
    }
    return [...seen.values()].map((c) => ({ id: `cc-${c.id}`, kind: "cc", lat: c.lat, lng: c.lng, name: `CC ${c.name}`, letter: c.letter, noFit: true }));
  }, [ccs]);

  const shown = useMemo(
    () => lots.filter((l) => filter === "all" || (filter === "none" ? l.ccId === null : l.ccId === filter)),
    [lots, filter],
  );
  const idle = mode.kind === "idle" && !paint.on;
  const lotMarkers = useMemo<MapMarker[]>(
    () =>
      shown.map((l) => ({
        id: `lot-${l.id}`,
        kind: "lot",
        lat: l.lat,
        lng: l.lng,
        status: paint.pending.get(`l:${l.id}`) ?? l.status,
        geometry: l.geometry,
        parcelId: l.parcelId,
        mine: l.ccId !== null,
        title: l.address ?? undefined,
        onClick: idle ? () => setLotId(l.id) : undefined,
      })),
    [shown, idle, paint.pending],
  );
  const markers = useMemo(() => [...lotMarkers, ...ccMarkers], [lotMarkers, ccMarkers]);

  const byStatus = new Map((counts.data?.byStatus ?? []).map((r) => [r.status, r.n]));
  const bySource = counts.data?.bySource ?? [];
  const perCc = useMemo(() => {
    const m = new Map<number, number>();
    for (const l of lots) if (l.ccId !== null) m.set(l.ccId, (m.get(l.ccId) ?? 0) + 1);
    return m;
  }, [lots]);
  const selected = lots.find((l) => l.id === lotId) ?? null;

  const tools = (
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant={mode.kind === "rect" && mode.action === "dlba" ? "primary" : "secondary"} onClick={() => startRect("dlba")}>
        <RectIcon />
        Import DLBA
      </Button>
      <Button size="sm" variant={mode.kind === "rect" && mode.action === "vacant" ? "primary" : "secondary"} onClick={() => startRect("vacant")}>
        <RectIcon />
        Vacant parcels
      </Button>
      <Button size="sm" variant="secondary" onClick={() => setCsvOpen(true)}>
        <UploadIcon />
        Import CSV
      </Button>
      <Button
        size="sm"
        variant={paint.on ? "primary" : "secondary"}
        data-paint
        disabled={ccs.length === 0}
        onClick={() => {
          if (paint.on) {
            paint.close();
            return;
          }
          stopMode();
          setLotId(null);
          paint.open();
        }}
      >
        <PaintIcon />
        Paint
      </Button>
      <Button
        size="sm"
        variant={mode.kind === "add" ? "primary" : "secondary"}
        onClick={() => {
          paint.close();
          if (mode.kind === "add") stopMode();
          else setMode({ kind: "add" });
        }}
      >
        <PinIcon />
        Add lot
      </Button>
      <Button size="sm" variant={mode.kind === "rect" && mode.action === "assign" ? "primary" : "secondary"} disabled={lots.length === 0} onClick={() => startRect("assign")}>
        <RectIcon />
        Assign CC
      </Button>
      <Button size="sm" variant={mode.kind === "rect" && mode.action === "remove" ? "primary" : "secondary"} disabled={lots.length === 0} onClick={() => startRect("remove")}>
        <TrashIcon />
        Remove area
      </Button>
    </div>
  );

  if (noEvent) {
    return (
      <Page title="Lots" wide>
        <Panel>
          <EmptyState title="No active event" />
        </Panel>
      </Page>
    );
  }

  return (
    <Page title="Lots" wide>
      <div className="space-y-4">
        {tools}
        <Notice value={notice} onClear={clear} />
        <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <div className={`relative h-[62dvh] min-h-80 overflow-hidden rounded-2xl ring-1 ring-line lg:h-[calc(100dvh-13rem)] ${paint.on ? "[&_.leaflet-container]:cursor-crosshair" : ""}`}>
            {lotsQ.isLoading ? (
              <div className="h-full w-full animate-pulse bg-surface-2" aria-busy="true" aria-label="Loading" />
            ) : (
              <MapView markers={markers} onMapClick={mode.kind === "add" ? onMapClick : undefined} fitKey="lots" label="Lots map" className="absolute inset-0" onReady={setMap} />
            )}
            <AlleyLayer map={map} />
            <PaintFrame paint={paint} />
            <PaintBar
              paint={paint}
              extra={
                <FilterSelect label="Command center" value={paintCc ?? ""} onChange={(e) => setPaintCc(Number(e.target.value))} className="w-full">
                  <CcOptions ccs={ccs} />
                </FilterSelect>
              }
            />
            {mode.kind === "add" && <MapMode label="Add lot" detail={add.isPending ? "Adding…" : undefined} onCancel={stopMode} cancelLabel="Done" />}
            {mode.kind === "rect" && (
              <MapMode label={RECT_LABEL[mode.action]} detail={rectTool.step ? STEP_LABEL[rectTool.step] : undefined} onCancel={stopMode} />
            )}
            {!lotsQ.isLoading && lots.length === 0 && idle && !paint.on && (
              <div className="pointer-events-none absolute inset-x-4 bottom-10 z-[1000] flex justify-center">
                <div className="pointer-events-auto rounded-2xl bg-surface px-5 py-4 text-center shadow-lg ring-1 ring-line">
                  <p className="font-semibold">No lots yet</p>
                  <div className="mt-3 flex flex-wrap justify-center gap-2">
                    <Button size="sm" onClick={() => startRect("dlba")}>
                      Import DLBA
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => setCsvOpen(true)}>
                      Import CSV
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </div>
          <div className="space-y-4">
            <Panel title={counts.data ? plural(lots.length, "lot") : "Lots"}>
              {counts.isLoading ? (
                <SkeletonList rows={2} className="h-14" />
              ) : (
                <div className="space-y-3">
                  <div className="grid grid-cols-2 gap-2">
                    <Stat value={byStatus.get("open") ?? 0} label="Todo" tone="muted" />
                    <Stat value={byStatus.get("in_progress") ?? 0} label="In progress" tone="brand" />
                    <Stat value={byStatus.get("done") ?? 0} label="Done" tone="green" />
                    <Stat value={byStatus.get("do_not_touch") ?? 0} label="Do not touch" tone="warn" />
                  </div>
                  {bySource.length > 0 && (
                    <ul className="divide-y divide-line text-sm">
                      {bySource.map((s) => (
                        <li key={s.source} className="flex justify-between py-1.5">
                          <span>{SOURCE_LABEL[s.source] ?? s.source}</span>
                          <span className="font-semibold tabular-nums">{s.n.toLocaleString("en-US")}</span>
                        </li>
                      ))}
                      <li className="flex justify-between py-1.5">
                        <span>Without CC</span>
                        <span className="font-semibold tabular-nums">{(counts.data?.unassigned ?? 0).toLocaleString("en-US")}</span>
                      </li>
                    </ul>
                  )}
                </div>
              )}
            </Panel>
            <Panel title="Show">
              <Chips
                label="Show"
                value={filter}
                onChange={setFilter}
                options={[
                  { value: "all" as Filter, label: "All", badge: lots.length },
                  { value: "none" as Filter, label: "No CC", badge: counts.data?.unassigned ?? 0 },
                  ...ccs.filter((c) => perCc.has(c.id)).map((c) => ({ value: c.id as Filter, label: ccLabel(c), badge: perCc.get(c.id) ?? 0 })),
                ]}
              />
              <div className="mt-3 flex flex-wrap gap-1.5">
                {STATUS_OPTIONS.map((s) => (
                  <StatusPill key={s.value} status={lotPill(s.value)} />
                ))}
              </div>
            </Panel>
          </div>
        </div>
      </div>
      <RectSheet
        action={mode.kind === "rect" ? mode.action : null}
        rect={sheetRect}
        lots={lots}
        ccs={ccs}
        onClose={stopMode}
        onRedraw={() => setSheetRect(null)}
        notify={setNotice}
      />
      <LotSheet lot={selected} ccs={ccs} onClose={() => setLotId(null)} notify={setNotice} />
      <CsvSheet open={csvOpen} onClose={() => setCsvOpen(false)} notify={setNotice} ccs={ccs} />
    </Page>
  );
};
