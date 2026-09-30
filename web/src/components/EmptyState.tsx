import type { ReactNode } from "react";

/** Title names what is missing; the action answers it. */
export const EmptyState = ({ title, description, action, icon }: { title: string; description?: string; action?: ReactNode; icon?: ReactNode }) => (
  <div className="mx-auto flex max-w-sm flex-col items-center px-6 py-16 text-center">
    {icon && <div className="mb-4 text-muted">{icon}</div>}
    <h2 className="text-lg font-semibold text-ink">{title}</h2>
    {description && <p className="mt-1 text-sm text-muted">{description}</p>}
    {action && <div className="mt-6">{action}</div>}
  </div>
);
