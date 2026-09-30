import { useState } from "react";
import { trpc } from "../../lib/trpc.ts";

export type LotStatus = "open" | "in_progress" | "done" | "skipped";

const SEGMENTS: Array<{ status: Exclude<LotStatus, "open">; label: string; on: string }> = [
  { status: "done", label: "Done", on: "bg-brand-green/20 ring-2 ring-inset ring-brand-green" },
  { status: "in_progress", label: "In progress", on: "bg-brand text-on-brand ring-2 ring-inset ring-on-brand/40" },
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
 * Done / In progress / Skip. Tapping the lit segment again puts the lot back
 * to open, so a wrong tap in the sun is one more tap to undo.
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
  <div role="group" aria-label={label} className="grid grid-cols-[1fr_1.45fr_1fr] gap-1 rounded-2xl bg-surface-2 p-1 ring-1 ring-inset ring-line">
    {SEGMENTS.map((s) => {
      const on = status === s.status;
      return (
        <button
          key={s.status}
          type="button"
          aria-pressed={on}
          onClick={() => onChange(on ? "open" : s.status)}
          className={`flex min-h-12 items-center justify-center gap-1.5 rounded-xl px-2 text-[15px] font-semibold text-ink transition-colors ${
            on ? s.on : "bg-transparent active:bg-surface"
          }`}
        >
          {on && (
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" className="shrink-0">
              <path d="m5 12.5 4.5 4.5L19 7.5" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
          <span className="leading-tight">{s.label}</span>
        </button>
      );
    })}
  </div>
);
