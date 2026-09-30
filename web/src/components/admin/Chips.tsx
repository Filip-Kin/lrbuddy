import type { ReactNode } from "react";

/** Horizontal row of choice chips that scrolls inside itself on a narrow screen. */
export const Chips = <T extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T | null;
  options: ReadonlyArray<{ value: T; label: string; badge?: ReactNode }>;
  onChange: (v: T) => void;
}) => (
  <div role="radiogroup" aria-label={label} className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 nav:mx-0 nav:flex-wrap nav:px-0">
    {options.map((o) => {
      const on = o.value === value;
      return (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={on}
          onClick={() => onChange(o.value)}
          className={`inline-flex min-h-10 shrink-0 items-center gap-2 whitespace-nowrap rounded-full px-4 text-sm font-semibold ring-1 ring-inset transition-colors ${
            on ? "bg-brand text-on-brand ring-brand" : "bg-surface text-ink ring-line hover:bg-surface-2"
          }`}
        >
          {o.label}
          {o.badge !== undefined && <span className={`tabular-nums ${on ? "" : "text-muted"}`}>{o.badge}</span>}
        </button>
      );
    })}
  </div>
);
