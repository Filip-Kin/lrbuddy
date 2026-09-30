import type { ReactNode } from "react";

/**
 * One choice out of a few, as a row of equal buttons. `tabs` switches a view
 * (tablist); otherwise it is a form choice (radiogroup). `stacked` puts the
 * count above the label, for four or more tabs on a phone.
 */
export const Segmented = <T extends string | number>({
  label,
  value,
  options,
  onChange,
  tabs,
  stacked,
  size = "md",
  className = "",
}: {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string; count?: number }>;
  onChange: (v: T) => void;
  tabs?: boolean;
  stacked?: boolean;
  size?: "md" | "lg";
  className?: string;
}) => (
  <div
    role={tabs ? "tablist" : "radiogroup"}
    aria-label={label}
    className={`${stacked ? "grid auto-cols-fr grid-flow-col" : "flex overflow-x-auto"} w-full gap-1 rounded-2xl bg-surface-2 p-1 ring-1 ring-inset ring-line ${className}`}
  >
    {options.map((o) => {
      const on = o.value === value;
      const a11y = tabs ? { role: "tab", "aria-selected": on } : { role: "radio", "aria-checked": on };
      const tone = on ? "bg-brand text-on-brand shadow-sm" : "text-ink hover:bg-surface";
      return stacked ? (
        <button
          key={String(o.value)}
          type="button"
          {...a11y}
          onClick={() => onChange(o.value)}
          className={`flex min-h-14 min-w-0 flex-col items-center justify-center rounded-xl px-1 py-1.5 transition-colors ${tone}`}
        >
          <span className="text-xl leading-none font-extrabold tabular-nums">{o.count ?? ""}</span>
          <span className="mt-1 max-w-full truncate text-xs font-semibold">{o.label}</span>
        </button>
      ) : (
        <button
          key={String(o.value)}
          type="button"
          {...a11y}
          onClick={() => onChange(o.value)}
          className={`inline-flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-xl px-3 font-semibold transition-colors ${
            size === "lg" ? "min-h-12 text-base" : "min-h-11 text-sm"
          } ${tone}`}
        >
          {o.label}
          {o.count !== undefined && (
            <span className={`min-w-6 rounded-full px-1.5 text-xs tabular-nums ${on ? "bg-on-brand/15" : "bg-surface"}`}>{o.count}</span>
          )}
        </button>
      );
    })}
  </div>
);

/** Row of choice chips that scrolls inside itself on a narrow screen. */
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
          className={`${chipClass(on)} shrink-0`}
        >
          {o.label}
          {o.badge !== undefined && <span className={`tabular-nums ${on ? "" : "text-muted"}`}>{o.badge}</span>}
        </button>
      );
    })}
  </div>
);

const chipClass = (on: boolean): string =>
  `inline-flex min-h-10 items-center gap-1.5 whitespace-nowrap rounded-full px-3.5 text-sm font-semibold ring-1 ring-inset transition-colors ${
    on ? "bg-brand text-on-brand ring-brand" : "bg-surface text-ink ring-line hover:bg-surface-2"
  }`;

/** On/off chip, for map layers and the sound switch. Same look as a picked chip. */
export const ToggleChip = ({ on, onChange, children, label }: { on: boolean; onChange: (v: boolean) => void; children: ReactNode; label?: string }) => (
  <button type="button" aria-pressed={on} aria-label={label} onClick={() => onChange(!on)} className={`${chipClass(on)} shrink-0`}>
    {children}
  </button>
);
