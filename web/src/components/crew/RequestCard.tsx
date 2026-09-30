import type { ReactNode } from "react";
import { StatusPill } from "../StatusPill.tsx";
import { ago, duration } from "../../lib/format.ts";
import { qtyText, since, type CrewRequest } from "./format.ts";
import { TruckIcon, TypeIcon } from "./Icons.tsx";

/** "ETA 6 min", "Due now"; null when the truck's route has no time for this stop. */
export const etaText = (r: Pick<CrewRequest, "etaAt" | "status">, now: number): string | null => {
  if (r.etaAt === null || (r.status !== "assigned" && r.status !== "en_route")) return null;
  const left = r.etaAt - now;
  return left < 60_000 ? "Due now" : `ETA ${duration(left)}`;
};

/** When the request reached the state its pill shows. */
const stateTime = (r: CrewRequest, now: number): string => {
  switch (r.status) {
    case "delivered":
      return `Delivered ${since(r.deliveredAt ?? r.createdAt, now)}`;
    case "cancelled":
      return `Cancelled ${since(r.cancelledAt ?? r.createdAt, now)}`;
    default:
      return now - r.createdAt < 60_000 ? "Just sent" : `Sent ${ago(r.createdAt, now)}`;
  }
};

const cancelledBy = (r: CrewRequest): string | null => {
  if (r.status !== "cancelled") return null;
  if (r.cancelledBy === "driver") return r.cancelNote ? `Truck: ${r.cancelNote}` : "Cancelled by truck";
  if (r.cancelledBy === "green") return "Cancelled by command center";
  return null;
};

export const TypeBadge = ({ typeKey, muted }: { typeKey: string; muted?: boolean }) => (
  <span
    className={`grid h-12 w-12 shrink-0 place-items-center rounded-2xl ${muted ? "bg-surface-2 text-muted" : "bg-brand text-on-brand"}`}
  >
    <TypeIcon typeKey={typeKey} size={26} />
  </span>
);

/** One request: item, quantity, status, truck and ETA, plus an action slot. */
export const RequestCard = ({ r, now, action }: { r: CrewRequest; now: number; action?: ReactNode }) => {
  const done = r.status === "delivered" || r.status === "cancelled";
  const eta = etaText(r, now);
  const by = cancelledBy(r);
  return (
    <article className="rounded-2xl bg-surface p-3 ring-1 ring-line">
      <div className="flex items-start gap-3">
        <TypeBadge typeKey={r.typeKey} muted={done} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <h3 className="text-lg leading-tight font-bold break-words">{r.typeLabel}</h3>
            <span className="text-base font-semibold text-muted tabular-nums">{qtyText(r.qty, r.unit)}</span>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted">
            <StatusPill status={r.status} />
            <span>{stateTime(r, now)}</span>
          </div>
          {(r.truckName || eta) && !done && (
            <div className="mt-1.5 flex flex-wrap items-center gap-x-2 text-sm font-semibold">
              {r.truckName && (
                <span className="inline-flex items-center gap-1">
                  <TruckIcon size={18} />
                  {r.truckName}
                </span>
              )}
              {eta && <span className="tabular-nums">{eta}</span>}
            </div>
          )}
          {r.status === "open" && <p className="mt-1.5 text-sm font-semibold">Waiting for truck</p>}
          {r.note && <p className="mt-1.5 text-sm break-words text-ink/80">{r.note}</p>}
          {by && <p className="mt-1.5 text-sm break-words text-muted">{by}</p>}
        </div>
      </div>
      {action && <div className="mt-3">{action}</div>}
    </article>
  );
};
