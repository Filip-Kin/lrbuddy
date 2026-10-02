import type { Map as LeafletMap } from "leaflet";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "../../components/Button.tsx";
import { EmptyState } from "../../components/EmptyState.tsx";
import { AddStopSheet } from "../../components/green/AddStopSheet.tsx";
import { AreaSheet, AssignAreaSheet } from "../../components/green/DayOfSheets.tsx";
import { PaintBar, PaintFrame, PaintIcon, usePaint } from "../../components/PaintBar.tsx";
import { DrawLotBar, DrawLotIcon, DrawLotSheet, useDrawLot } from "../../components/DrawLot.tsx";
import { useOsmAlleys } from "../../lib/map/alleyLayer.ts";
import type { PaintTarget } from "../../lib/map/paintHit.ts";
import { useDayOfLayer } from "../../components/green/dayOfLayer.ts";
import { isUrgent, useNow, type GreenRequest } from "../../components/green/hooks.ts";
import { CrewSheet, LotSheet, StopSheet, TruckSheet, type GreenParcel } from "../../components/green/MapSheets.tsx";
import { MapLegend } from "../../components/MapLegend.tsx";
import { useSetLot } from "../../components/LotStatusControl.tsx";
import { insideRect, rectFromRing, rectPolygon, STEP_LABEL, useOrientedRect, type OrientedRect } from "../../lib/map/orientedRect.ts";
import { useParcelLayer } from "../../lib/map/parcelLayer.ts";
import { FilterSelect, PinIcon, useFlash } from "../../components/green/ui.tsx";
import { ToggleChip } from "../../components/Segmented.tsx";
import { MapView, type MapMarker } from "../../lib/map/MapView.tsx";
import { useOnewayLayer } from "../../lib/map/onewayLayer.ts";
import { trpc } from "../../lib/trpc.ts";
import { RecenterIcon } from "../../components/driver/icons.tsx";
import { geolocation } from "../../lib/safe.ts";

type Selected = { kind: "crew" | "truck" | "lot" | "stop" | "area"; id: number } | { kind: "parcel"; parcelId: string } | null;

const DrawIcon = () => (
  <svg viewBox="0 0 24 24" width={22} height={22} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round">
    <path d="M4 8l9-4 7 12-9 4z" />
  </svg>
);

export const MapPage = () => {
  const now = useNow();
  const overview = trpc.green.overview.useQuery(undefined, { refetchInterval: 30_000 });
  // Own position, shown only on this phone (greens do not report it).
  const [me, setMe] = useState<{ lat: number; lng: number; accuracy: number } | null>(null);
  useEffect(() => {
    const geo = geolocation();
    if (!geo) return;
    const id = geo.watchPosition(
      (p) => setMe({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }),
      () => undefined,
      { enableHighAccuracy: true, maximumAge: 0, timeout: 30_000 },
    );
    return () => geo.clearWatch(id);
  }, []);
  const [company, setCompany] = useState<number | null>(null);
  const [crewFilter, setCrewFilter] = useState<number | null>(null);
  const [showRequests, setShowRequests] = useState(true);
  const [showLots, setShowLots] = useState(true);
  const [showTrucks, setShowTrucks] = useState(true);
  const [showAreas, setShowAreas] = useState(true);
  const [showOsmAlleys, setShowOsmAlleys] = useState(false);
  const [map, setMap] = useState<LeafletMap | null>(null);
  // Recenter: follow the blue dot until the map is moved by hand.
  const [follow, setFollow] = useState(false);
  useEffect(() => {
    if (follow && map && me) map.panTo([me.lat, me.lng], { animate: true, duration: 0.5 });
  }, [follow, map, me]);
  useEffect(() => {
    if (!map) return;
    const stop = (): void => setFollow(false);
    map.on("dragstart zoomstart", stop);
    return () => {
      map.off("dragstart zoomstart", stop);
    };
  }, [map]);
  const plan = trpc.green.plan.useQuery(undefined, { refetchInterval: 60_000 });
  const [selected, setSelected] = useState<Selected>(null);
  const [placing, setPlacing] = useState(false);
  const [pin, setPin] = useState<{ lat: number; lng: number } | null>(null);
  const [flash, showFlash] = useFlash();
  const parcels = trpc.green.parcels.useQuery(undefined, { refetchInterval: 120_000 });
  const lotWrites = useSetLot("green");
  // Draw area (SPEC 21): draw a rectangle, then the Assign sheet; Edit corners moves a rectangle's outline.
  const [drawing, setDrawing] = useState(false);
  const [draft, setDraft] = useState<OrientedRect | null>(null);
  const [editAreaId, setEditAreaId] = useState<number | null>(null);
  const moveArea = trpc.green.moveArea.useMutation();
  // Paint mode (SPEC 23): every lot and bare parcel at the CC is a target, whatever the filters show.
  const paintTargets = useMemo<PaintTarget[]>(() => {
    const out: PaintTarget[] = [];
    for (const l of overview.data?.lots ?? []) {
      out.push({ key: `l:${l.id}`, lotId: l.id, parcelId: l.parcelId, status: lotWrites.pending.get(`l:${l.id}`) ?? l.status, crewId: l.crewId, lat: l.lat, lng: l.lng, geometry: l.geometry });
    }
    for (const p of parcels.data ?? []) {
      const st = lotWrites.pending.get(`p:${p.parcelId}`) ?? null;
      out.push({ key: `p:${p.parcelId}`, lotId: null, parcelId: p.parcelId, status: st, crewId: null, lat: p.lat, lng: p.lng, geometry: p.geometry });
    }
    return out;
  }, [overview.data?.lots, parcels.data, lotWrites.pending]);
  const paint = usePaint(map, { kind: "green" }, paintTargets);
  const pending = useMemo(() => (paint.pending.size === 0 ? lotWrites.pending : new Map([...lotWrites.pending, ...paint.pending])), [lotWrites.pending, paint.pending]);
  const painting = paint.on;
  // Draw lot (SPEC 24): taps outline a new lot; Edit shape moves a drawn lot's points.
  const drawLot = useDrawLot(map, { kind: "green" }, showFlash);
  const lotDrawing = drawLot.mode !== null;
  useOsmAlleys(map, showOsmAlleys);

  const d = overview.data;
  const crews = d?.crews ?? [];
  const trucks = d?.trucks ?? [];
  const openRequests: GreenRequest[] = d?.openRequests ?? [];

  // Crew filter wins; company narrows the crew list.
  const visibleCrewIds = useMemo(() => {
    if (crewFilter !== null) return new Set([crewFilter]);
    if (company !== null) return new Set(crews.filter((c) => c.companyId === company).map((c) => c.id));
    return null;
  }, [crews, company, crewFilter]);

  const markers = useMemo<MapMarker[]>(() => {
    if (!d) return [];
    const crewVisible = (id: number | null): boolean => visibleCrewIds === null || (id !== null && visibleCrewIds.has(id));
    const out: MapMarker[] = [];
    if (showLots) {
      for (const l of d.lots) {
        if (!crewVisible(l.crewId)) continue;
        const status = pending.get(`l:${l.id}`) ?? l.status;
        out.push({
          id: `lot-${l.id}`,
          kind: "lot",
          lat: l.lat,
          lng: l.lng,
          status,
          geometry: l.geometry,
          parcelId: l.parcelId,
          mine: l.crewId !== null || status === "not_todo",
          noFit: true,
          title: l.address ?? undefined,
          onClick: drawing || painting || lotDrawing ? undefined : () => setSelected({ kind: "lot", id: l.id }),
        });
      }
    }
    out.push({ id: "cc", kind: "cc", lat: d.cc.lat, lng: d.cc.lng, name: `CC ${d.cc.name}`, letter: d.cc.letter });
    const crewPos = new Map<number, { lat: number; lng: number }>();
    for (const c of d.crews) {
      if (!c.position) continue;
      crewPos.set(c.id, c.position);
      if (!crewVisible(c.id)) continue;
      out.push({ id: `crew-${c.id}`, kind: "crew", lat: c.position.lat, lng: c.position.lng, label: c.name, title: c.name, onClick: () => setSelected({ kind: "crew", id: c.id }) });
    }
    if (showRequests) {
      // One ring per crew however many requests it has open; crewless stops ring their own pin.
      const ringed = new Set<number>();
      for (const r of openRequests) {
        if (r.crewId !== null) {
          if (!crewVisible(r.crewId) || ringed.has(r.crewId)) continue;
          const p = crewPos.get(r.crewId) ?? (r.lat !== null && r.lng !== null ? { lat: r.lat, lng: r.lng } : null);
          if (!p) continue;
          ringed.add(r.crewId);
          const crewId = r.crewId;
          const urgent = openRequests.some((x) => x.crewId === crewId && isUrgent(x, now));
          out.push({ id: `req-crew-${crewId}`, kind: "request", lat: p.lat, lng: p.lng, urgent, onClick: () => setSelected({ kind: "crew", id: crewId }) });
        } else if (visibleCrewIds === null && r.lat !== null && r.lng !== null) {
          const id = r.id;
          out.push({ id: `req-${id}`, kind: "request", lat: r.lat, lng: r.lng, urgent: isUrgent(r, now), onClick: () => setSelected({ kind: "stop", id }) });
        }
      }
    }
    if (showTrucks) {
      for (const t of d.trucks) {
        if (t.position) out.push({ id: `truck-${t.id}`, kind: "truck", lat: t.position.lat, lng: t.position.lng, name: t.name, onClick: () => setSelected({ kind: "truck", id: t.id }) });
      }
    }
    if (pin) out.push({ id: "pin", kind: "request", lat: pin.lat, lng: pin.lng, urgent: true, noFit: true });
    if (me) out.push({ id: "me", kind: "me", lat: me.lat, lng: me.lng, accuracy: me.accuracy, noFit: true });
    return out;
  }, [d, openRequests, visibleCrewIds, showLots, showRequests, showTrucks, pin, now, pending, drawing, painting, lotDrawing, me]);

  const onArea = useCallback((id: number) => setSelected({ kind: "area", id }), []);
  const onParcel = useCallback((parcelId: string) => setSelected({ kind: "parcel", parcelId }), []);
  const editing = editAreaId !== null;
  useDayOfLayer(map, plan.data, showAreas && !placing && !drawing && !editing && !lotDrawing, onArea);
  // Bare parcels in the day area (SPEC 21), only with no crew or company filter: they belong to nobody yet.
  // While painting they show at any zoom and with any filter, so there is something to hit (SPEC 23).
  useParcelLayer(map, parcels.data, (showLots || painting) && !placing && !drawing && !editing && !lotDrawing && (visibleCrewIds === null || painting), onParcel, pending, painting);

  const editArea = editAreaId !== null ? (plan.data?.areas.find((a) => a.id === editAreaId) ?? null) : null;
  const editRect = useMemo(() => (editArea ? rectFromRing(editArea.ring) : null), [editArea]);
  const tool = useOrientedRect(map, {
    drawing,
    value: drawing ? null : (draft ?? editRect),
    editable: !drawing,
    onChange: (r) => {
      if (editAreaId !== null && !drawing) {
        moveArea.mutate({ areaId: editAreaId, polygon: rectPolygon(r) }, { onSuccess: () => void plan.refetch(), onError: () => showFlash("Not saved") });
        return;
      }
      setDraft(r);
      setDrawing(false);
    },
    onCancel: () => setDrawing(false),
  });
  const draftPolygon = useMemo(() => (draft ? rectPolygon(draft) : null), [draft]);
  const todoInside = useMemo(() => (draft && d ? insideRect(d.lots.filter((l) => l.status === "open"), draft).length : 0), [draft, d]);
  useOnewayLayer(map);

  const companyCrews = company === null ? crews : crews.filter((c) => c.companyId === company);
  const selArea = selected?.kind === "area" ? (plan.data?.areas.find((a) => a.id === selected.id) ?? null) : null;
  const selCrew = selected?.kind === "crew" ? (crews.find((c) => c.id === selected.id) ?? null) : null;
  const selTruck = selected?.kind === "truck" ? (trucks.find((t) => t.id === selected.id) ?? null) : null;
  const selLot = selected?.kind === "lot" ? (d?.lots.find((l) => l.id === selected.id) ?? null) : null;
  const selBare = selected?.kind === "parcel" ? (parcels.data?.find((p) => p.parcelId === selected.parcelId) ?? null) : null;
  // A bare parcel that just became a lot keeps its sheet open on the new lot.
  const selBareLot = selected?.kind === "parcel" && !selBare ? (d?.lots.find((l) => l.parcelId === selected.parcelId) ?? null) : null;
  const sheetLot = selLot ?? selBareLot;
  const sheetParcel: GreenParcel | null = sheetLot
    ? {
        lotId: sheetLot.id,
        parcelId: sheetLot.parcelId,
        address: sheetLot.address,
        status: pending.get(`l:${sheetLot.id}`) ?? sheetLot.status,
        grade: sheetLot.grade,
        note: sheetLot.note,
        crewId: sheetLot.crewId,
        statusAt: sheetLot.statusAt,
        drawn: sheetLot.source === "drawn",
      }
    : selBare
      ? { lotId: null, parcelId: selBare.parcelId, address: selBare.address, status: pending.get(`p:${selBare.parcelId}`) ?? null, grade: null, note: null, crewId: null, statusAt: null }
      : null;
  const selStop = selected?.kind === "stop" ? (openRequests.find((r) => r.id === selected.id) ?? null) : null;
  const close = (): void => setSelected(null);
  const openCount = openRequests.length;

  if (overview.isError && !d) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-4">
        <EmptyState title="Map not loaded" description="Check the connection" action={<Button onClick={() => void overview.refetch()}>Retry</Button>} />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-[420px] flex-col">
      <div className="z-[1100] flex flex-col gap-2 border-b border-line bg-surface px-3 py-2 nav:flex-row nav:items-center nav:px-5">
        <div className="grid grid-cols-2 gap-2 nav:flex nav:w-auto">
          <FilterSelect
            label="Company"
            value={company ?? ""}
            onChange={(e) => {
              setCompany(e.target.value ? Number(e.target.value) : null);
              setCrewFilter(null);
            }}
            className="nav:w-48"
          >
            <option value="">All companies</option>
            {(d?.companies ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </FilterSelect>
          <FilterSelect label="Crew" value={crewFilter ?? ""} onChange={(e) => setCrewFilter(e.target.value ? Number(e.target.value) : null)} className="nav:w-40">
            <option value="">All crews</option>
            {companyCrews.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </FilterSelect>
        </div>
        <div className="flex gap-2 overflow-x-auto">
          <ToggleChip on={showRequests} onChange={setShowRequests}>
            Requests
            {openCount > 0 && <span className="rounded-full bg-crew/20 px-1.5 text-xs tabular-nums ring-1 ring-inset ring-crew">{openCount}</span>}
          </ToggleChip>
          <ToggleChip on={showLots} onChange={setShowLots}>
            Lots
          </ToggleChip>
          <ToggleChip on={showTrucks} onChange={setShowTrucks}>
            Trucks
          </ToggleChip>
          {(plan.data?.areas.length ?? 0) > 0 && (
            <ToggleChip on={showAreas} onChange={setShowAreas}>
              Areas
            </ToggleChip>
          )}
          <ToggleChip on={showOsmAlleys} onChange={setShowOsmAlleys}>
            OSM alleys
          </ToggleChip>
        </div>
      </div>
      <div className={`relative min-h-0 flex-1 ${placing || drawing || painting || lotDrawing ? "[&_.leaflet-container]:cursor-crosshair" : ""}`}>
        <MapView
          markers={markers}
          fitKey={`${company ?? "all"}-${crewFilter ?? "all"}`}
          label="Command center map"
          className="absolute inset-0"
          onReady={setMap}
          onMapClick={
            placing
              ? (lat, lng) => {
                  setPin({ lat, lng });
                  setPlacing(false);
                }
              : undefined
          }
        />
        {!d && <div aria-hidden="true" className="absolute inset-0 z-[500] animate-pulse bg-surface-2/60" />}
        {placing && (
          <div className="pointer-events-none absolute inset-x-0 top-3 z-[1000] flex justify-center px-3">
            <div className="pointer-events-auto flex items-center gap-2 rounded-full bg-ink py-1 pr-1 pl-4 text-surface shadow-lg">
              <PinIcon />
              <span className="font-semibold">Drop pin</span>
              <button type="button" onClick={() => setPlacing(false)} className="min-h-10 rounded-full bg-surface px-4 text-sm font-semibold text-ink">
                Cancel
              </button>
            </div>
          </div>
        )}
        {(drawing || editing) && (
          <div className="pointer-events-none absolute inset-x-0 top-3 z-[1000] flex justify-center px-3">
            <div data-draw-bar className="pointer-events-auto flex items-center gap-2 rounded-full bg-ink py-1 pr-1 pl-4 text-surface shadow-lg">
              <DrawIcon />
              <span className="font-semibold">{drawing ? (tool.step ? STEP_LABEL[tool.step] : "Draw area") : `Edit corners, ${editArea?.label ?? ""}`}</span>
              <button
                type="button"
                onClick={() => {
                  setDrawing(false);
                  setEditAreaId(null);
                }}
                className="min-h-10 rounded-full bg-surface px-4 text-sm font-semibold text-ink"
              >
                {drawing ? "Cancel" : "Done"}
              </button>
            </div>
          </div>
        )}
        <DrawLotBar draw={drawLot} />
        {!placing && !drawing && !editing && !lotDrawing && <MapLegend className="absolute top-2.5 right-2.5 z-[900]" osmAlleys={showOsmAlleys} />}
        <div className="pointer-events-none absolute inset-x-0 bottom-[max(5.5rem,calc(env(safe-area-inset-bottom)+5rem))] z-[1000] flex justify-center px-3">{flash}</div>
        <PaintFrame paint={paint} />
        <PaintBar paint={paint} crews={crews} />
        {!placing && !drawing && !editing && !painting && !lotDrawing && (
          <div className="pointer-events-none absolute right-4 bottom-[max(2.25rem,env(safe-area-inset-bottom))] left-4 z-[1000] flex flex-wrap justify-end gap-2">
            {me && !follow && (
              <Button
                size="lg"
                variant="secondary"
                data-recenter
                className="pointer-events-auto shadow-lg"
                onClick={() => {
                  if (!map) return;
                  map.setView([me.lat, me.lng], Math.max(map.getZoom(), 17), { animate: true });
                  // setView fires zoomstart; turn following on after it settles.
                  window.setTimeout(() => setFollow(true), 400);
                }}
              >
                <RecenterIcon />
                Recenter
              </Button>
            )}
            <Button
              size="lg"
              variant="secondary"
              data-paint
              className="pointer-events-auto shadow-lg"
              onClick={() => {
                setSelected(null);
                paint.open();
              }}
              disabled={!d || !map}
            >
              <PaintIcon />
              Paint
            </Button>
            <Button
              size="lg"
              variant="secondary"
              data-draw-area
              className="pointer-events-auto shadow-lg"
              onClick={() => {
                setSelected(null);
                setDraft(null);
                setDrawing(true);
              }}
              disabled={!d || !map}
            >
              <DrawIcon />
              Draw area
            </Button>
            <Button
              size="lg"
              variant="secondary"
              data-draw-lot
              className="pointer-events-auto shadow-lg"
              onClick={() => {
                setSelected(null);
                drawLot.start();
              }}
              disabled={!d || !map}
            >
              <DrawLotIcon />
              Draw lot
            </Button>
            <Button size="lg" className="pointer-events-auto shadow-lg" onClick={() => setPlacing(true)} disabled={!d}>
              <PinIcon />
              Add stop
            </Button>
          </div>
        )}
      </div>
      <AddStopSheet pin={pin} crews={crews} onClose={() => setPin(null)} onSent={showFlash} />
      <CrewSheet
        crew={selCrew}
        requests={selCrew ? openRequests.filter((r) => r.crewId === selCrew.id).sort((a, b) => a.createdAt - b.createdAt) : []}
        trucks={trucks}
        now={now}
        onClose={close}
        onDone={showFlash}
      />
      <TruckSheet truck={selTruck} now={now} onClose={close} />
      <LotSheet
        parcel={sheetParcel}
        crews={crews}
        lots={lotWrites}
        onClose={close}
        onEditShape={(id) => {
          const lot = d?.lots.find((l) => l.id === id);
          if (!lot?.geometry) return;
          setSelected(null);
          drawLot.edit(id, lot.geometry);
        }}
      />
      <DrawLotSheet draw={drawLot} scope={{ kind: "green" }} crews={crews} onSaved={showFlash} />
      <AreaSheet
        area={selArea}
        companies={plan.data?.companies ?? []}
        onClose={close}
        onDone={showFlash}
        onEditCorners={(id) => {
          setSelected(null);
          setDraft(null);
          setEditAreaId(id);
        }}
      />
      <AssignAreaSheet
        open={draft !== null && !drawing}
        polygon={draftPolygon}
        todoInside={todoInside}
        companies={plan.data?.companies ?? []}
        buildable={plan.data?.buildable ?? []}
        onClose={() => setDraft(null)}
        onDone={showFlash}
      />
      <StopSheet request={selStop} trucks={trucks} now={now} onClose={close} onDone={showFlash} />
    </div>
  );
};
