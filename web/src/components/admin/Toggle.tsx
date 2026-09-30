/** On/off switch with its label; the whole row is the tap target. */
export const Toggle = ({
  label,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    disabled={disabled}
    onClick={() => onChange(!checked)}
    className="flex min-h-11 w-full items-center justify-between gap-3 rounded-xl px-1 text-left text-base font-semibold disabled:opacity-50"
  >
    <span>{label}</span>
    <span
      aria-hidden="true"
      className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full ring-1 ring-inset transition-colors ${
        checked ? "bg-brand-green ring-brand-green" : "bg-surface-2 ring-line"
      }`}
    >
      <span className={`absolute h-5 w-5 rounded-full bg-white shadow transition-transform ${checked ? "translate-x-6" : "translate-x-1"}`} />
    </span>
  </button>
);
