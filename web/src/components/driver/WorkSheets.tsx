import { useState } from "react";
import { LotStatusControl, type LotStatus } from "../crew/LotStatusControl.tsx";
import { ContactButtons } from "../green/Contact.tsx";
import { Fact } from "../green/ui.tsx";
import type { DayOfArea } from "../green/dayOfLayer.ts";
import { LotSheet } from "../LotSheet.tsx";
import { Sheet } from "../Sheet.tsx";
import { lotPill, StatusPill } from "../StatusPill.tsx";
import { trpc, type RouterOutputs } from "../../lib/trpc.ts";

export type DriverLot = RouterOutputs["driver"]["lots"]["lots"][number];
export type DriverCrew = RouterOutputs["driver"]["crews"][number];

// #region lot status
/**
 * Lot status from the driver, with the map recoloured before the server
 * answers and put back if it refuses (the crew page's rule).
 */
export const useDriverLotStatus = () => {
  const utils = trpc.useUtils();
  const [error, setError] = useState<{ lotId: number; message: string } | null>(null);
  const m = trpc.driver.setLotStatus.useMutation({
    onMutate: async ({ lotId, status }) => {
      setError(null);
      await utils.driver.lots.cancel();
      const prev = utils.driver.lots.getData();
      utils.driver.lots.setData(undefined, (old) => (old ? { ...old, lots: old.lots.map((l) => (l.id === lotId ? { ...l, status } : l)) } : old));
      return { prev };
    },
    onError: (err, vars, ctx) => {
      if (ctx?.prev) utils.driver.lots.setData(undefined, ctx.prev);
      setError({ lotId: vars.lotId, message: err.data?.code === "FORBIDDEN" || err.data?.code === "NOT_FOUND" ? err.message : "Not saved. Check signal and tap again." });
    },
    onSettled: () => {
      void utils.driver.lots.invalidate();
    },
  });
  return {
    set: (lotId: number, status: LotStatus) => m.mutate({ lotId, status }),
    error: error?.message ?? null,
    errorFor: error?.lotId ?? null,
  };
};
// #endregion

/** The shared lot sheet with the driver's status control: Open, In progress, Done, Skip. */
export const DriverLotSheet = ({ lot, crew, onClose }: { lot: DriverLot | null; crew: DriverCrew | null; onClose: () => void }) => {
  const status = useDriverLotStatus();
  return (
    <LotSheet
      lot={lot}
      onClose={onClose}
      status={
        lot && (
          <>
            <LotStatusControl status={lot.status} onChange={(s) => status.set(lot.id, s)} />
            {status.error && status.errorFor === lot.id && (
              <p role="alert" className="mt-2 text-sm font-semibold">
                {status.error}
              </p>
            )}
          </>
        )
      }
      crew={
        lot && (
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted">
            <StatusPill status={lotPill(lot.status)} />
            <span>{crew ? [crew.team, crew.companyName].filter(Boolean).join(", ") : "No crew"}</span>
          </div>
        )
      }
    >
      {lot?.note && <p className="text-sm break-words text-muted">{lot.note}</p>}
    </LotSheet>
  );
};

/** A rectangle's crews, company and progress, with each lead's Call and Text. No actions for drivers. */
export const AreaCard = ({ area, crews, onClose }: { area: DayOfArea | null; crews: readonly DriverCrew[]; onClose: () => void }) => {
  const members = area ? area.crewIds.map((id) => crews.find((c) => c.id === id)).filter((c): c is DriverCrew => !!c) : [];
  const c = area?.counts;
  const total = c ? c.open + c.inProgress + c.done + c.skipped : 0;
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
                  <span className="font-bold">{m.team}</span>
                  {m.team !== m.name && <span className="text-sm text-muted">{m.name}</span>}
                  {m.leadName && <span className="text-sm text-muted">{m.leadName}</span>}
                </div>
                <ContactButtons phone={m.leadPhone} who={m.leadName ?? m.team} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </Sheet>
  );
};
