/** One choice out of a few, as a row of buttons. */
export const Segmented = <T extends string | number>({
  label,
  value,
  options,
  onChange,
  size = "md",
}: {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (v: T) => void;
  size?: "md" | "lg";
}) => (
  <div role="radiogroup" aria-label={label} className="flex w-full gap-1 rounded-xl bg-surface-2 p-1 ring-1 ring-inset ring-line">
    {options.map((o) => {
      const on = o.value === value;
      return (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={on}
          onClick={() => onChange(o.value)}
          className={`flex-1 rounded-lg px-2 font-semibold transition-colors ${size === "lg" ? "min-h-12 text-base" : "min-h-10 text-sm"} ${
            on ? "bg-brand text-on-brand shadow-sm" : "text-ink hover:bg-surface"
          }`}
        >
          {o.label}
        </button>
      );
    })}
  </div>
);
