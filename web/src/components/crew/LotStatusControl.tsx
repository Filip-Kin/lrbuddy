import { useState } from "react";
import { trpc } from "../../lib/trpc.ts";

export type LotStatus = "open" | "in_progress" | "done" | "skipped";

const SEGMENTS: Array<{ status: LotStatus; label: string; on: string }> = [
  { status: "open", label: "Open", on: "bg-surface ring-2 ring-inset ring-ink/40" },
  { status: "in_progress", label: "In progress", on: "bg-brand text-on-brand ring-2 ring-inset ring-on-brand/40" },
  { status: "done", label: "Done", on: "bg-brand-green/20 ring-2 ring-inset ring-brand-green" },
  { status: "skipped", label: "Skip", on: "bg-warn/20 ring-2 ring-inset ring-warn" },
];

/**
 * Lot status change with the list and the map updated before the server
 * answers; rolled back if it refuses.
 */
export const useLotStatus = () => {
  const utils = trpc.useUtils();
  const [error, setError] = useState<{ lotId: number; message: string } | null>(null);
  const m = trpc.crew.setLotStatus.useMutation({
    onMutate: async ({ lotId, status }) => {
      setError(null);
      await Promise.all([utils.crew.lots.cancel(), utils.crew.map.cancel()]);
      const lots = utils.crew.lots.getData();
      const map = utils.crew.map.getData();
      utils.crew.lots.setData(undefined, (old) => old?.map((l) => (l.id === lotId ? { ...l, status } : l)));
      utils.crew.map.setData(undefined, (old) => (old ? { ...old, lots: old.lots.map((l) => (l.id === lotId ? { ...l, status } : l)) } : old));
      return { lots, map };
    },
    onError: (err, vars, ctx) => {
      if (ctx?.lots) utils.crew.lots.setData(undefined, ctx.lots);
      if (ctx?.map) utils.crew.map.setData(undefined, ctx.map);
      setError({ lotId: vars.lotId, message: err.data?.code === "FORBIDDEN" || err.data?.code === "NOT_FOUND" ? err.message : "Not saved. Check signal and tap again." });
    },
    onSettled: () => {
      void utils.crew.lots.invalidate();
      void utils.crew.map.invalidate();
    },
  });
  return {
    set: (lotId: number, status: LotStatus) => m.mutate({ lotId, status }),
    error: error?.message ?? null,
    errorFor: error?.lotId ?? null,
  };
};

/**
 * Open / In progress / Done / Skip, in the order a lot goes through them.
 * Open is a segment of its own so a wrong tap on Done or Skip has a visible
 * undo; tapping a lit segment again also puts the lot back to open.
 */
export const LotStatusControl = ({
  status,
  onChange,
  label = "Lot status",
}: {
  status: LotStatus;
  onChange: (s: LotStatus) => void;
  label?: string;
}) => (
  <div role="group" aria-label={label} className="grid grid-cols-[1fr_1.6fr_1fr_1fr] gap-1 rounded-2xl bg-surface-2 p-1 ring-1 ring-inset ring-line">
    {SEGMENTS.map((s) => {
      const on = status === s.status;
      return (
        <button
          key={s.status}
          type="button"
          aria-pressed={on}
          onClick={() => {
            if (on && s.status === "open") return;
            onChange(on ? "open" : s.status);
          }}
          className={`flex min-h-12 min-w-0 items-center justify-center gap-1 rounded-xl px-1.5 text-[15px] font-semibold text-ink transition-colors ${
            on ? s.on : "bg-transparent active:bg-surface"
          }`}
        >
          <span className="text-center leading-tight break-words">{s.label}</span>
        </button>
      );
    })}
  </div>
);
