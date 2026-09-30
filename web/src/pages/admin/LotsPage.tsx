import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Button } from "../../components/Button.tsx";
import { EmptyState } from "../../components/EmptyState.tsx";
import { Field, Select, TextArea } from "../../components/Field.tsx";
import { Page } from "../../components/Page.tsx";
import { Sheet } from "../../components/Sheet.tsx";
import { lotPill, StatusPill } from "../../components/StatusPill.tsx";
import { Chips } from "../../components/Segmented.tsx";
import { plural, SOURCE_LABEL } from "../../components/admin/format.ts";
import { PinIcon, RectIcon, TrashIcon, UploadIcon } from "../../components/admin/icons.tsx";
import { MapMode } from "../../components/admin/MapMode.tsx";
import { errorText, Notice, type NoticeValue } from "../../components/admin/Notice.tsx";
import { Panel, Stat } from "../../components/Panel.tsx";
import { SkeletonList } from "../../components/Skeleton.tsx";
import { bboxText, inBBox, useRectDraw, type BBox } from "../../components/admin/rect.ts";
import { Segmented } from "../../components/Segmented.tsx";
import { MapView, type MapMarker } from "../../lib/map/MapView.tsx";
import { trpc, type RouterOutputs } from "../../lib/trpc.ts";

type Lot = RouterOutputs["admin"]["lots"]["list"][number];
type Cc = RouterOutputs["admin"]["ccs"]["list"][number];
type LotStatus = Lot["status"];
type RectAction = "dlba" | "vacant" | "assign" | "remove";
type Mode = { kind: "idle" } | { kind: "add" } | { kind: "rect"; action: RectAction };

/** The server refuses bigger rectangles; about 25 by 33 km at Detroit's latitude. */
const MAX_SPAN_DEG = 0.3;

const STATUS_OPTIONS: ReadonlyArray<{ value: LotStatus; label: string }> = [
  { value: "open", label: "Open" },
  { value: "in_progress", label: "In progress" },
  { value: "done", label: "Done" },
  { value: "skipped", label: "Skipped" },
];

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
  bbox,
  lots,
  ccs,
  onClose,
  onRedraw,
  notify,
}: {
  action: RectAction | null;
  bbox: BBox | null;
  lots: readonly Lot[];
  ccs: readonly Cc[];
  onClose: () => void;
  onRedraw: () => void;
  notify: (n: NoticeValue) => void;
}) => {
  const utils = trpc.useUtils();
  const open = action !== null && bbox !== null;
  const tooBig = bbox !== null && (bbox[2] - bbox[0] > MAX_SPAN_DEG || bbox[3] - bbox[1] > MAX_SPAN_DEG);
  const inside = useMemo(() => (bbox ? lots.filter((l) => inBBox(l, bbox)) : []), [lots, bbox]);
  const [ccId, setCcId] = useState<number | "none">("none");
  useEffect(() => {
    if (open) setCcId(ccs[0]?.id ?? "none");
  }, [open, ccs]);

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
          : `${plural(r.added, "lot")} added, ${r.updated.toLocaleString("en-US")} updated, ${r.outlines.toLocaleString("en-US")} outlines`,
      ),
    onError: fail,
  });
  const vacantCount = trpc.admin.lots.countVacant.useQuery({ bbox: bbox ?? [0, 0, 0, 0] }, { enabled: open && action === "vacant" && !tooBig, retry: false, staleTime: 60_000 });
  const vacant = trpc.admin.lots.importVacant.useMutation({
    onSuccess: (r) => finish(`${plural(r.added, "lot")} added, ${r.updated.toLocaleString("en-US")} updated`),
    onError: fail,
  });
  const assign = trpc.admin.lots.assignCc.useMutation({
    onSuccess: (r) => {
      const cc = ccs.find((c) => c.id === ccId);
      finish(cc ? `${plural(r.updated, "lot")} to CC ${cc.name}` : `${plural(r.updated, "lot")} without CC`);
    },
    onError: fail,
  });
  const remove = trpc.admin.lots.deleteInBBox.useMutation({
    onSuccess: (r) => finish(`${plural(r.deleted, "lot")} removed`),
    onError: fail,
  });

  if (!open || !action || !bbox) return null;

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
    body = <Stat value={plural(inside.length, "lot")} label="Already in this area" />;
    footer = (
      <Button block size="lg" busy={dlba.isPending} onClick={() => dlba.mutate({ bbox })}>
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
      <div className="grid grid-cols-2 gap-2">
        <Stat value={n ?? 0} label="Residential vacant" />
        <Stat value={inside.length} label="Lots already here" />
      </div>
    );
    footer = (
      <Button block size="lg" busy={vacant.isPending} disabled={!n} onClick={() => vacant.mutate({ bbox })}>
        {n ? `Import ${plural(n, "parcel")}` : "Nothing to import"}
      </Button>
    );
  } else if (action === "assign") {
    body = (
      <div className="space-y-4">
        <Stat value={plural(inside.length, "lot")} label="In this area" />
        <Select label="Command center" value={ccId} onChange={(e) => setCcId(e.target.value === "none" ? "none" : Number(e.target.value))}>
          <option value="none">No CC</option>
          <CcOptions ccs={ccs} />
        </Select>
      </div>
    );
    footer = (
      <Button block size="lg" busy={assign.isPending} disabled={inside.length === 0} onClick={() => assign.mutate({ bbox, ccId: ccId === "none" ? null : ccId })}>
        {inside.length ? `Assign ${plural(inside.length, "lot")}` : "No lots here"}
      </Button>
    );
  } else {
    body = <Stat value={plural(inside.length, "lot")} label="In this area" tone="warn" />;
    footer = (
      <Button block size="lg" variant="danger" busy={remove.isPending} disabled={inside.length === 0} onClick={() => remove.mutate({ bbox })}>
        {inside.length ? `Remove ${plural(inside.length, "lot")}` : "No lots here"}
      </Button>
    );
  }

  return (
    <Sheet open onClose={onClose} title={RECT_LABEL[action]} footer={footer}>
      <div className="space-y-3 pb-2">
        <p className="text-sm text-muted">Area {bboxText(bbox)}</p>
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
    <Sheet
      open
      onClose={onClose}
      title={lot.address ?? "Lot"}
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
      <div className="space-y-4 pb-2">
        <dl className="grid grid-cols-2 gap-2 text-sm">
          <div className="rounded-xl bg-surface-2 px-3 py-2">
            <dt className="text-muted">Source</dt>
            <dd className="font-semibold">{SOURCE_LABEL[lot.source] ?? lot.source}</dd>
          </div>
          <div className="rounded-xl bg-surface-2 px-3 py-2">
            <dt className="text-muted">Crew</dt>
            <dd className="font-semibold">{lot.crewNumber != null ? `Crew ${lot.crewNumber}${cc ? `, ${cc.dayLabel}` : ""}` : "None"}</dd>
          </div>
          {lot.parcelId && (
            <div className="col-span-2 rounded-xl bg-surface-2 px-3 py-2">
              <dt className="text-muted">Parcel</dt>
              <dd className="font-mono font-semibold break-all">{lot.parcelId}</dd>
            </div>
          )}
        </dl>
        <Segmented
          label="Status"
          value={lot.status}
          options={STATUS_OPTIONS}
          onChange={(status) => update.mutate({ id: lot.id, status })}
        />
        <Select label="Command center" value={ccId} onChange={(e) => setCcId(e.target.value === "none" ? "none" : Number(e.target.value))}>
          <option value="none">No CC</option>
          <CcOptions ccs={ccs} />
        </Select>
        <Field label="Address" value={address} onChange={(e) => setAddress(e.target.value)} maxLength={200} autoComplete="off" />
        <TextArea label="Note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} />
      </div>
    </Sheet>
  );
};
// #endregion

// #region CSV sheet
const CsvSheet = ({ open, onClose, notify }: { open: boolean; onClose: () => void; notify: (n: NoticeValue) => void }) => {
  const utils = trpc.useUtils();
  const [csv, setCsv] = useState("");
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
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Import lots"
      footer={
        <Button block size="lg" disabled={rows < 1} busy={importCsv.isPending} onClick={() => importCsv.mutate({ csv })}>
          {rows > 0 ? `Import ${plural(rows, "row")}` : "Import"}
        </Button>
      }
    >
      <div className="space-y-4 pb-2">
        <div className="rounded-xl bg-surface-2 px-4 py-3">
          <div className="text-sm text-muted">Columns</div>
          <code className="block font-mono text-sm">address, lat, lng, parcel_id</code>
        </div>
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

export const LotsPage = () => {
  const lotsQ = trpc.admin.lots.list.useQuery(undefined, { retry: false });
  const counts = trpc.admin.lots.counts.useQuery(undefined, { retry: false });
  const ccsQ = trpc.admin.ccs.list.useQuery(undefined, { retry: false });
  const utils = trpc.useUtils();
  const [mode, setMode] = useState<Mode>({ kind: "idle" });
  const [sheetBBox, setSheetBBox] = useState<BBox | null>(null);
  const [lotId, setLotId] = useState<number | null>(null);
  const [csvOpen, setCsvOpen] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [notice, setNotice] = useState<NoticeValue>(null);
  const clear = useCallback(() => setNotice(null), []);
  const rect = useRectDraw();
  const lots = lotsQ.data ?? [];
  const ccs = ccsQ.data ?? [];
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
    rect.reset();
  };
  const startRect = (action: RectAction): void => {
    rect.reset();
    setMode({ kind: "rect", action });
  };

  const onMapClick = (lat: number, lng: number): void => {
    if (mode.kind === "add") add.mutate({ lat, lng });
    else if (mode.kind === "rect") {
      const bbox = rect.tap(lat, lng);
      if (bbox) setSheetBBox(bbox);
    }
  };

  // CC flags: one per place, not one per day.
  const ccMarkers = useMemo<MapMarker[]>(() => {
    const seen = new Map<string, Cc>();
    for (const c of ccs) {
      const key = `${c.name}|${c.lat.toFixed(4)}|${c.lng.toFixed(4)}`;
      if (!seen.has(key)) seen.set(key, c);
    }
    return [...seen.values()].map((c) => ({ id: `cc-${c.id}`, kind: "cc", lat: c.lat, lng: c.lng, name: `CC ${c.name}`, noFit: true }));
  }, [ccs]);

  const shown = useMemo(
    () => lots.filter((l) => filter === "all" || (filter === "none" ? l.ccId === null : l.ccId === filter)),
    [lots, filter],
  );
  const idle = mode.kind === "idle";
  const lotMarkers = useMemo<MapMarker[]>(
    () =>
      shown.map((l) => ({
        id: `lot-${l.id}`,
        kind: "lot",
        lat: l.lat,
        lng: l.lng,
        status: l.status,
        geometry: l.geometry,
        mine: l.ccId !== null,
        title: l.address ?? undefined,
        onClick: idle ? () => setLotId(l.id) : undefined,
      })),
    [shown, idle],
  );
  const markers = useMemo(() => [...lotMarkers, ...ccMarkers, ...rect.markers], [lotMarkers, ccMarkers, rect.markers]);

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
      <Button size="sm" variant={mode.kind === "add" ? "primary" : "secondary"} onClick={() => (mode.kind === "add" ? stopMode() : setMode({ kind: "add" }))}>
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
          <div className="relative h-[62dvh] min-h-80 overflow-hidden rounded-2xl ring-1 ring-line lg:h-[calc(100dvh-13rem)]">
            {lotsQ.isLoading ? (
              <div className="h-full w-full animate-pulse bg-surface-2" aria-busy="true" aria-label="Loading" />
            ) : (
              <MapView markers={markers} lines={rect.lines} onMapClick={idle ? undefined : onMapClick} fitKey="lots" label="Lots map" className="absolute inset-0" />
            )}
            {mode.kind === "add" && <MapMode label="Add lot" detail={add.isPending ? "Adding…" : undefined} onCancel={stopMode} cancelLabel="Done" />}
            {mode.kind === "rect" && (
              <MapMode label={RECT_LABEL[mode.action]} detail={rect.step === 1 ? "Corner 1 of 2" : "Corner 2 of 2"} onCancel={stopMode} />
            )}
            {!lotsQ.isLoading && lots.length === 0 && idle && (
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
                    <Stat value={byStatus.get("open") ?? 0} label="Open" tone="muted" />
                    <Stat value={byStatus.get("in_progress") ?? 0} label="In progress" tone="brand" />
                    <Stat value={byStatus.get("done") ?? 0} label="Done" tone="green" />
                    <Stat value={byStatus.get("skipped") ?? 0} label="Skipped" tone="warn" />
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
        bbox={sheetBBox}
        lots={lots}
        ccs={ccs}
        onClose={() => {
          setSheetBBox(null);
          stopMode();
        }}
        onRedraw={() => {
          setSheetBBox(null);
          rect.reset();
        }}
        notify={setNotice}
      />
      <LotSheet lot={selected} ccs={ccs} onClose={() => setLotId(null)} notify={setNotice} />
      <CsvSheet open={csvOpen} onClose={() => setCsvOpen(false)} notify={setNotice} />
    </Page>
  );
};
