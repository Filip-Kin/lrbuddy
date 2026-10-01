import { useMemo, useState } from "react";
import { Button } from "../../components/Button.tsx";
import { EmptyState } from "../../components/EmptyState.tsx";
import { AddStopSheet } from "../../components/green/AddStopSheet.tsx";
import { isUrgent, useNow, type GreenRequest } from "../../components/green/hooks.ts";
import { CrewSheet, LotSheet, StopSheet, TruckSheet } from "../../components/green/MapSheets.tsx";
import { FilterSelect, PinIcon, useFlash } from "../../components/green/ui.tsx";
import { ToggleChip } from "../../components/Segmented.tsx";
import { MapView, type MapMarker } from "../../lib/map/MapView.tsx";
import { trpc } from "../../lib/trpc.ts";

type Selected = { kind: "crew" | "truck" | "lot" | "stop"; id: number } | null;

export const MapPage = () => {
  const now = useNow();
  const overview = trpc.green.overview.useQuery(undefined, { refetchInterval: 30_000 });
  const [company, setCompany] = useState<number | null>(null);
  const [crewFilter, setCrewFilter] = useState<number | null>(null);
  const [showRequests, setShowRequests] = useState(true);
  const [showLots, setShowLots] = useState(true);
  const [showTrucks, setShowTrucks] = useState(true);
  const [selected, setSelected] = useState<Selected>(null);
  const [placing, setPlacing] = useState(false);
  const [pin, setPin] = useState<{ lat: number; lng: number } | null>(null);
  const [flash, showFlash] = useFlash();

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
        out.push({ id: `lot-${l.id}`, kind: "lot", lat: l.lat, lng: l.lng, status: l.status, geometry: l.geometry, mine: l.crewId !== null, noFit: true, title: l.address ?? undefined, onClick: () => setSelected({ kind: "lot", id: l.id }) });
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
    return out;
  }, [d, openRequests, visibleCrewIds, showLots, showRequests, showTrucks, pin, now]);

  const companyCrews = company === null ? crews : crews.filter((c) => c.companyId === company);
  const selCrew = selected?.kind === "crew" ? (crews.find((c) => c.id === selected.id) ?? null) : null;
  const selTruck = selected?.kind === "truck" ? (trucks.find((t) => t.id === selected.id) ?? null) : null;
  const selLot = selected?.kind === "lot" ? (d?.lots.find((l) => l.id === selected.id) ?? null) : null;
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
        </div>
      </div>
      <div className={`relative min-h-0 flex-1 ${placing ? "[&_.leaflet-container]:cursor-crosshair" : ""}`}>
        <MapView
          markers={markers}
          fitKey={`${company ?? "all"}-${crewFilter ?? "all"}`}
          label="Command center map"
          className="absolute inset-0"
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
        <div className="pointer-events-none absolute inset-x-0 bottom-[max(5.5rem,calc(env(safe-area-inset-bottom)+5rem))] z-[1000] flex justify-center px-3">{flash}</div>
        {!placing && (
          <div className="pointer-events-none absolute right-4 bottom-[max(2.25rem,env(safe-area-inset-bottom))] z-[1000]">
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
      <LotSheet lot={selLot} crews={crews} onClose={close} />
      <StopSheet request={selStop} trucks={trucks} now={now} onClose={close} onDone={showFlash} />
    </div>
  );
};
