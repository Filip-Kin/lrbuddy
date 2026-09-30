import { useEffect, useState, type ReactNode, type SelectHTMLAttributes } from "react";

// #region icons
const Svg = ({ children, size = 20 }: { children: ReactNode; size?: number }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    {children}
  </svg>
);

export const PhoneIcon = () => (
  <Svg>
    <path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2" />
  </Svg>
);
export const TextIcon = () => (
  <Svg>
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
  </Svg>
);
export const PinIcon = () => (
  <Svg size={22}>
    <path d="M12 21s-7-6.2-7-12a7 7 0 0 1 14 0c0 5.8-7 12-7 12z" />
    <circle cx="12" cy="9" r="2.5" />
  </Svg>
);
export const CheckIcon = () => (
  <Svg>
    <path d="M5 12.5l4.5 4.5L19 7" />
  </Svg>
);
export const TruckIcon = () => (
  <Svg>
    <path d="M3 6h11v10H3zM14 9h4l3 3v4h-7" />
    <circle cx="7" cy="17.5" r="1.8" />
    <circle cx="17" cy="17.5" r="1.8" />
  </Svg>
);
export const SoundIcon = ({ on }: { on: boolean }) => (
  <Svg>
    <path d="M4 9v6h4l5 4V5L8 9z" />
    {on ? <path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12" /> : <path d="M17 9l5 6M22 9l-5 6" />}
  </Svg>
);
export const RectIcon = () => (
  <Svg>
    <rect x="4" y="5" width="16" height="14" rx="1.5" strokeDasharray="3 2.5" />
  </Svg>
);
export const SendIcon = () => (
  <Svg>
    <path d="M4 12l16-8-6 16-2.5-6.5z" />
  </Svg>
);
// #endregion

/** Compact labelled select for filter rows. 16 px text so iOS does not zoom. */
export const FilterSelect = ({ label, children, className = "", ...rest }: { label: string } & SelectHTMLAttributes<HTMLSelectElement>) => (
  <div className={`relative inline-flex min-w-0 items-center ${className}`}>
    <select
      aria-label={label}
      {...rest}
      className="min-h-10 w-full min-w-0 appearance-none truncate rounded-full bg-surface py-1.5 pr-8 pl-3.5 text-base font-semibold text-ink ring-1 ring-inset ring-line focus:ring-2 focus:ring-ink focus:outline-none"
    >
      {children}
    </select>
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" className="pointer-events-none absolute right-3 text-muted">
      <path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  </div>
);

export const Card = ({ children, className = "" }: { children: ReactNode; className?: string }) => (
  <div className={`rounded-2xl bg-surface p-4 ring-1 ring-line ${className}`}>{children}</div>
);

/** Label over a value, for card facts. */
export const Fact = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="min-w-0">
    <div className="text-xs font-semibold text-muted">{label}</div>
    <div className="truncate text-base font-semibold tabular-nums">{children}</div>
  </div>
);

/** Status line that fades after a few seconds. Announced to screen readers. */
export const useFlash = (): [ReactNode, (msg: string) => void] => {
  const [msg, setMsg] = useState<{ text: string; key: number } | null>(null);
  useEffect(() => {
    if (!msg) return;
    const t = window.setTimeout(() => setMsg(null), 3500);
    return () => window.clearTimeout(t);
  }, [msg]);
  const node = (
    <div role="status" aria-live="polite" className="pointer-events-none">
      {msg && (
        <span key={msg.key} className="inline-flex items-center gap-2 rounded-full bg-ink px-4 py-2 text-sm font-semibold text-surface shadow-lg">
          {msg.text}
        </span>
      )}
    </div>
  );
  return [node, (text: string) => setMsg({ text, key: Date.now() })];
};
