import { useMemo, useState } from "react";
import { Link } from "wouter";
import { ButtonLink } from "../../components/Button.tsx";
import { isActive, lotTitle, qtyText, type CrewRequest } from "../../components/crew/format.ts";
import { DirectionsIcon, PlusIcon, TypeIcon } from "../../components/crew/Icons.tsx";
import { LotStatusControl, useLotStatus } from "../../components/crew/LotStatusControl.tsx";
import { etaText } from "../../components/crew/RequestCard.tsx";
import { useNow } from "../../components/crew/useNow.ts";
import { LotSheet } from "../../components/LotSheet.tsx";
import { lotPill, StatusPill } from "../../components/StatusPill.tsx";
import { distance, mapsDirections } from "../../lib/format.ts";
import { MapView, type MapMarker } from "../../lib/map/MapView.tsx";
import { useMyFix } from "../../lib/position.ts";
import { trpc } from "../../lib/trpc.ts";

const URGENT_AGE_MS = 10 * 60_000;
const ORDER: Record<CrewRequest["status"], number> = { en_route: 0, assigned: 1, open: 2, delivered: 3, cancelled: 4 };

/** What is on its way, over the top of the map. Tap for the full list. */
const ActiveStrip = ({ active, now }: { active: CrewRequest[]; now: number }) => {
  if (active.length === 0) return null;
  const shown = active.slice(0, 2);
  const more = active.length - shown.length;
  return (
    <Link
      href="/requests"
      aria-label="Requests"
      className="pointer-events-auto block rounded-2xl bg-surface/95 p-2 text-ink shadow-lg ring-1 ring-line backdrop-blur"
    >
      <ul className="space-y-1">
        {shown.map((r) => {
          const eta = etaText(r, now);
          return (
            <li key={r.id} className="flex min-h-11 items-center gap-2.5 px-1">
              <TypeIcon typeKey={r.typeKey} size={24} className="shrink-0" />
              <span className="min-w-0 flex-1">
                <span className="block truncate leading-tight font-semibold">
                  {r.typeLabel} <span className="font-normal text-muted">{qtyText(r.qty, r.unit)}</span>
                </span>
                {(r.truckName || eta) && (
                  <span className="block truncate text-sm leading-tight font-semibold text-muted tabular-nums">
                    {[r.truckName, eta].filter(Boolean).join(", ")}
                  </span>
                )}
              </span>
              <StatusPill status={r.status} className="shrink-0" />
            </li>
          );
        })}
      </ul>
      {more > 0 && <p className="px-1 pt-0.5 text-sm font-semibold text-muted">{`+${more} more`}</p>}
    </Link>
  );
};

export const MapPage = () => {
  const map = trpc.crew.map.useQuery(undefined, { refetchInterval: 30_000 });
  const mine = trpc.crew.myRequests.useQuery(undefined, { refetchInterval: 60_000 });
  const lotStatus = useLotStatus();
  const fix = useMyFix();
  const now = useNow();
  const [lotId, setLotId] = useState<number | null>(null);
  const lot = map.data?.lots.find((l) => l.id === lotId);

  const active = useMemo(
    () => (mine.data ?? []).filter(isActive).sort((a, b) => ORDER[a.status] - ORDER[b.status] || b.createdAt - a.createdAt),
    [mine.data],
  );
  const urgent = active.some((r) => r.status !== "en_route" && r.priority >= 3 && now - r.createdAt > URGENT_AGE_MS);

  const markers = useMemo<MapMarker[]>(() => {
    const d = map.data;
    if (!d) return [];
    const out: MapMarker[] = [];
    for (const l of d.lots) {
      out.push({ id: `lot-${l.id}`, kind: "lot", lat: l.lat, lng: l.lng, status: l.status, mine: l.mine, geometry: l.geometry, title: lotTitle(l), onClick: () => setLotId(l.id) });
    }
    for (const c of d.companyCrews) {
      if (c.position) out.push({ id: `crew-${c.id}`, kind: "crew", lat: c.position.lat, lng: c.position.lng, label: `Crew ${c.number}`, muted: true, noFit: true, title: `Crew ${c.number}` });
    }
    out.push({ id: "cc", kind: "cc", lat: d.cc.lat, lng: d.cc.lng, name: `CC ${d.cc.name}` });
    for (const t of d.trucks) {
      if (t.position) out.push({ id: `truck-${t.id}`, kind: "truck", lat: t.position.lat, lng: t.position.lng, name: t.name });
    }
    const me = fix ?? (d.me ? { lat: d.me.lat, lng: d.me.lng, accuracy: d.me.accuracy } : null);
    if (me && active.length > 0) out.push({ id: "ring", kind: "request", lat: me.lat, lng: me.lng, urgent, noFit: true });
    if (me) out.push({ id: "me", kind: "me", lat: me.lat, lng: me.lng, accuracy: me.accuracy });
    return out;
  }, [map.data, fix, active.length, urgent]);

  return (
    <div className="relative h-full min-h-[320px]">
      <MapView markers={markers} label="Crew map" className="absolute inset-0" />
      <div className="pointer-events-none absolute top-2.5 right-2.5 left-[3.25rem] z-[1000] nav:left-auto nav:w-96">
        <ActiveStrip active={active} now={now} />
      </div>
      <div className="pointer-events-none absolute right-4 bottom-[max(2.25rem,env(safe-area-inset-bottom))] z-[1000]">
        <ButtonLink href="/request" size="lg" className="pointer-events-auto min-h-16 px-7 text-xl shadow-lg">
          <PlusIcon size={24} />
          Request
        </ButtonLink>
      </div>
      <LotSheet
        lot={lot}
        onClose={() => setLotId(null)}
        status={
          lot && (
            <>
              <LotStatusControl status={lot.status} onChange={(s) => lotStatus.set(lot.id, s)} />
              {lotStatus.error && lotStatus.errorFor === lot.id && (
                <p role="alert" className="mt-2 text-sm font-semibold">
                  {lotStatus.error}
                </p>
              )}
            </>
          )
        }
        crew={
          lot && (
            <div className="flex flex-wrap items-center gap-2 text-sm text-muted">
              <StatusPill status={lotPill(lot.status)} />
              <span>{distance(lot.distanceM)}</span>
              <span>{lot.mine ? "Assigned" : "Nearby"}</span>
            </div>
          )
        }
      >
        {lot && (
          <ButtonLink href={mapsDirections(lot.lat, lot.lng)} variant="secondary" block>
            <DirectionsIcon size={20} />
            Directions
          </ButtonLink>
        )}
      </LotSheet>
    </div>
  );
};
