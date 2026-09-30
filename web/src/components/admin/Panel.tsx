import type { ReactNode } from "react";

/** A titled section card. The title row carries the section's actions. */
export const Panel = ({
  title,
  actions,
  children,
  className = "",
  flush,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  /** No inner padding, for lists and tables that run edge to edge. */
  flush?: boolean;
}) => (
  <section className={`overflow-hidden rounded-2xl bg-surface ring-1 ring-line ${className}`}>
    {(title || actions) && (
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
        {title && <h2 className="min-w-0 text-base font-bold">{title}</h2>}
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    )}
    <div className={flush ? "" : "p-4"}>{children}</div>
  </section>
);

/** Quiet loading block: grey bars in the shape of the content. */
export const Skeleton = ({ rows = 3, className = "" }: { rows?: number; className?: string }) => (
  <div className={`space-y-3 ${className}`} aria-busy="true" aria-label="Loading">
    {Array.from({ length: rows }, (_, i) => (
      <div key={i} className="h-14 animate-pulse rounded-2xl bg-surface-2" />
    ))}
  </div>
);

/** A number over a label, for count strips. */
export const Stat = ({ value, label, tone }: { value: number | string; label: string; tone?: "brand" | "green" | "warn" | "crew" | "muted" }) => {
  const dot =
    tone === "brand" ? "bg-brand" : tone === "green" ? "bg-brand-green" : tone === "warn" ? "bg-warn" : tone === "crew" ? "bg-crew" : tone === "muted" ? "bg-muted" : null;
  return (
    <div className="min-w-0 rounded-xl bg-surface-2 px-3 py-2">
      <div className="text-xl font-bold tabular-nums">{typeof value === "number" ? value.toLocaleString("en-US") : value}</div>
      <div className="flex items-center gap-1.5 truncate text-sm text-muted">
        {dot && <span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-full ${dot}`} />}
        {label}
      </div>
    </div>
  );
};
