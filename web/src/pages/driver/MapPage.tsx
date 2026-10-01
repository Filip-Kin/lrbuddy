import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "wouter";
import { Button, ButtonLink } from "../../components/Button.tsx";
import { EmptyState } from "../../components/EmptyState.tsx";
import { Sheet } from "../../components/Sheet.tsx";
import { StatusPill } from "../../components/StatusPill.tsx";
import { CancelSheet } from "../../components/driver/CancelSheet.tsx";
import { DriverMap, type DriverMapStop } from "../../components/driver/DriverMap.tsx";
import { etaText, itemsSummary } from "../../components/driver/format.ts";
import { compass, manoeuvreAngle, manoeuvreLabel, nextManoeuvre, straightLine, type Manoeuvre } from "../../components/driver/guidance.ts";
import { useDistanceFrom, useDriverActions, useNewStopBuzz, useNow, useWakeLock, type DriverActions, type DriverQueue, type QueueStop } from "../../components/driver/hooks.ts";
import { ArrowIcon, FlagIcon, ListIcon, NavigateIcon, PhoneIcon, PinIcon, RecenterIcon, TruckIcon } from "../../components/driver/icons.tsx";
import { CcStopCard, ErrorLine, NewPill, StopDetails, StopRow, isNew, stopEta, useArmed } from "../../components/driver/StopCard.tsx";
import { distance, duration, telHref } from "../../lib/format.ts";
import { useMyFix } from "../../lib/position.ts";
import { trpc } from "../../lib/trpc.ts";
import { nextHeading } from "../plan/survey/drive.ts";
import type { LatLng } from "../plan/survey/geo.ts";

/** Straight-line fallback speed, the same 25 km/h the server uses without OSRM. */
const FALLBACK_MPS = 25_000 / 3600;

// #region heading
/** Heading from this phone's fixes, by the Survey drive mode rule (GPS heading when moving, else bearing between fixes). */
const useHeading = (): { at: LatLng | null; heading: number | null } => {
  const fix = useMyFix();
  const anchor = useRef<LatLng | null>(null);
  const [heading, setHeading] = useState<number | null>(null);
  const headingRef = useRef<number | null>(null);
  useEffect(() => {
    if (!fix) return;
    const h = nextHeading(fix, anchor.current, headingRef.current);
    anchor.current = h.anchor;
    headingRef.current = h.heading;
    setHeading(h.heading);
  }, [fix]);
  return { at: fix ? { lat: fix.lat, lng: fix.lng } : null, heading };
};
// #endregion

// #region next stop card
const Card = ({ children, label }: { children: ReactNode; label: string }) => (
  <section data-next-card aria-label={label} className="pointer-events-auto rounded-2xl bg-surface p-3 shadow-lg ring-2 ring-brand">
    {children}
  </section>
);

const NextCard = ({ stop, actions, now, onOpen }: { stop: QueueStop; actions: DriverActions; now: number; onOpen: () => void }) => {
  const distFrom = useDistanceFrom();
  const armed = useArmed(stop.key);
  const meters = distFrom(stop, stop.distanceM);
  const enRoute = stop.status === "en_route";
  const locked = !armed || actions.enRoute.isPending || actions.deliver.isPending;
  const busyEnRoute = actions.enRoute.isPending && actions.enRoute.variables?.stopKey === stop.key;
  const busyDeliver = actions.deliver.isPending && actions.deliver.variables?.stopKey === stop.key;
  const note = stop.items.map((i) => i.note).filter((x): x is string => !!x).join(" · ");
  const wide = enRoute ? 1 : 2;
  return (
    <Card label="Next stop">
      <button type="button" onClick={onOpen} className="flex w-full min-w-0 items-start gap-3 text-left" aria-label={`${stop.name}, stop details`}>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="truncate text-lg leading-tight font-extrabold">{stop.name}</span>
            {stop.urgent && <StatusPill status="urgent" />}
            {enRoute && <StatusPill status="en_route" />}
            {isNew(stop, now) && <NewPill />}
          </span>
          <span className="mt-0.5 block truncate text-sm text-muted">{[stop.companyName, itemsSummary(stop.items)].filter(Boolean).join(" · ")}</span>
          {note && <span className="mt-0.5 block truncate border-l-4 border-brand pl-2 text-sm">{note}</span>}
        </span>
        <span className="shrink-0 text-right tabular-nums">
          <span className="block text-lg leading-tight font-extrabold">{stopEta(stop, meters, now)}</span>
          <span className="block text-sm text-muted">{distance(meters)}</span>
        </span>
      </button>
      <div className="mt-2 grid gap-2" style={{ gridTemplateColumns: `repeat(${wide}, minmax(0, 1fr))${stop.leadPhone ? " auto" : ""}` }}>
        {!enRoute && (
          <Button block busy={busyEnRoute} disabled={locked} onClick={() => actions.enRoute.mutate({ stopKey: stop.key })}>
            En route
          </Button>
        )}
        <Button variant={enRoute ? "primary" : "secondary"} block busy={busyDeliver} disabled={locked} onClick={() => actions.deliver.mutate({ stopKey: stop.key })}>
          Delivered
        </Button>
        {stop.leadPhone && (
          <ButtonLink href={telHref(stop.leadPhone)} variant="secondary" className="px-3!" aria-label={stop.leadName ? `Call ${stop.leadName}` : "Call lead"}>
            <PhoneIcon size={20} />
            Call
          </ButtonLink>
        )}
      </div>
      <ErrorLine text={actions.error} />
    </Card>
  );
};

const CcCard = ({ q, actions, now }: { q: DriverQueue; actions: DriverActions; now: number }) => {
  const distFrom = useDistanceFrom();
  const meters = distFrom(q.cc, q.distanceToCcM);
  const eta = q.atCc ? "now" : (etaText(q.ccEtaAt, now) ?? duration((meters / FALLBACK_MPS) * 1000));
  return (
    <Card label="Command center">
      <div className="flex items-start gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-brand text-on-brand">
          <FlagIcon size={20} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="truncate text-lg leading-tight font-extrabold">CC {q.cc.name}</span>
            {q.returning && <StatusPill status="returning" />}
          </span>
          {q.cc.address && <span className="mt-0.5 block truncate text-sm text-muted">{q.cc.address}</span>}
        </span>
        <span className="shrink-0 text-right tabular-nums">
          <span className="block text-lg leading-tight font-extrabold">{eta}</span>
          <span className="block text-sm text-muted">{q.atCc ? "Here" : distance(meters)}</span>
        </span>
      </div>
      <div className={`mt-2 grid gap-2 ${q.returning ? "grid-cols-2" : "grid-cols-1"}`}>
        <Button block busy={actions.restocked.isPending} onClick={() => actions.restocked.mutate()}>
          Restocked
        </Button>
        {q.returning && (
          <Button variant="secondary" block busy={actions.setReturning.isPending} onClick={() => actions.setReturning.mutate({ returning: false })}>
            Cancel restock
          </Button>
        )}
      </div>
      <ErrorLine text={actions.error} />
    </Card>
  );
};
// #endregion

// #region guidance banner
interface Target extends LatLng {
  key: string;
  name: string;
  navigateUrl: string;
}

const GuidanceBanner = ({
  target,
  at,
  heading,
  line,
  steps,
}: {
  target: Target;
  at: LatLng;
  heading: number | null;
  line: ReadonlyArray<[number, number]>;
  steps: readonly Manoeuvre[];
}) => {
  const up = steps.length > 0 ? nextManoeuvre(line, steps, at) : null;
  let icon: ReactNode;
  let metres: number;
  let what: string;
  let where: string;
  if (up) {
    const angle = manoeuvreAngle(up.step);
    icon = angle === null ? <PinIcon size={30} /> : <ArrowIcon size={30} angle={angle} />;
    metres = up.distanceM;
    what = manoeuvreLabel(up.step);
    where = up.step.type === "arrive" ? target.name : up.step.name;
  } else {
    const s = straightLine(at, target, heading);
    icon = <ArrowIcon size={30} angle={s.angle} />;
    metres = s.distanceM;
    what = compass(s.bearing);
    where = target.name;
  }
  return (
    <div data-guidance className="pointer-events-auto flex items-center gap-3 rounded-2xl bg-ink py-1.5 pr-1.5 pl-3 text-surface shadow-lg">
      <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-brand text-on-brand" aria-hidden="true">
        {icon}
      </span>
      <span className="min-w-0 flex-1" aria-live="polite">
        <span className="block text-lg leading-tight font-extrabold tabular-nums">{distance(metres)}</span>
        <span className="block truncate text-sm font-semibold">{[what, where].filter(Boolean).join(" · ")}</span>
      </span>
      <ButtonLink href={target.navigateUrl} variant="primary" className="shrink-0 px-3!" aria-label={`Maps to ${target.name}`}>
        <NavigateIcon size={20} />
        Maps
      </ButtonLink>
    </div>
  );
};
// #endregion

// #region queue sheet
const queueSummary = (q: DriverQueue): string | null => {
  const n = q.stops.length;
  if (n === 0) return null;
  const parts = [n === 1 ? "1 stop" : `${n} stops`];
  if (q.route && q.route.distanceM > 0) parts.push(distance(q.route.distanceM), duration(q.route.durationS * 1000));
  return parts.join(" · ");
};

const QueueSheet = ({
  open,
  onClose,
  q,
  actions,
  now,
}: {
  open: boolean;
  onClose: () => void;
  q: DriverQueue;
  actions: DriverActions;
  now: number;
}) => {
  const summary = queueSummary(q);
  const showCc = q.returning || (q.atCc && q.belowCapacity);
  return (
    <Sheet open={open} onClose={onClose} title="Queue">
      <div className="space-y-3 pb-2">
        <div className="flex flex-wrap items-center gap-2">
          {summary && <span className="mr-auto text-sm font-semibold text-muted">{summary}</span>}
          {q.lowStock && (
            <Link href="/stock" className="inline-flex min-h-10 items-center" aria-label="Low stock, open Stock">
              <StatusPill status="low" />
            </Link>
          )}
          {q.returning ? (
            <StatusPill status="returning" />
          ) : (
            <Button variant={q.lowStock ? "primary" : "secondary"} busy={actions.setReturning.isPending} onClick={() => actions.setReturning.mutate({ returning: true })}>
              Restock
            </Button>
          )}
        </div>
        {q.stops.length === 0 && !showCc ? (
          <EmptyState icon={<TruckIcon size={40} />} title="No stops" />
        ) : (
          <ol className="space-y-2" aria-label="Stops in order">
            {q.stops.map((s, i) => (
              <li key={s.key}>
                <StopRow
                  stop={s}
                  n={i + 1}
                  now={now}
                  pills={i === 0 ? <StatusPill status="en_route" label={q.pinnedKey === s.key ? "Next, pinned" : "Next"} /> : undefined}
                  onOpen={() => {
                    if (i > 0) actions.pinNext.mutate({ stopKey: s.key });
                    onClose();
                  }}
                />
              </li>
            ))}
          </ol>
        )}
        {showCc && <CcStopCard q={q} actions={actions} now={now} next={q.stops.length === 0} />}
        <ErrorLine text={actions.error} />
      </div>
    </Sheet>
  );
};
// #endregion

/** Driver home (SPEC 17): the map following the truck, the next stop pinned on top, the queue a tap away. */
export const MapPage = () => {
  const now = useNow();
  const r = trpc.driver.route.useQuery(undefined, { refetchInterval: 30_000 });
  const q = r.data?.queue;
  useNewStopBuzz(q?.stops);
  useWakeLock(!!q && (q.stops.length > 0 || q.returning));
  const actions = useDriverActions();
  const { at: fixAt, heading } = useHeading();
  const [follow, setFollow] = useState(true);
  const [queueOpen, setQueueOpen] = useState(false);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [cancelKey, setCancelKey] = useState<string | null>(null);

  const stops = q?.stops ?? [];
  const next = stops[0] ?? null;
  const openIdx = stops.findIndex((s) => s.key === openKey);
  const open = openIdx >= 0 ? stops[openIdx]! : null;
  const cancelStop = stops.find((s) => s.key === cancelKey) ?? null;
  const at = fixAt ?? q?.origin ?? null;
  const showCc = !!q && !next && (q.returning || (q.atCc && q.belowCapacity));

  const mapStops = useMemo<DriverMapStop[]>(
    () => stops.map((s, i) => ({ key: s.key, lat: s.lat, lng: s.lng, n: i + 1, active: i === 0, name: s.name })),
    [stops],
  );
  const cc = useMemo(() => (q ? { lat: q.cc.lat, lng: q.cc.lng, name: `CC ${q.cc.name}`, letter: q.cc.letter } : null), [q]);
  const line = r.data?.geometry ?? [];

  const target: Target | null = next
    ? { key: next.key, lat: next.lat, lng: next.lng, name: next.name, navigateUrl: next.navigateUrl }
    : q?.returning
      ? { key: "cc", lat: q.cc.lat, lng: q.cc.lng, name: `CC ${q.cc.name}`, navigateUrl: q.ccNavigateUrl }
      : null;
  // Turn steps belong to the route's first leg; until the route catches up with a new next stop, the banner points straight at it.
  const leg = r.data?.legs[0];
  const steps = target && r.data?.engine === "osrm" && leg?.key === target.key ? leg.steps : [];

  return (
    <div className="relative h-full min-h-[320px]">
      <DriverMap
        at={at}
        heading={heading}
        line={line}
        stops={mapStops}
        cc={cc}
        follow={follow}
        onUnfollow={() => setFollow(false)}
        onStop={(key) => setOpenKey(key)}
      />

      <div className="pointer-events-none absolute inset-x-2 top-2 z-[1000] mx-auto max-w-lg space-y-2">
        {q &&
          (next ? (
            <NextCard stop={next} actions={actions} now={now} onOpen={() => setOpenKey(next.key)} />
          ) : showCc ? (
            <CcCard q={q} actions={actions} now={now} />
          ) : (
            <Card label="Next stop">
              <div className="flex min-h-11 items-center justify-center gap-2 text-base font-semibold text-muted">
                <TruckIcon size={20} />
                No stops
              </div>
            </Card>
          ))}
        {r.isError && !q && (
          <Card label="Next stop">
            <div className="flex items-center justify-between gap-3">
              <span className="text-base font-semibold">Queue not loaded</span>
              <Button variant="secondary" onClick={() => void r.refetch()}>
                Retry
              </Button>
            </div>
          </Card>
        )}
        {target && at && <GuidanceBanner target={target} at={at} heading={follow ? heading : null} line={line} steps={steps} />}
      </div>

      {!follow && (
        <div className="pointer-events-none absolute bottom-[max(2.25rem,env(safe-area-inset-bottom))] left-3 z-[1000]">
          <Button variant="secondary" size="lg" className="pointer-events-auto bg-surface! px-4 shadow-lg" onClick={() => setFollow(true)}>
            <RecenterIcon />
            Recenter
          </Button>
        </div>
      )}

      <div className="pointer-events-none absolute right-4 bottom-[max(2.25rem,env(safe-area-inset-bottom))] z-[1000]">
        <Button data-queue-button size="lg" className="pointer-events-auto min-h-16 min-w-16 px-6 text-xl shadow-lg" onClick={() => setQueueOpen(true)} aria-label={`Queue, ${stops.length} ${stops.length === 1 ? "stop" : "stops"}`}>
          <ListIcon size={24} />
          Queue
          {stops.length > 0 && <span className="grid h-7 min-w-7 place-items-center rounded-full bg-ink px-1.5 text-base font-extrabold text-surface tabular-nums">{stops.length}</span>}
        </Button>
      </div>

      <p className="pointer-events-none absolute bottom-0 left-0 z-[1000] rounded-tr-md bg-surface/80 px-1.5 py-0.5 text-[10px] text-muted">© OpenStreetMap contributors, © Esri</p>

      {q && <QueueSheet open={queueOpen} onClose={() => setQueueOpen(false)} q={q} actions={actions} now={now} />}

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
