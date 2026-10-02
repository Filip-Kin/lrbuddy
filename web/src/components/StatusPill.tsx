export type PillStatus =
  | "open"
  | "assigned"
  | "en_route"
  | "delivered"
  | "cancelled"
  | "lot_open"
  | "in_progress"
  | "done"
  | "do_not_touch"
  | "not_todo"
  | "idle"
  | "delivering"
  | "returning"
  | "offline"
  | "low"
  | "urgent"
  | "pending"
  | "approved"
  | "denied";

type Tone = "crew" | "green" | "warn" | "brand" | "plain" | "muted" | "outline";

/** Tinted tones carry the colour in a dot and a 15 % wash; text stays ink so contrast holds. */
const TONE: Record<Tone, { pill: string; dot: string | null }> = {
  crew: { pill: "bg-crew/15 text-ink", dot: "bg-crew" },
  green: { pill: "bg-brand-green/15 text-ink", dot: "bg-brand-green" },
  warn: { pill: "bg-warn/15 text-ink", dot: "bg-warn" },
  brand: { pill: "bg-brand text-on-brand", dot: null },
  plain: { pill: "bg-surface-2 text-ink ring-1 ring-inset ring-line", dot: null },
  muted: { pill: "bg-surface-2 text-muted", dot: null },
  outline: { pill: "bg-surface text-ink ring-1 ring-inset ring-line", dot: null },
};

const STATUS: Record<PillStatus, { label: string; tone: Tone }> = {
  open: { label: "Open", tone: "crew" },
  assigned: { label: "Assigned", tone: "plain" },
  en_route: { label: "En route", tone: "brand" },
  delivered: { label: "Delivered", tone: "green" },
  cancelled: { label: "Cancelled", tone: "muted" },
  lot_open: { label: "Todo", tone: "crew" },
  in_progress: { label: "In progress", tone: "brand" },
  done: { label: "Done", tone: "green" },
  do_not_touch: { label: "Do not touch", tone: "warn" },
  not_todo: { label: "Not todo", tone: "outline" },
  idle: { label: "Idle", tone: "plain" },
  delivering: { label: "Delivering", tone: "green" },
  returning: { label: "Returning", tone: "brand" },
  offline: { label: "Offline", tone: "muted" },
  low: { label: "Low stock", tone: "warn" },
  urgent: { label: "Urgent", tone: "crew" },
  pending: { label: "Pending", tone: "brand" },
  approved: { label: "Approved", tone: "green" },
  denied: { label: "Denied", tone: "muted" },
};

/** Lot statuses share keys with request statuses; `open` means a different thing for each. */
export const lotPill = (s: "open" | "in_progress" | "done" | "do_not_touch" | "not_todo"): PillStatus => (s === "open" ? "lot_open" : s);

export const StatusPill = ({ status, label, className = "" }: { status: PillStatus; label?: string; className?: string }) => {
  const tone = TONE[STATUS[status].tone];
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold ${tone.pill} ${className}`}>
      {tone.dot && <span aria-hidden="true" className={`h-2 w-2 rounded-full ${tone.dot}`} />}
      {label ?? STATUS[status].label}
    </span>
  );
};
