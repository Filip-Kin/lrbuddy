import { useEffect, useState, type ReactNode } from "react";
import { Button, ButtonLink } from "../Button.tsx";
import { StatusPill } from "../StatusPill.tsx";
import { distance, duration, telHref } from "../../lib/format.ts";
import { etaText, itemsSummary, qtyWithUnit } from "./format.ts";
import { NEW_STOP_MS, useDistanceFrom, type DriverActions, type DriverQueue, type QueueStop } from "./hooks.ts";
import { ChevronIcon, FlagIcon, NavigateIcon, PhoneIcon } from "./icons.tsx";

/** Straight-line fallback speed, the same 25 km/h the server uses without OSRM. */
const FALLBACK_MPS = 25_000 / 3600;

// #region small parts
export const NewPill = () => (
  <span className="inline-flex items-center whitespace-nowrap rounded-full bg-ink px-2.5 py-0.5 text-xs font-bold text-surface">New</span>
);

const Stat = ({ label, value }: { label: string; value: string }) => (
  <div className="min-w-0 rounded-2xl bg-surface-2 px-3 py-2">
    <div className="truncate text-xl font-bold tabular-nums leading-tight">{value}</div>
    <div className="text-xs font-semibold text-muted">{label}</div>
  </div>
);

export const isNew = (s: QueueStop, now: number): boolean => s.assignedAt !== null && now - s.assignedAt < NEW_STOP_MS;

const stopPills = (s: QueueStop, now: number): ReactNode => (
  <>
    <StatusPill status={s.status} />
    {s.urgent && <StatusPill status="urgent" />}
    {isNew(s, now) && <NewPill />}
  </>
);

/** ETA from the route, else straight line at 25 km/h so the card never shows a gap. */
const stopEta = (s: QueueStop, meters: number, now: number): string => etaText(s.etaAt, now) ?? duration((meters / FALLBACK_MPS) * 1000);

export const ErrorLine = ({ text }: { text: string | null }) =>
  text ? (
    <p role="alert" className="text-sm font-semibold before:mr-1.5 before:inline-block before:h-2 before:w-2 before:rounded-full before:bg-crew before:content-['']">
      {text}
    </p>
  ) : null;

/** Keeps a freshly shown card from taking the second tap meant for the card before it. */
const useArmed = (key: string, ms = 800): boolean => {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    setArmed(false);
    const t = window.setTimeout(() => setArmed(true), ms);
    return () => window.clearTimeout(t);
  }, [key, ms]);
  return armed;
};
// #endregion

// #region stop details
/**
 * Everything about one stop plus its actions. The top of the queue shows it
 * as the next stop card; the map and later rows open it in a sheet.
 */
export const StopDetails = ({
  stop,
  n,
  heading,
  actions,
  now,
  onCancel,
}: {
  stop: QueueStop;
  n: number;
  heading: string;
  actions: DriverActions;
  now: number;
  onCancel: () => void;
}) => {
  const distFrom = useDistanceFrom();
  const armed = useArmed(stop.key);
  const meters = distFrom(stop, stop.distanceM);
  const busyEnRoute = actions.enRoute.isPending && actions.enRoute.variables?.stopKey === stop.key;
  const busyDeliver = actions.deliver.isPending && actions.deliver.variables?.stopKey === stop.key;
  const locked = !armed || actions.enRoute.isPending || actions.deliver.isPending;
  const notes = stop.items.map((i) => i.note).filter((x): x is string => !!x);
  const enRoute = stop.status === "en_route";

  return (
    <div className="space-y-4">
      <div>
        <div className="mb-1 flex flex-wrap items-center gap-2">
          {heading && <span className="text-sm font-bold text-muted">{n > 0 ? `${heading} ${n}` : heading}</span>}
          {stopPills(stop, now)}
        </div>
        <h2 className="text-2xl leading-tight font-extrabold break-words">{stop.name}</h2>
        {(stop.companyName || stop.nearAddress) && (
          <p className="mt-0.5 break-words text-base text-muted">
            {[stop.companyName, stop.nearAddress ? `Near ${stop.nearAddress}` : null].filter(Boolean).join(" · ")}
          </p>
        )}
      </div>

      <div className="grid grid-cols-3 gap-2">
        <Stat label="Distance" value={distance(meters)} />
        <Stat label="ETA" value={stopEta(stop, meters, now)} />
        <Stat label="Waiting" value={duration(now - stop.waitingSince)} />
      </div>

      <ul className="divide-y divide-line rounded-2xl ring-1 ring-line ring-inset">
        {stop.items.map((i) => (
          <li key={i.id} className="flex items-baseline justify-between gap-3 px-4 py-3">
            <span className="min-w-0 text-lg font-semibold break-words">{i.typeLabel}</span>
            <span className="shrink-0 text-lg font-extrabold tabular-nums">{qtyWithUnit(i.qty, i.unit)}</span>
          </li>
        ))}
      </ul>

      {notes.length > 0 && (
        <div className="rounded-2xl border-l-4 border-brand bg-surface-2 px-4 py-3">
          <div className="text-xs font-bold text-muted">Note</div>
          {notes.map((t, i) => (
            <p key={i} className="text-base break-words">
              {t}
            </p>
          ))}
        </div>
      )}

      <div className="space-y-2">
        <div className={`grid gap-2 ${stop.leadPhone ? "grid-cols-2" : "grid-cols-1"}`}>
          <ButtonLink href={stop.navigateUrl} variant="secondary" size="lg" block className="px-3!">
            <NavigateIcon />
            Navigate
          </ButtonLink>
          {stop.leadPhone && (
            <ButtonLink href={telHref(stop.leadPhone)} variant="secondary" size="lg" block className="min-w-0 px-3! whitespace-nowrap">
              <PhoneIcon />
              <span className="truncate text-base">{stop.leadName ? `Call ${stop.leadName.split(" ")[0]}` : "Call lead"}</span>
            </ButtonLink>
          )}
        </div>
        {enRoute ? (
          <Button size="lg" block busy={busyDeliver} disabled={locked} onClick={() => actions.deliver.mutate({ stopKey: stop.key })}>
            Delivered
          </Button>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            <Button size="lg" block busy={busyEnRoute} disabled={locked} onClick={() => actions.enRoute.mutate({ stopKey: stop.key })}>
              En route
            </Button>
            <Button variant="secondary" size="lg" block busy={busyDeliver} disabled={locked} onClick={() => actions.deliver.mutate({ stopKey: stop.key })}>
              Delivered
            </Button>
          </div>
        )}
        <ErrorLine text={actions.error} />
        {enRoute && (
          <div className="flex justify-end">
            <Button variant="ghost" size="sm" onClick={onCancel}>
              Cancel stop
            </Button>
          </div>
        )}
      </div>
    </div>
  );
};

/** The top of the queue: the next stop, framed in yellow. */
export const NextStopCard = (props: Parameters<typeof StopDetails>[0]) => (
  <section aria-label="Next stop" className="rounded-3xl bg-surface p-4 shadow-sm ring-2 ring-brand">
    <StopDetails {...props} />
  </section>
);
// #endregion

// #region later stops
export const StopRow = ({ stop, n, now, onOpen }: { stop: QueueStop; n: number; now: number; onOpen: () => void }) => {
  const distFrom = useDistanceFrom();
  const meters = distFrom(stop, stop.distanceM);
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-center gap-3 rounded-2xl bg-surface px-3 py-3 text-left ring-1 ring-line ring-inset active:bg-surface-2"
    >
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full border-[3px] border-ink text-base font-extrabold tabular-nums">{n}</span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="line-clamp-2 text-base font-bold break-words">{stop.name}</span>
          {stop.urgent && <StatusPill status="urgent" />}
          {isNew(stop, now) && <NewPill />}
        </span>
        <span className="block truncate text-sm text-muted">{[stop.companyName, itemsSummary(stop.items)].filter(Boolean).join(" · ")}</span>
      </span>
      <span className="shrink-0 text-right">
        <span className="block text-base font-bold tabular-nums">{stopEta(stop, meters, now)}</span>
        <span className="block text-xs text-muted tabular-nums">{distance(meters)}</span>
      </span>
      <span className="shrink-0 text-muted">
        <ChevronIcon />
      </span>
    </button>
  );
};
// #endregion

// #region command center stop
/** The CC as a stop: pinned last while restocking, or shown when the truck is parked there. */
export const CcStopCard = ({ q, actions, now, next }: { q: DriverQueue; actions: DriverActions; now: number; next: boolean }) => {
  const distFrom = useDistanceFrom();
  const meters = distFrom(q.cc, q.distanceToCcM);
  const eta = etaText(q.ccEtaAt, now) ?? duration((meters / FALLBACK_MPS) * 1000);
  return (
    <section aria-label="Command center" className={`space-y-4 rounded-3xl bg-surface p-4 shadow-sm ${next ? "ring-2 ring-brand" : "ring-1 ring-line"}`}>
      <div>
        <div className="mb-1 flex flex-wrap items-center gap-2">
          <span className="text-sm font-bold text-muted">{q.returning ? "Restock" : "Command center"}</span>
          {q.returning && <StatusPill status="returning" />}
          {q.lowStock && <StatusPill status="low" />}
        </div>
        <h2 className="flex items-center gap-2 text-2xl leading-tight font-extrabold">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-brand text-on-brand">
            <FlagIcon size={20} />
          </span>
          <span className="min-w-0 break-words">CC {q.cc.name}</span>
        </h2>
        {q.cc.address && <p className="mt-0.5 break-words text-base text-muted">{q.cc.address}</p>}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Stat label="Distance" value={q.atCc ? "Here" : distance(meters)} />
        <Stat label="ETA" value={q.atCc ? "now" : eta} />
      </div>
      {q.low.length > 0 && (
        <ul className="flex flex-wrap gap-2" aria-label="Low stock">
          {q.low.map((l) => (
            <li key={l.typeId}>
              <StatusPill status="low" label={`${l.label} ${l.qty} / ${l.capacity}`} />
            </li>
          ))}
        </ul>
      )}
      <div className="grid grid-cols-2 gap-2">
        <ButtonLink href={q.ccNavigateUrl} variant="secondary" size="lg" block>
          <NavigateIcon />
          Navigate
        </ButtonLink>
        <Button size="lg" block busy={actions.restocked.isPending} onClick={() => actions.restocked.mutate()}>
          Restocked
        </Button>
      </div>
      {q.returning && (
        <div className="flex justify-end">
          <Button variant="ghost" size="sm" busy={actions.setReturning.isPending} onClick={() => actions.setReturning.mutate({ returning: false })}>
            Cancel restock
          </Button>
        </div>
      )}
    </section>
  );
};
// #endregion
