/**
 * On/off switch. With `label` the whole row is the tap target and shows the
 * label; with `labelledBy` it is the bare switch for a settings row.
 */
export const Switch = ({
  checked,
  onChange,
  label,
  labelledBy,
  disabled,
  busy,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: string;
  labelledBy?: string;
  disabled?: boolean;
  busy?: boolean;
}) => {
  const track = (
    <span
      aria-hidden="true"
      className={`relative inline-flex h-8 w-14 shrink-0 items-center rounded-full ring-1 ring-inset transition-colors ${
        checked ? "bg-brand-green ring-brand-green" : "bg-surface-2 ring-line"
      }`}
    >
      <span className={`absolute h-6 w-6 rounded-full bg-white shadow transition-transform ${checked ? "translate-x-7" : "translate-x-1"}`} />
    </span>
  );
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={label ? undefined : labelledBy}
      aria-busy={busy || undefined}
      disabled={disabled || busy}
      onClick={() => onChange(!checked)}
      className={
        label
          ? "flex min-h-11 w-full items-center justify-between gap-3 rounded-xl px-1 text-left text-base font-semibold disabled:opacity-50"
          : "grid min-h-11 min-w-16 place-items-center disabled:opacity-50"
      }
    >
      {label && <span>{label}</span>}
      {track}
    </button>
  );
};
