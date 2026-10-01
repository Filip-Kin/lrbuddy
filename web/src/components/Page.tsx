import type { ReactNode } from "react";

/**
 * Standard scrolling page body with a title row. `full` drops the width cap
 * for the planning portal, whose map pages use the whole screen.
 */
export const Page = ({ title, actions, children, wide, full }: { title: string; actions?: ReactNode; children: ReactNode; wide?: boolean; full?: boolean }) => (
  <div className={full ? "w-full px-4 py-4 nav:px-6 nav:py-5" : `mx-auto w-full ${wide ? "max-w-6xl" : "max-w-2xl"} px-4 py-4 nav:px-6 nav:py-6`}>
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
      <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
    {children}
  </div>
);
