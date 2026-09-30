import type { GreenTruck } from "./hooks.ts";

/** Qty over capacity per tracked item, with a bar. Low items carry the warn colour and a word. */
export const StockList = ({ stock, compact }: { stock: GreenTruck["stock"]; compact?: boolean }) => {
  const rows = stock.filter((s) => s.capacity > 0);
  if (rows.length === 0) return <p className="text-sm font-semibold text-muted">No tracked stock</p>;
  return (
    <ul className={compact ? "grid grid-cols-2 gap-x-4 gap-y-2" : "space-y-2"}>
      {rows.map((s) => {
        const pct = Math.max(0, Math.min(100, (s.qty / s.capacity) * 100));
        return (
          <li key={s.typeId} className="min-w-0">
            <div className="flex items-baseline justify-between gap-2 text-sm">
              <span className="truncate font-semibold">{s.label}</span>
              <span className={`shrink-0 tabular-nums ${s.low ? "font-bold" : "text-muted"}`}>
                {s.low && <span className="mr-1 text-xs font-bold uppercase">Low</span>}
                {s.qty}/{s.capacity}
              </span>
            </div>
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-2 ring-1 ring-inset ring-line" aria-hidden="true">
              <div className={`h-full rounded-full ${s.low ? "bg-warn" : "bg-brand-green"}`} style={{ width: `${pct}%` }} />
            </div>
          </li>
        );
      })}
    </ul>
  );
};
