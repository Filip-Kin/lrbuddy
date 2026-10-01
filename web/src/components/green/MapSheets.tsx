import { useEffect, useState } from "react";
import { Button } from "../Button.tsx";
import { ConfirmSheet } from "../ConfirmSheet.tsx";
import { Select } from "../Field.tsx";
import { ParcelSheet, type ParcelView } from "../ParcelSheet.tsx";
import type { useSetLot } from "../LotStatusControl.tsx";
import { Sheet } from "../Sheet.tsx";
import { lotPill, StatusPill } from "../StatusPill.tsx";
import { ago, dateTime } from "../../lib/format.ts";
import { trpc, type RouterOutputs } from "../../lib/trpc.ts";
import { ContactButtons } from "./Contact.tsx";
import { errorText, useGreenInvalidate, type GreenRequest, type GreenTruck } from "./hooks.ts";
import { RequestCard } from "./RequestCard.tsx";
import { StockList } from "./StockList.tsx";
import { TruckStatusPill } from "./TruckStatus.tsx";
import { Fact } from "./ui.tsx";

type Overview = RouterOutputs["green"]["overview"];
type OverviewCrew = Overview["crews"][number];
type OverviewLot = Overview["lots"][number];

/** Seen in the last 30 minutes counts as active, the same window Stats uses. */
export const ACTIVE_MS = 30 * 60_000;

export const CrewSheet = ({
  crew,
  requests,
  trucks,
  now,
  onClose,
  onDone,
}: {
  crew: OverviewCrew | null;
  requests: readonly GreenRequest[];
  trucks: readonly GreenTruck[];
  now: number;
  onClose: () => void;
  onDone: (msg: string) => void;
}) => (
  <Sheet open={crew !== null} onClose={onClose} title={crew ? (crew.companyName ? `${crew.name}, ${crew.companyName}` : crew.name) : "Crew"}>
    {crew && (
      <div className="space-y-4 pb-2">
        <div className="grid grid-cols-2 gap-3 rounded-2xl bg-surface-2 p-3 sm:grid-cols-4">
          <Fact label="Lead">{crew.leadName ?? "None"}</Fact>
          <Fact label="Headcount">{crew.headcount ?? "None"}</Fact>
          <Fact label="Lots done">{crew.lotsDone}</Fact>
          <Fact label="Last seen">{ago(crew.lastSeenAt, now)}</Fact>
        </div>
        <ContactButtons phone={crew.leadPhone} who={crew.leadName ?? crew.name} />
        {crew.notes && <p className="text-sm break-words text-muted">{crew.notes}</p>}
        <section aria-label="Open requests" className="space-y-3">
          <h3 className="text-sm font-bold text-muted uppercase">Open requests</h3>
          {requests.length === 0 ? (
            <p className="rounded-2xl border-2 border-dashed border-line px-4 py-6 text-center font-semibold text-muted">No open requests</p>
          ) : (
            requests.map((r) => <RequestCard key={r.id} request={r} trucks={trucks} now={now} onDone={onDone} />)
          )}
        </section>
      </div>
    )}
  </Sheet>
);

export const TruckSheet = ({ truck, now, onClose }: { truck: GreenTruck | null; now: number; onClose: () => void }) => (
  <Sheet open={truck !== null} onClose={onClose} title={truck?.name ?? "Truck"}>
    {truck && (
      <div className="space-y-4 pb-2">
        <div className="flex flex-wrap gap-1.5">
          <TruckStatusPill truck={truck} now={now} />
          {truck.lowStock && <StatusPill status="low" />}
        </div>
        <div className="grid grid-cols-2 gap-3 rounded-2xl bg-surface-2 p-3">
          <div className="col-span-2">
            <Fact label="Driver">{truck.driverName ?? "None"}</Fact>
          </div>
          <Fact label="Stops left">{truck.stopsLeft}</Fact>
          <Fact label="Last seen">{ago(truck.lastSeenAt, now)}</Fact>
        </div>
        <ContactButtons phone={truck.driverPhone} who={truck.driverName ?? truck.name} />
        <section aria-label="Stock" className="space-y-2">
          <h3 className="text-sm font-bold text-muted uppercase">Stock</h3>
          <StockList stock={truck.stock} compact />
        </section>
      </div>
    )}
  </Sheet>
);

/** A lot or a bare parcel on the green map (SPEC 21): all five statuses, size, crew, photos and note. `drawn`: a drawn lot (SPEC 24). */
export type GreenParcel = ParcelView & { crewId: number | null; statusAt: number | null; drawn?: boolean };

export const LotSheet = ({
  parcel,
  crews,
  lots,
  onClose,
  onEditShape,
}: {
  parcel: GreenParcel | null;
  crews: readonly Pick<OverviewCrew, "id" | "name" | "companyName">[];
  lots: ReturnType<typeof useSetLot>;
  onClose: () => void;
  /** Edit shape on a drawn lot: the map takes over with its points. */
  onEditShape?: (lotId: number) => void;
}) => {
  const refresh = useGreenInvalidate();
  const assign = trpc.green.assignLots.useMutation({ onSettled: refresh });
  const del = trpc.green.deleteLot.useMutation({ onSettled: refresh });
  const [err, setErr] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [delErr, setDelErr] = useState<string | null>(null);
  const lotId = parcel?.lotId ?? null;
  useEffect(() => {
    setConfirmDelete(false);
    setDelErr(null);
  }, [lotId]);
  if (confirmDelete && parcel && lotId !== null) {
    return (
      <ConfirmSheet
        open
        title={`Delete ${parcel.address ?? "lot"}`}
        body={delErr && <p role="alert" className="font-semibold text-ink">{delErr}</p>}
        action="Delete lot"
        busy={del.isPending}
        onConfirm={() => del.mutate({ lotId }, { onSuccess: onClose, onError: (x) => setDelErr(errorText(x)) })}
        onClose={() => setConfirmDelete(false)}
      />
    );
  }
  return (
    <ParcelSheet
      parcel={parcel}
      onClose={onClose}
      onSet={lots.set}
      ensureLot={lots.ensure}
      canDnt
      error={lots.error}
      errorFor={lots.errorFor}
      onNote={(t, note) => lots.set(t, { note })}
      crew={
        parcel &&
        lotId !== null && (
          <Select
            label="Crew"
            value={parcel.crewId ?? ""}
            disabled={assign.isPending}
            error={err}
            onChange={(e) => {
              setErr(null);
              assign.mutate({ lotIds: [lotId], crewId: e.target.value ? Number(e.target.value) : null }, { onError: (x) => setErr(errorText(x)) });
            }}
          >
            <option value="">No crew</option>
            {crews.map((c) => (
              <option key={c.id} value={c.id}>
                {c.companyName ? `${c.name}, ${c.companyName}` : c.name}
              </option>
            ))}
          </Select>
        )
      }
    >
      {parcel?.statusAt != null && <Fact label="Changed">{dateTime(parcel.statusAt)}</Fact>}
      {parcel?.drawn && lotId !== null && (
        <div className="grid grid-cols-2 gap-2">
          {onEditShape && (
            <Button variant="secondary" size="lg" data-edit-shape onClick={() => onEditShape(lotId)}>
              Edit shape
            </Button>
          )}
          <Button variant="danger" size="lg" data-delete-lot onClick={() => setConfirmDelete(true)}>
            Delete lot
          </Button>
        </div>
      )}
    </ParcelSheet>
  );
};

/** A crewless stop opened from its ring on the map. */
export const StopSheet = ({
  request,
  trucks,
  now,
  onClose,
  onDone,
}: {
  request: GreenRequest | null;
  trucks: readonly GreenTruck[];
  now: number;
  onClose: () => void;
  onDone: (msg: string) => void;
}) => (
  <Sheet open={request !== null} onClose={onClose} title={request?.label ?? "Map stop"}>
    {request && (
      <div className="pb-2">
        <RequestCard request={request} trucks={trucks} now={now} onDone={onDone} />
      </div>
    )}
  </Sheet>
);
