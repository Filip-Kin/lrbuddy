import { useEffect, useState } from "react";
import { Button } from "../Button.tsx";
import { TextArea } from "../Field.tsx";
import { Sheet } from "../Sheet.tsx";
import { qtyWithUnit } from "./format.ts";
import { ErrorLine } from "./StopCard.tsx";
import type { DriverActions, QueueStop } from "./hooks.ts";

const CREW_REASONS = ["Crew not found", "Out of stock", "Road blocked", "Crew declined"];
const PIN_REASONS = ["Nobody there", "Out of stock", "Road blocked"];

/** Driver cancel: en route items only, with a reason the crew and the CC both see. */
export const CancelSheet = ({ stop, actions, onClose }: { stop: QueueStop | null; actions: DriverActions; onClose: () => void }) => {
  const items = stop?.items.filter((i) => i.status === "en_route") ?? [];
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [reason, setReason] = useState("");
  const key = stop?.key ?? "";

  useEffect(() => {
    setPicked(new Set(stop?.items.filter((i) => i.status === "en_route").map((i) => i.id) ?? []));
    setReason("");
    // Reset only when a different stop opens.
  }, [key]);

  const toggle = (id: number): void =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const submit = (): void => {
    const ids = [...picked];
    if (ids.length === 0 || !reason.trim()) return;
    actions.cancel.mutate({ requestIds: ids, note: reason.trim() }, { onSuccess: onClose });
  };

  return (
    <Sheet
      open={!!stop}
      onClose={onClose}
      title={stop ? `Cancel ${stop.name}` : "Cancel stop"}
      footer={
        <div className="space-y-2">
          <ErrorLine text={actions.error} />
          <Button variant="danger" size="lg" block busy={actions.cancel.isPending} disabled={picked.size === 0 || !reason.trim()} onClick={submit}>
            Cancel {picked.size === 1 ? "item" : "items"}
          </Button>
        </div>
      }
    >
      <div className="space-y-5 pb-2">
        {items.length > 1 && (
          <fieldset className="space-y-2">
            <legend className="mb-2 text-sm font-semibold">Items</legend>
            {items.map((i) => (
              <label key={i.id} className="flex min-h-12 items-center gap-3 rounded-xl bg-surface-2 px-3 ring-1 ring-line ring-inset">
                <input type="checkbox" className="h-5 w-5 accent-[var(--ink)]" checked={picked.has(i.id)} onChange={() => toggle(i.id)} />
                <span className="flex-1 text-base font-semibold">{i.typeLabel}</span>
                <span className="text-base font-bold tabular-nums">{qtyWithUnit(i.qty, i.unit)}</span>
              </label>
            ))}
          </fieldset>
        )}
        <div className="space-y-2">
          <div className="flex flex-wrap gap-2" role="group" aria-label="Common reasons">
            {(stop?.crewId === null ? PIN_REASONS : CREW_REASONS).map((r) => (
              <button
                key={r}
                type="button"
                aria-pressed={reason === r}
                onClick={() => setReason(r)}
                className={`min-h-10 rounded-full px-4 text-sm font-semibold ring-1 ring-inset ${
                  reason === r ? "bg-ink text-surface ring-ink" : "bg-surface-2 text-ink ring-line"
                }`}
              >
                {r}
              </button>
            ))}
          </div>
          <TextArea label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} rows={2} />
        </div>
      </div>
    </Sheet>
  );
};
