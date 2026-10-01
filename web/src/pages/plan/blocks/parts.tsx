import { useEffect, useId, useState, type ReactNode } from "react";
import { DEFAULT_CAPACITY, loadText, type Capacity } from "./sides.ts";

/** One number box with its label beside it; commits on blur or Enter, never below 1. */
const NumberBox = ({ label, value, onCommit }: { label: string; value: number; onCommit: (n: number) => void }) => {
  const id = useId();
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = (): void => {
    const n = Math.round(Number(text));
    if (Number.isFinite(n) && n >= 1 && n <= 100) onCommit(n);
    else setText(String(value));
  };
  return (
    <div className="flex items-center gap-2">
      <label htmlFor={id} className="text-sm font-semibold text-muted">
        {label}
      </label>
      <input
        id={id}
        type="number"
        inputMode="numeric"
        min={1}
        max={100}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
        }}
        className="min-h-10 w-16 rounded-lg border-0 bg-surface-2 px-2 text-right text-base text-ink tabular-nums ring-1 ring-line ring-inset focus:ring-2 focus:ring-ink focus:outline-none"
      />
    </div>
  );
};

/** Per-crew capacity: low parcels or high parcels one crew takes. */
export const CapacityInputs = ({ value, onChange }: { value: Capacity; onChange: (c: Capacity) => void }) => (
  <fieldset className="flex flex-wrap items-center gap-x-4 gap-y-2">
    <legend className="sr-only">Per crew</legend>
    <span className="text-sm font-bold">Per crew</span>
    <NumberBox label="Parcels" value={value.parcels} onCommit={(parcels) => onChange({ ...value, parcels })} />
    <NumberBox label="High" value={value.high} onCommit={(high) => onChange({ ...value, high })} />
    {(value.parcels !== DEFAULT_CAPACITY.parcels || value.high !== DEFAULT_CAPACITY.high) && (
      <button type="button" onClick={() => onChange(DEFAULT_CAPACITY)} className="min-h-10 rounded-lg px-2 text-sm font-semibold text-ink underline underline-offset-2 hover:bg-surface-2">
        Reset
      </button>
    )}
  </fieldset>
);

export const Legend = ({ items }: { items: ReadonlyArray<{ swatch: string; label: string }> }) => (
  <ul aria-label="Legend" className="flex flex-wrap items-center gap-x-4 gap-y-1 px-1 text-xs text-muted">
    {items.map((i) => (
      <li key={i.label} className="flex items-center gap-1.5">
        <span aria-hidden="true" className={`h-3 w-4 rounded-sm ${i.swatch}`} />
        {i.label}
      </li>
    ))}
  </ul>
);

/** Work against capacity in crews; the fill turns --warn past capacity. */
export const CapacityBar = ({ load, capacity, label }: { load: number; capacity: number; label: string }) => {
  const over = load > capacity + 1e-9;
  const pct = capacity > 0 ? Math.min(100, (load / capacity) * 100) : load > 0 ? 100 : 0;
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="text-muted">{label}</span>
        <span className={`font-semibold tabular-nums ${over ? "text-ink" : "text-muted"}`}>
          {loadText(load)} of {capacity} crews
          {over && <span className="ml-1.5 rounded-full bg-warn/20 px-1.5 py-px font-bold">Over</span>}
        </span>
      </div>
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={capacity}
        aria-valuenow={Math.round(load * 10) / 10}
        className="h-2 overflow-hidden rounded-full bg-surface-2 ring-1 ring-line ring-inset"
      >
        <div className={`h-full rounded-full ${over ? "bg-warn" : "bg-brand-green"}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
};

/** Compact select with its label beside it, for toolbars. */
export const InlineSelect = ({
  label,
  value,
  onChange,
  children,
  className = "",
  disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  children: ReactNode;
  className?: string;
  disabled?: boolean;
}) => {
  const id = useId();
  return (
    <div className={`flex min-w-0 items-center gap-2 ${className}`}>
      <label htmlFor={id} className="shrink-0 text-sm font-semibold text-muted">
        {label}
      </label>
      <div className="relative min-w-0 flex-1">
        <select
          id={id}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          className="min-h-10 w-full min-w-0 appearance-none truncate rounded-lg bg-surface py-1.5 pr-8 pl-3 text-base font-semibold text-ink ring-1 ring-line ring-inset focus:ring-2 focus:ring-ink focus:outline-none disabled:opacity-50"
        >
          {children}
        </select>
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-muted">
          <path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
        </svg>
      </div>
    </div>
  );
};

/** A small labelled number box that saves on blur or Enter. */
export const InlineNumber = ({ label, value, onCommit, min = 0, max = 5000, busy }: { label: string; value: number; onCommit: (n: number) => void; min?: number; max?: number; busy?: boolean }) => {
  const id = useId();
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = (): void => {
    const n = Math.round(Number(text));
    if (text.trim() !== "" && Number.isFinite(n) && n >= min && n <= max) {
      if (n !== value) onCommit(n);
    } else setText(String(value));
  };
  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <label htmlFor={id} className="text-xs font-semibold text-muted">
        {label}
      </label>
      <input
        id={id}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        value={text}
        aria-busy={busy || undefined}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
        }}
        className="min-h-10 w-[4.5rem] rounded-lg border-0 bg-surface-2 px-2 text-right text-base text-ink tabular-nums ring-1 ring-line ring-inset focus:ring-2 focus:ring-ink focus:outline-none"
      />
    </div>
  );
};
