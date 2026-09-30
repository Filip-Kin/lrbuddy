import { useState } from "react";
import { Button } from "../Button.tsx";
import { Sheet } from "../Sheet.tsx";
import { StatusPill } from "../StatusPill.tsx";
import { ago, clock, duration } from "../../lib/format.ts";
import { errorText, isUrgent, itemLine, requestWho, useNow, useRequestActions, type GreenRequest, type GreenTruck } from "./hooks.ts";
import { TruckStatusPill } from "./TruckStatus.tsx";
import { TruckIcon } from "./ui.tsx";

const OPEN = new Set<GreenRequest["status"]>(["open", "assigned", "en_route"]);

/** Truck picker for Assign. The request's current truck is marked and disabled. */
export const AssignSheet = ({
  request,
  trucks,
  open,
  onClose,
  onAssigned,
}: {
  request: GreenRequest;
  trucks: readonly GreenTruck[];
  open: boolean;
  onClose: () => void;
  onAssigned?: (truckName: string) => void;
}) => {
  const { assign } = useRequestActions();
  const [err, setErr] = useState<string | null>(null);
  const now = useNow();
  return (
    <Sheet open={open} onClose={onClose} title={`Assign ${itemLine(request)}`}>
      <div className="space-y-2 pb-2">
        {trucks.length === 0 && <p className="py-6 text-center font-semibold text-muted">No trucks at this CC</p>}
        {trucks.map((t) => {
          const current = request.truckId === t.id && request.status !== "open";
          const busy = assign.isPending && assign.variables?.truckId === t.id;
          return (
            <button
              key={t.id}
              type="button"
              disabled={current || assign.isPending}
              onClick={() => {
                setErr(null);
                assign.mutate(
                  { requestId: request.id, truckId: t.id },
                  {
                    onSuccess: () => {
                      onAssigned?.(t.name);
                      onClose();
                    },
                    onError: (e) => setErr(errorText(e)),
                  },
                );
              }}
              aria-busy={busy || undefined}
              className="flex min-h-16 w-full items-center gap-3 rounded-2xl bg-surface-2 px-4 py-3 text-left ring-1 ring-inset ring-line hover:brightness-95 disabled:opacity-60"
            >
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand text-on-brand">
                <TruckIcon />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-base font-bold">{t.name}</span>
                <span className="block truncate text-sm text-muted">
                  {[t.driverName, t.stopsLeft === 1 ? "1 stop" : `${t.stopsLeft} stops`].filter(Boolean).join(", ")}
                </span>
              </span>
              <span className="flex shrink-0 flex-col items-end gap-1">
                {current ? <StatusPill status="assigned" label="Current" /> : <TruckStatusPill truck={t} now={now} />}
                {t.lowStock && <StatusPill status="low" />}
              </span>
            </button>
          );
        })}
        {err && (
          <p role="alert" className="pt-1 text-sm font-semibold">
            {err}
          </p>
        )}
      </div>
    </Sheet>
  );
};

/** Confirmation for Cancel: the crew is waiting on this, so it takes a second tap. */
export const CancelSheet = ({ request, open, onClose }: { request: GreenRequest; open: boolean; onClose: () => void }) => {
  const { cancel } = useRequestActions();
  const [err, setErr] = useState<string | null>(null);
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Cancel request"
      footer={
        <div className="grid grid-cols-2 gap-2">
          <Button variant="secondary" size="lg" onClick={onClose}>
            Keep
          </Button>
          <Button
            variant="danger"
            size="lg"
            busy={cancel.isPending}
            onClick={() =>
              cancel.mutate(
                { requestId: request.id },
                { onSuccess: onClose, onError: (e) => setErr(errorText(e)) },
              )
            }
          >
            Cancel request
          </Button>
        </div>
      }
    >
      <div className="space-y-1 pb-2">
        <p className="text-xl font-bold">{itemLine(request)}</p>
        <p className="text-muted">{[requestWho(request), request.companyName, request.truckName].filter(Boolean).join(", ")}</p>
        {err && (
          <p role="alert" className="pt-2 text-sm font-semibold">
            {err}
          </p>
        )}
      </div>
    </Sheet>
  );
};

/** Board card: who, what, age, truck, and the three green actions while it is still open. */
export const RequestCard = ({
  request: r,
  trucks,
  now,
  onDone,
}: {
  request: GreenRequest;
  trucks: readonly GreenTruck[];
  now: number;
  /** Status line for the page after an action. */
  onDone?: (msg: string) => void;
}) => {
  const { deliver } = useRequestActions();
  const [assigning, setAssigning] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const live = OPEN.has(r.status);
  const urgent = isUrgent(r, now);
  const closedAt = r.deliveredAt ?? r.cancelledAt;

  return (
    <article className={`rounded-2xl bg-surface p-4 ring-1 ${urgent ? "ring-2 ring-crew" : "ring-line"}`}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1">
          {urgent && <StatusPill status="urgent" />}
          <StatusPill status={r.status} />
        </div>
        <span className="shrink-0 text-sm font-semibold text-muted tabular-nums">{live || closedAt === null ? duration(now - r.createdAt) : ago(closedAt, now)}</span>
      </div>
      <h3 className="mt-2 text-base font-bold break-words">
        {requestWho(r)}
        {r.companyName && <span className="font-semibold text-muted">, {r.companyName}</span>}
      </h3>
      {r.crewName && r.label && <p className="text-sm break-words text-muted">{r.label}</p>}
      <p className="mt-1 text-xl font-extrabold tracking-tight">{itemLine(r)}</p>
      {r.note && <p className="mt-1 text-sm break-words text-ink/80">{r.note}</p>}
      <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm">
        {(r.truckName !== null || live) && (
          <div className="flex items-center gap-1">
            <dt className="text-muted">
              <TruckIcon />
              <span className="sr-only">Truck</span>
            </dt>
            <dd className="font-semibold">{r.truckName ?? "No truck"}</dd>
          </div>
        )}
        {live && r.etaAt !== null && (
          <div className="flex gap-1">
            <dt className="text-muted">ETA</dt>
            <dd className="font-semibold tabular-nums">{r.etaAt <= now ? "now" : duration(r.etaAt - now)}</dd>
          </div>
        )}
        {!live && closedAt !== null && (
          <div className="flex gap-1">
            <dt className="text-muted">{r.status === "delivered" ? "Delivered" : "Cancelled"}</dt>
            <dd className="font-semibold tabular-nums">{clock(closedAt)}</dd>
          </div>
        )}
        {r.status === "cancelled" && r.cancelledBy && (
          <div className="flex gap-1">
            <dt className="text-muted">By</dt>
            <dd className="font-semibold">{r.cancelledBy === "green" ? "CC" : r.cancelledBy === "driver" ? "Driver" : "Crew"}</dd>
          </div>
        )}
      </dl>
      {r.cancelNote && <p className="mt-1 text-sm break-words text-muted">{r.cancelNote}</p>}
      {live && (
        <div className="mt-3 flex flex-wrap gap-2 [&>button]:min-w-fit [&>button]:flex-1">
          <Button variant="secondary" className="px-2!" onClick={() => setAssigning(true)}>
            Assign
          </Button>
          <Button
            variant="secondary"
            className="px-2!"
            busy={deliver.isPending}
            onClick={() => {
              setErr(null);
              deliver.mutate(
                { requestId: r.id },
                { onSuccess: () => onDone?.(`Delivered, ${itemLine(r)}`), onError: (e) => setErr(errorText(e)) },
              );
            }}
          >
            Delivered
          </Button>
          <Button variant="danger" className="px-2!" onClick={() => setCancelling(true)}>
            Cancel
          </Button>
        </div>
      )}
      {err && (
        <p role="alert" className="mt-2 text-sm font-semibold">
          {err}
        </p>
      )}
      {live && (
        <>
          <AssignSheet request={r} trucks={trucks} open={assigning} onClose={() => setAssigning(false)} onAssigned={(n) => onDone?.(`${n}, ${itemLine(r)}`)} />
          <CancelSheet request={r} open={cancelling} onClose={() => setCancelling(false)} />
        </>
      )}
    </article>
  );
};
