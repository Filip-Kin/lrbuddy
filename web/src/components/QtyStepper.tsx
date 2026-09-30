export const QtyStepper = ({
  value,
  onChange,
  min = 1,
  max = 99,
  label = "Quantity",
  size = "lg",
}: {
  value: number;
  onChange: (n: number) => void;
  min?: number;
  max?: number;
  label?: string;
  size?: "md" | "lg";
}) => {
  const btn = size === "lg" ? "h-14 w-14 rounded-2xl" : "h-11 w-11 rounded-xl";
  const cls = `${btn} grid place-items-center font-bold bg-surface-2 text-ink ring-1 ring-inset ring-line active:brightness-90 disabled:opacity-40`;
  return (
    <div role="group" aria-label={label} className="inline-flex items-center gap-3">
      <button type="button" className={cls} aria-label="Less" disabled={value <= min} onClick={() => onChange(Math.max(min, value - 1))}>
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
          <path d="M5 12h14" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
        </svg>
      </button>
      <output aria-live="polite" className={`${size === "lg" ? "min-w-12 text-3xl" : "min-w-8 text-xl"} text-center font-bold tabular-nums`}>
        {value}
      </output>
      <button type="button" className={cls} aria-label="More" disabled={value >= max} onClick={() => onChange(Math.min(max, value + 1))}>
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
          <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
};
