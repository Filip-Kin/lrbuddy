import { useEffect, useState } from "react";
import { Button } from "../Button.tsx";
import { Field, Select, TextArea } from "../Field.tsx";
import { QtyStepper } from "../QtyStepper.tsx";
import { Sheet } from "../Sheet.tsx";
import { trpc } from "../../lib/trpc.ts";
import { errorText, useGreenInvalidate, type GreenCrew } from "./hooks.ts";

/**
 * Green-entered stop at a dropped pin: item, quantity, optional crew, label and
 * note. The server creates it with `created_by: 'green'` and dispatches it.
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
  const [typeId, setTypeId] = useState<number | null>(null);
  const [qty, setQty] = useState(1);
  const [crewId, setCrewId] = useState<number | null>(null);
  const [label, setLabel] = useState("");
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null);

  // A fresh pin starts a fresh form.
  useEffect(() => {
    if (!pin) return;
    setQty(1);
    setCrewId(null);
    setLabel("");
    setNote("");
    setErr(null);
  }, [pin]);

  const types = catalog.data ?? [];
  const chosen = typeId ?? types[0]?.id ?? null;

  const send = (): void => {
    if (!pin || chosen === null) return;
    setErr(null);
    create.mutate(
      { typeId: chosen, qty, lat: pin.lat, lng: pin.lng, crewId, label: label.trim() || null, note: note.trim() || null },
      {
        onSuccess: (r) => {
          onSent(r.truckName ? `Stop sent, ${r.truckName}` : "Stop open, no truck");
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
          <Button block size="lg" busy={create.isPending} disabled={chosen === null} onClick={send}>
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
                const on = t.id === chosen;
                return (
                  <button
                    key={t.id}
                    type="button"
                    aria-pressed={on}
                    onClick={() => setTypeId(t.id)}
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
        <div className="flex items-center justify-between gap-4">
          <span className="text-sm font-semibold" id="stop-qty">
            Quantity
          </span>
          <QtyStepper value={qty} onChange={setQty} size="md" />
        </div>
        <Select label="Crew" value={crewId ?? ""} onChange={(e) => setCrewId(e.target.value ? Number(e.target.value) : null)}>
          <option value="">No crew</option>
          {crews.map((c) => (
            <option key={c.id} value={c.id}>
              {c.companyName ? `${c.name}, ${c.companyName}` : c.name}
            </option>
          ))}
        </Select>
        <Field label="Label" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={120} placeholder="Corner of Harding and Warren" />
        <TextArea label="Note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} rows={2} />
      </div>
    </Sheet>
  );
};
