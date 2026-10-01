export type PairState = "none" | "before" | "after" | "both";

const PAIR: Record<PairState, { label: string; cls: string }> = {
  none: { label: "None", cls: "bg-surface-2 text-muted" },
  before: { label: "Before", cls: "bg-warn/15 text-ink" },
  after: { label: "After", cls: "bg-surface-2 text-ink ring-1 ring-inset ring-line" },
  both: { label: "Both", cls: "bg-brand-green/15 text-ink" },
};

/** Which photos a lot has: none, a before only, an after only, or the pair. */
export const PairPill = ({ state }: { state: PairState }) => (
  <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold ${PAIR[state].cls}`}>
    {state === "both" && <span aria-hidden="true" className="h-2 w-2 rounded-full bg-brand-green" />}
    {state === "before" && <span aria-hidden="true" className="h-2 w-2 rounded-full bg-warn" />}
    {PAIR[state].label}
  </span>
);

/** The Missing after filter: a before photo and no after. */
export const MissingAfterToggle = ({ on, onChange, count }: { on: boolean; onChange: (v: boolean) => void; count?: number }) => (
  <button
    type="button"
    aria-pressed={on}
    onClick={() => onChange(!on)}
    className={`inline-flex min-h-10 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-base font-semibold whitespace-nowrap ring-1 ring-inset ${
      on ? "bg-brand text-on-brand ring-on-brand/30" : "bg-surface text-ink ring-line hover:bg-surface-2"
    }`}
  >
    Missing after
    {count !== undefined && <span className={`tabular-nums ${on ? "" : "text-muted"}`}>{count}</span>}
  </button>
);
