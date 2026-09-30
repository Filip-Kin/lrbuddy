import { useMemo, useState, type ReactNode } from "react";
import { ButtonLink } from "../../components/Button.tsx";
import { Sheet } from "../../components/Sheet.tsx";
import { StatusPill } from "../../components/StatusPill.tsx";
import { CancelSheet } from "../../components/driver/CancelSheet.tsx";
import { itemsSummary } from "../../components/driver/format.ts";
import { useDriverActions, useNewStopBuzz, useNow, useWakeLock } from "../../components/driver/hooks.ts";
import { FlagIcon, NavigateIcon } from "../../components/driver/icons.tsx";
import { StopDetails } from "../../components/driver/StopCard.tsx";
import { MapView, type MapLine, type MapMarker } from "../../lib/map/MapView.tsx";
import { useMyFix } from "../../lib/position.ts";
import { trpc } from "../../lib/trpc.ts";

/** Floating card over the bottom of the map; clears the attribution line under it. */
const BottomCard = ({ children }: { children: ReactNode }) => (
  <div className="pointer-events-none absolute inset-x-3 bottom-[max(2rem,calc(env(safe-area-inset-bottom)+1.25rem))] z-[1000] flex justify-center">
    <div className="pointer-events-auto flex w-full max-w-lg items-center gap-3 rounded-2xl bg-surface p-3 shadow-lg ring-1 ring-line">{children}</div>
  </div>
);

export const MapPage = () => {
  useWakeLock();
  const now = useNow();
  const r = trpc.driver.route.useQuery(undefined, { refetchInterval: 30_000 });
  const q = r.data?.queue;
  useNewStopBuzz(q?.stops);
  const actions = useDriverActions();
  const fix = useMyFix();
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [cancelKey, setCancelKey] = useState<string | null>(null);

  const stops = q?.stops ?? [];
  const openIdx = stops.findIndex((s) => s.key === openKey);
  const open = openIdx >= 0 ? stops[openIdx]! : null;
  const cancelStop = stops.find((s) => s.key === cancelKey) ?? null;
  const next = stops[0] ?? null;

  const markers = useMemo<MapMarker[]>(() => {
    if (!q) return [];
    const out: MapMarker[] = [{ id: "cc", kind: "cc", lat: q.cc.lat, lng: q.cc.lng, name: `CC ${q.cc.name}` }];
    q.stops.forEach((s, i) => {
      out.push({ id: `stop-${s.key}`, kind: "stop", lat: s.lat, lng: s.lng, n: i + 1, active: i === 0, title: s.name, onClick: () => setOpenKey(s.key) });
    });
    const me = fix ?? q.origin;
    out.push({ id: "me", kind: "me", lat: me.lat, lng: me.lng, accuracy: fix?.accuracy ?? null });
    return out;
  }, [q, fix]);

  const lines = useMemo<MapLine[]>(() => (r.data && r.data.geometry.length > 1 ? [{ id: "route", points: r.data.geometry }] : []), [r.data]);
  const fitKey = q ? `${q.stops.map((s) => s.key).join(",")}|${q.returning ? "cc" : ""}` : undefined;

  return (
    <div className="relative h-full min-h-[320px]">
      <MapView markers={markers} lines={lines} fitKey={fitKey} label="Route map" className="absolute inset-0" />

      {q &&
        (next ? (
          <BottomCard>
            <button type="button" onClick={() => setOpenKey(next.key)} className="flex min-h-12 min-w-0 flex-1 items-center gap-3 text-left">
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-brand text-base font-extrabold text-on-brand ring-[3px] ring-on-brand ring-inset">1</span>
              <span className="min-w-0">
                <span className="block truncate text-base font-bold">{next.name}</span>
                <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                  {next.urgent && <StatusPill status="urgent" />}
                  <span className="text-sm break-words text-muted">{itemsSummary(next.items)}</span>
                </span>
              </span>
            </button>
            <ButtonLink href={next.navigateUrl} size="md" className="shrink-0">
              <NavigateIcon size={20} />
              Navigate
            </ButtonLink>
          </BottomCard>
        ) : q.returning ? (
          <BottomCard>
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-brand text-on-brand">
              <FlagIcon size={20} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-base font-bold">CC {q.cc.name}</span>
              <span className="block truncate text-sm text-muted">{q.cc.address ?? "Restock"}</span>
            </span>
            <ButtonLink href={q.ccNavigateUrl} size="md" className="shrink-0">
              <NavigateIcon size={20} />
              Navigate
            </ButtonLink>
          </BottomCard>
        ) : (
          <BottomCard>
            <span className="flex min-h-10 flex-1 items-center justify-center text-base font-semibold text-muted">No stops</span>
          </BottomCard>
        ))}

      <Sheet open={!!open} onClose={() => setOpenKey(null)} title={open ? `Stop ${openIdx + 1}` : "Stop"}>
        {open && (
          <div className="pb-2">
            <StopDetails
              stop={open}
              n={0}
              heading=""
              actions={actions}
              now={now}
              onCancel={() => {
                setOpenKey(null);
                setCancelKey(open.key);
              }}
            />
          </div>
        )}
      </Sheet>
      <CancelSheet stop={cancelStop} actions={actions} onClose={() => setCancelKey(null)} />
    </div>
  );
};
