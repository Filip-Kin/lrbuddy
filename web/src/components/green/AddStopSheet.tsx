import { useEffect, useState } from "react";
import { Button } from "../Button.tsx";
import { Select, TextArea } from "../Field.tsx";
import { QtyStepper } from "../QtyStepper.tsx";
import { Sheet } from "../Sheet.tsx";
import { trpc } from "../../lib/trpc.ts";
import { errorText, useGreenInvalidate, type GreenCrew } from "./hooks.ts";

/**
 * Green-entered stops at a dropped pin: one or more items, each with its quantity, the crew and a
 * note. The crew starts as the crew of the area holding the pin (green.stopCrew); picking one, or
 * No crew, overrides it. The server makes one request per item, `created_by: 'green'`, and
 * dispatches each.
 */
export const AddStopSheet = ({
  pin,
  crews,
  onClose,
  onSent,
}: {
  pin: { lat: number; lng: number } | null;
  crews: readonly Pick<GreenCrew, "id" | "name" | "companyName">[];
  onClose: () => void;
  onSent: (msg: string) => void;
}) => {
  const catalog = trpc.green.catalog.useQuery();
  const refresh = useGreenInvalidate();
  const create = trpc.green.createStop.useMutation({ onSettled: refresh });
  const [picked, setPicked] = useState<ReadonlyMap<number, number>>(new Map());
  // undefined: the crew of the pin's area; null: no crew.
  const [crewPick, setCrewPick] = useState<number | null | undefined>(undefined);
  const detected = trpc.green.stopCrew.useQuery(pin ?? { lat: 0, lng: 0 }, { enabled: pin !== null });
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null);

  // A fresh pin starts a fresh form.
  useEffect(() => {
    if (!pin) return;
    setPicked(new Map());
    setCrewPick(undefined);
    setNote("");
    setErr(null);
  }, [pin]);

  const types = catalog.data ?? [];
  const crewValue = crewPick === undefined ? (detected.data ?? null) : crewPick;
  const toggle = (id: number): void =>
    setPicked((m) => {
      const next = new Map(m);
      if (next.has(id)) next.delete(id);
      else next.set(id, 1);
      return next;
    });
  const setQty = (id: number, q: number): void => setPicked((m) => new Map(m).set(id, q));

  const send = (): void => {
    if (!pin || picked.size === 0) return;
    setErr(null);
    create.mutate(
      { items: [...picked].map(([typeId, qty]) => ({ typeId, qty })), lat: pin.lat, lng: pin.lng, crewId: crewPick, note: note.trim() || null },
      {
        onSuccess: (rs) => {
          const trucks = [...new Set(rs.map((r) => r.truckName).filter(Boolean))];
          const n = rs.length === 1 ? "Stop" : `${rs.length} stops`;
          onSent(trucks.length > 0 ? `${n} sent, ${trucks.join(", ")}` : `${n} open, no truck`);
          onClose();
        },
        onError: (e) => setErr(errorText(e)),
      },
    );
  };

  return (
    <Sheet
      open={pin !== null}
      onClose={onClose}
      title="Add stop"
      footer={
        <>
          {err && (
            <p role="alert" className="mb-2 text-sm font-semibold">
              {err}
            </p>
          )}
          <Button block size="lg" busy={create.isPending} disabled={picked.size === 0} onClick={send}>
            Send
          </Button>
        </>
      }
    >
      <div className="space-y-5 pb-2">
        <fieldset>
          <legend className="mb-2 text-sm font-semibold">Item</legend>
          {catalog.isLoading ? (
            <div className="grid grid-cols-3 gap-2" aria-busy="true">
              {Array.from({ length: 6 }, (_, i) => (
                <div key={i} className="h-12 animate-pulse rounded-xl bg-surface-2" />
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-3 gap-2">
              {types.map((t) => {
                const on = picked.has(t.id);
                return (
                  <button
                    key={t.id}
                    type="button"
                    aria-pressed={on}
                    onClick={() => toggle(t.id)}
                    className={`min-h-12 rounded-xl px-2 py-2 text-sm leading-tight font-semibold ring-1 ring-inset transition-colors ${
                      on ? "bg-brand text-on-brand ring-on-brand/40" : "bg-surface-2 text-ink ring-line hover:brightness-95"
                    }`}
                  >
                    {t.label}
                  </button>
                );
              })}
            </div>
          )}
        </fieldset>
        {picked.size > 0 && (
          <ul className="space-y-2" data-stop-items>
            {types
              .filter((t) => picked.has(t.id))
              .map((t) => (
                <li key={t.id} className="flex items-center justify-between gap-4">
                  <span className="text-sm font-semibold">{t.label}</span>
                  <QtyStepper value={picked.get(t.id) ?? 1} onChange={(q) => setQty(t.id, q)} size="md" label={`Quantity, ${t.label}`} />
                </li>
              ))}
          </ul>
        )}
        <Select label="Crew" value={crewValue ?? ""} onChange={(e) => setCrewPick(e.target.value ? Number(e.target.value) : null)}>
          <option value="">No crew</option>
          {crews.map((c) => (
            <option key={c.id} value={c.id}>
              {c.companyName ? `${c.name}, ${c.companyName}` : c.name}
            </option>
          ))}
        </Select>
        <TextArea label="Note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} rows={2} />
      </div>
    </Sheet>
  );
};
