import { useMemo, useState } from "react";
import { ButtonLink, Button } from "../../components/Button.tsx";
import { Sheet } from "../../components/Sheet.tsx";
import { lotPill, StatusPill } from "../../components/StatusPill.tsx";
import { useMyFix } from "../../lib/position.ts";
import { MapView, type MapMarker } from "../../lib/map/MapView.tsx";
import { trpc, type RouterOutputs } from "../../lib/trpc.ts";

type CrewLot = RouterOutputs["crew"]["map"]["lots"][number];

const LOT_ACTIONS: Array<{ status: "done" | "in_progress" | "skipped"; label: string }> = [
  { status: "done", label: "Done" },
  { status: "in_progress", label: "In progress" },
  { status: "skipped", label: "Skip" },
];

export const MapPage = () => {
  const map = trpc.crew.map.useQuery(undefined, { refetchInterval: 30_000 });
  const utils = trpc.useUtils();
  const setStatus = trpc.crew.setLotStatus.useMutation({
    onSuccess: () => {
      void utils.crew.map.invalidate();
      void utils.crew.lots.invalidate();
    },
  });
  const fix = useMyFix();
  const [lotId, setLotId] = useState<number | null>(null);
  const lot: CrewLot | undefined = map.data?.lots.find((l) => l.id === lotId);

  const markers = useMemo<MapMarker[]>(() => {
    const d = map.data;
    if (!d) return [];
    const out: MapMarker[] = [];
    for (const l of d.lots) {
      out.push({ id: `lot-${l.id}`, kind: "lot", lat: l.lat, lng: l.lng, status: l.status, mine: l.mine, geometry: l.geometry, onClick: () => setLotId(l.id) });
    }
    for (const c of d.companyCrews) {
      if (c.position) out.push({ id: `crew-${c.id}`, kind: "crew", lat: c.position.lat, lng: c.position.lng, label: String(c.number), muted: true, noFit: true, title: `Crew ${c.number}` });
    }
    out.push({ id: "cc", kind: "cc", lat: d.cc.lat, lng: d.cc.lng, name: `CC ${d.cc.name}` });
    for (const t of d.trucks) {
      if (t.position) out.push({ id: `truck-${t.id}`, kind: "truck", lat: t.position.lat, lng: t.position.lng, name: t.name });
    }
    const me = fix ?? (d.me ? { lat: d.me.lat, lng: d.me.lng, accuracy: d.me.accuracy } : null);
    if (me) out.push({ id: "me", kind: "me", lat: me.lat, lng: me.lng, accuracy: me.accuracy });
    return out;
  }, [map.data, fix]);

  return (
    <div className="relative h-full min-h-[320px]">
      <MapView markers={markers} label="Crew map" className="absolute inset-0" />
      <div className="pointer-events-none absolute right-4 bottom-[max(2.25rem,env(safe-area-inset-bottom))] z-[1000]">
        <ButtonLink href="/request" size="lg" className="pointer-events-auto shadow-lg">
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
            <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
          </svg>
          Request
        </ButtonLink>
      </div>
      <Sheet open={!!lot} onClose={() => setLotId(null)} title={lot?.address ?? "Lot"}>
        {lot && (
          <div className="space-y-4">
            <StatusPill status={lotPill(lot.status)} />
            <div className="grid grid-cols-3 gap-2">
              {LOT_ACTIONS.map((a) => (
                <Button
                  key={a.status}
                  variant={lot.status === a.status ? "primary" : "secondary"}
                  aria-pressed={lot.status === a.status}
                  busy={setStatus.isPending && setStatus.variables?.status === a.status}
                  onClick={() => setStatus.mutate({ lotId: lot.id, status: a.status })}
                >
                  {a.label}
                </Button>
              ))}
            </div>
          </div>
        )}
      </Sheet>
    </div>
  );
};
