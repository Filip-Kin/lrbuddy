import { ContactButtons } from "../green/Contact.tsx";
import { Fact } from "../green/ui.tsx";
import type { DayOfArea } from "../green/dayOfLayer.ts";
import type { useSetLot } from "../LotStatusControl.tsx";
import { ParcelSheet } from "../ParcelSheet.tsx";
import { Sheet } from "../Sheet.tsx";
import type { RouterOutputs } from "../../lib/trpc.ts";

export type DriverLot = RouterOutputs["driver"]["lots"]["lots"][number];
export type DriverCrew = RouterOutputs["driver"]["crews"][number];

/**
 * The shared lot sheet for a driver (SPEC 21): Not todo, Todo, In progress,
 * Done; Do not touch shows but is for green shirts.
 */
export const DriverLotSheet = ({ lot, crew, lots, onClose }: { lot: DriverLot | null; crew: DriverCrew | null; lots: ReturnType<typeof useSetLot>; onClose: () => void }) => (
  <ParcelSheet
    parcel={lot ? { lotId: lot.id, parcelId: lot.parcelId, address: lot.address, status: lots.pending.get(`l:${lot.id}`) ?? lot.status, grade: lot.grade, note: lot.note } : null}
    onClose={onClose}
    onSet={lots.set}
    ensureLot={lots.ensure}
    error={lots.error}
    errorFor={lots.errorFor}
    crew={lot && <p className="text-sm text-muted">{crew ? [crew.name, crew.companyName].filter(Boolean).join(", ") : "No crew"}</p>}
  />
);

/** A rectangle's crews, company and progress, with each lead's Call and Text. No actions for drivers. */
export const AreaCard = ({ area, crews, onClose }: { area: DayOfArea | null; crews: readonly DriverCrew[]; onClose: () => void }) => {
  const members = area ? area.crewIds.map((id) => crews.find((c) => c.id === id)).filter((c): c is DriverCrew => !!c) : [];
  const c = area?.counts;
  const total = c ? c.open + c.inProgress + c.done + c.doNotTouch : 0;
  return (
    <Sheet open={area !== null} onClose={onClose} title={area?.label ?? "Area"}>
      {area && c && (
        <div className="space-y-4 pb-2">
          <div className="grid grid-cols-2 gap-3 rounded-2xl bg-surface-2 p-3">
            <Fact label="Company">{area.companyName ?? "None"}</Fact>
            <Fact label="Lots done">{`${c.done} of ${total}`}</Fact>
          </div>
          <ul className="space-y-3" aria-label="Crews">
            {members.map((m) => (
              <li key={m.id} className="space-y-2">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-bold">{m.name}</span>
                  {m.leadName && <span className="text-sm text-muted">{m.leadName}</span>}
                </div>
                <ContactButtons phone={m.leadPhone} who={m.leadName ?? m.name} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </Sheet>
  );
};
