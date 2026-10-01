import type { Map as LeafletMap } from "leaflet";
import { useMemo, useRef, useState } from "react";
import { Button } from "../../components/Button.tsx";
import { EmptyState } from "../../components/EmptyState.tsx";
import { errorText, useGreenInvalidate, type GreenLot } from "../../components/green/hooks.ts";
import { FilterSelect, RectIcon, useFlash } from "../../components/green/ui.tsx";
import { MissingAfterToggle, PairPill } from "../../components/photos/PairPill.tsx";
import { Segmented } from "../../components/Segmented.tsx";
import { Skeleton } from "../../components/Skeleton.tsx";
import { lotPill, StatusPill } from "../../components/StatusPill.tsx";
import { MapView, type MapMarker } from "../../lib/map/MapView.tsx";
import { insideRect, STEP_LABEL, useOrientedRect, type OrientedRect } from "../../lib/map/orientedRect.ts";
import { trpc } from "../../lib/trpc.ts";

type StatusFilter = "all" | GreenLot["status"];
const NO_CREW = "none";

const STATUS_OPTIONS: ReadonlyArray<{ value: StatusFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "open", label: "Open" },
  { value: "in_progress", label: "In progress" },
  { value: "done", label: "Done" },
  { value: "skipped", label: "Skipped" },
];

export const LotsPage = () => {
  const q = trpc.green.lots.useQuery();
  const refresh = useGreenInvalidate();
  const assign = trpc.green.assignLots.useMutation({ onSettled: refresh });
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  const [status, setStatus] = useState<StatusFilter>("all");
  const [crewFilter, setCrewFilter] = useState<string>("");
  const [missingAfter, setMissingAfter] = useState(false);
  const [target, setTarget] = useState<string>("");
  const [drawing, setDrawing] = useState(false);
  const [rect, setRect] = useState<OrientedRect | null>(null);
  // Lots the rectangle added, so moving its handles swaps them for the new set.
  const fromRect = useRef<Set<number>>(new Set());
  const [map, setMap] = useState<LeafletMap | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [flash, showFlash] = useFlash();

  const lots = q.data?.lots ?? [];
  const crews = q.data?.crews ?? [];
  const crewName = useMemo(() => new Map(crews.map((c) => [c.id, c.name])), [crews]);
  const targetValue = target || (crews[0] ? String(crews[0].id) : NO_CREW);

  const shown = useMemo(
    () =>
      lots.filter(
        (l) =>
          (status === "all" || l.status === status) &&
          (crewFilter === "" || (crewFilter === NO_CREW ? l.crewId === null : l.crewId === Number(crewFilter))) &&
          (!missingAfter || l.photos === "before"),
      ),
    [lots, status, crewFilter, missingAfter],
  );

  const toggle = (id: number): void =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const onRect = (r: OrientedRect): void => {
    const inside = new Set(insideRect(lots, r).map((l) => l.id));
    const old = fromRect.current;
    fromRect.current = inside;
    setSelected((prev) => new Set([...[...prev].filter((id) => !old.has(id)), ...inside]));
    setRect(r);
    setDrawing(false);
  };
  const tool = useOrientedRect(map, { drawing, value: rect, editable: true, onChange: onRect, onCancel: () => setDrawing(false) });

  const markers = useMemo<MapMarker[]>(() => {
    const out: MapMarker[] = lots.map((l) => ({
      id: `lot-${l.id}`,
      kind: "lot",
      lat: l.lat,
      lng: l.lng,
      status: l.status,
      geometry: l.geometry,
      mine: selected.size === 0 || selected.has(l.id),
      selected: selected.has(l.id),
      title: l.address ?? undefined,
      onClick: drawing ? undefined : () => toggle(l.id),
    }));
    return out;
  }, [lots, selected, drawing]);

  const clear = (): void => {
    setSelected(new Set());
    setRect(null);
    fromRect.current = new Set();
    setErr(null);
  };

  const doAssign = (): void => {
    const crewId = targetValue === NO_CREW ? null : Number(targetValue);
    const ids = [...selected];
    setErr(null);
    assign.mutate(
      { lotIds: ids, crewId },
      {
        onSuccess: (r) => {
          showFlash(`${r.updated === 1 ? "1 lot" : `${r.updated} lots`}, ${crewId === null ? "No crew" : (crewName.get(crewId) ?? "Crew")}`);
          clear();
        },
        onError: (e) => setErr(errorText(e)),
      },
    );
  };

  // Counts per crew, crews in number order, then lots with no crew.
  const countRows = useMemo(() => {
    const byCrew = new Map((q.data?.counts ?? []).map((c) => [c.crewId, c.counts]));
    const rows = crews.map((c) => ({ key: String(c.id), name: c.name, company: c.companyName, counts: byCrew.get(c.id) ?? null }));
    const none = byCrew.get(null);
    if (none) rows.push({ key: NO_CREW, name: "No crew", company: null, counts: none });
    return rows;
  }, [q.data, crews]);

  if (q.isLoading) {
    return (
      <div className="mx-auto w-full max-w-6xl space-y-4 px-4 py-4 nav:px-6 nav:py-6">
        <Skeleton className="h-8 w-24" />
        <Skeleton className="h-[45dvh]" />
        <Skeleton className="h-64" />
      </div>
    );
  }
  if (q.isError) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-4">
        <EmptyState title="Lots not loaded" description="Check the connection" action={<Button onClick={() => void q.refetch()}>Retry</Button>} />
      </div>
    );
  }
  if (lots.length === 0) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-4">
        <EmptyState title="No lots at this CC" />
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-7xl px-4 pt-4 nav:px-6 nav:pt-6">
      <h1 className="mb-4 text-2xl font-bold tracking-tight">Lots</h1>
      <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:gap-6">
        <div className="lg:sticky lg:top-4 lg:self-start">
          <div className={`relative h-[45dvh] overflow-hidden rounded-2xl ring-1 ring-line lg:h-[calc(100dvh-10rem)] ${drawing ? "[&_.leaflet-container]:cursor-crosshair" : ""}`}>
            <MapView markers={markers} label="Lots map" className="absolute inset-0" onReady={setMap} />
            <div className="pointer-events-none absolute top-3 right-3 z-[1000] flex flex-col items-end gap-2">
              {drawing ? (
                <div className="pointer-events-auto flex items-center gap-2 rounded-full bg-ink py-1 pr-1 pl-4 text-surface shadow-lg">
                  <span className="font-semibold">{STEP_LABEL[tool.step ?? "first"]}</span>
                  <button
                    type="button"
                    onClick={() => setDrawing(false)}
                    className="min-h-10 rounded-full bg-surface px-4 text-sm font-semibold text-ink"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <Button className="pointer-events-auto shadow-lg" onClick={() => setDrawing(true)}>
                  <RectIcon />
                  Rectangle
                </Button>
              )}
            </div>
          </div>
        </div>

        <div className="min-w-0">
          <section aria-label="Assign" className="sticky top-0 z-[1100] -mx-4 mt-4 border-b border-line bg-surface px-4 py-3 lg:mx-0 lg:mt-0 lg:rounded-2xl lg:border lg:px-4">
            <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 sm:flex sm:flex-wrap">
              <span className="text-base font-bold tabular-nums sm:min-w-24">{selected.size === 1 ? "1 selected" : `${selected.size} selected`}</span>
              <Button variant="ghost" size="sm" className="justify-self-end sm:order-last" onClick={clear} disabled={selected.size === 0 && !rect}>
                Clear
              </Button>
              <FilterSelect label="Crew" value={targetValue} onChange={(e) => setTarget(e.target.value)} className="min-w-0 sm:flex-1 sm:basis-40">
                {crews.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.companyName ? `${c.name}, ${c.companyName}` : c.name}
                  </option>
                ))}
                <option value={NO_CREW}>No crew</option>
              </FilterSelect>
              <Button onClick={doAssign} disabled={selected.size === 0} busy={assign.isPending}>
                Assign
              </Button>
            </div>
            {err && (
              <p role="alert" className="mt-2 text-sm font-semibold">
                {err}
              </p>
            )}
          </section>

          <section aria-labelledby="counts-h" className="mt-6">
            <h2 id="counts-h" className="mb-2 text-lg font-bold">
              By crew
            </h2>
            <div className="overflow-x-auto rounded-2xl ring-1 ring-line">
              <table className="w-full text-sm">
                <thead className="bg-surface-2 text-left text-xs text-muted uppercase">
                  <tr>
                    <th className="px-3 py-2 font-semibold">Crew</th>
                    <th className="px-1.5 py-2 text-right font-semibold">Open</th>
                    <th className="px-1.5 py-2 text-right font-semibold">
                      In progress
                    </th>
                    <th className="px-1.5 py-2 text-right font-semibold">Done</th>
                    <th className="px-3 py-2 text-right font-semibold">
                      Skipped
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {countRows.map((r) => (
                    <tr key={r.key} className="border-t border-line">
                      <td className="px-3 py-2">
                        <span className="font-semibold whitespace-nowrap">{r.name}</span>
                        {r.company && <span className="block text-xs text-muted sm:inline sm:text-sm">
                          <span className="hidden sm:inline">, </span>
                          {r.company}
                        </span>}
                      </td>
                      <td className="px-1.5 py-2 text-right tabular-nums">{r.counts?.open ?? 0}</td>
                      <td className="px-1.5 py-2 text-right tabular-nums">{r.counts?.in_progress ?? 0}</td>
                      <td className="px-1.5 py-2 text-right font-semibold tabular-nums">{r.counts?.done ?? 0}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{r.counts?.skipped ?? 0}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section aria-labelledby="lots-h" className="mt-6 pb-8">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <h2 id="lots-h" className="text-lg font-bold">
                All lots <span className="font-semibold text-muted tabular-nums">{shown.length}</span>
              </h2>
              <Button variant="secondary" size="sm" disabled={shown.length === 0} onClick={() => setSelected((prev) => new Set([...prev, ...shown.map((l) => l.id)]))}>
                Select shown
              </Button>
            </div>
            <div className="mb-3 space-y-2">
              <Segmented tabs stacked label="Status" value={status} onChange={setStatus} options={STATUS_OPTIONS.map((o) => ({ ...o, count: o.value === "all" ? lots.length : lots.filter((l) => l.status === o.value).length }))} />
              <div className="flex items-center gap-2">
                <FilterSelect label="Crew filter" value={crewFilter} onChange={(e) => setCrewFilter(e.target.value)} className="min-w-0 flex-1">
                  <option value="">All crews</option>
                  {crews.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                  <option value={NO_CREW}>No crew</option>
                </FilterSelect>
                <MissingAfterToggle on={missingAfter} onChange={setMissingAfter} count={lots.filter((l) => l.photos === "before").length} />
              </div>
            </div>
            {shown.length === 0 ? (
              <div className="rounded-2xl border-2 border-dashed border-line px-4 py-10 text-center font-semibold text-muted">No lots match</div>
            ) : (
              <div className="overflow-x-auto rounded-2xl ring-1 ring-line">
                <table className="w-full text-sm">
                  <thead className="bg-surface-2 text-left text-xs text-muted uppercase">
                    <tr>
                      <th className="w-12 px-3 py-2">
                        <span className="sr-only">Selected</span>
                      </th>
                      <th className="px-2 py-2 font-semibold">Address</th>
                      <th className="px-2 py-2 font-semibold">Status</th>
                      <th className="px-2 py-2 font-semibold">Photos</th>
                      <th className="px-3 py-2 font-semibold">Crew</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((l) => {
                      const on = selected.has(l.id);
                      return (
                        <tr key={l.id} onClick={() => toggle(l.id)} className={`cursor-pointer border-t border-line ${on ? "bg-brand/15" : "hover:bg-surface-2"}`}>
                          <td className="px-3 py-1">
                            <input
                              type="checkbox"
                              checked={on}
                              onChange={() => toggle(l.id)}
                              onClick={(e) => e.stopPropagation()}
                              aria-label={l.address || "Lot"}
                              className="block h-5 w-5 accent-[var(--ink)]"
                            />
                          </td>
                          <td className="px-2 py-3 font-semibold break-words">{l.address || "No address"}</td>
                          <td className="px-2 py-3">
                            <StatusPill status={lotPill(l.status)} />
                          </td>
                          <td className="px-2 py-3">
                            <PairPill state={l.photos} />
                          </td>
                          <td className="px-3 py-3 whitespace-nowrap">{l.crewId !== null ? (crewName.get(l.crewId) ?? "Crew") : <span className="text-muted">None</span>}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      </div>
      <div className="pointer-events-none fixed inset-x-0 bottom-[max(1.5rem,env(safe-area-inset-bottom))] z-[1200] flex justify-center">{flash}</div>
    </div>
  );
};
