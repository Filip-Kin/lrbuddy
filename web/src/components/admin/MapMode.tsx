import type { ReactNode } from "react";
import { Button } from "../Button.tsx";

/** Bar across the top of a map while it waits for taps, with the way out. */
export const MapMode = ({
  label,
  detail,
  onCancel,
  cancelLabel = "Cancel",
  action,
}: {
  label: string;
  detail?: ReactNode;
  onCancel: () => void;
  cancelLabel?: string;
  action?: ReactNode;
}) => (
  <div className="pointer-events-none absolute inset-x-2 top-2 z-[1000] flex justify-center">
    <div role="status" aria-live="polite" className="pointer-events-auto flex max-w-full flex-wrap items-center gap-2 rounded-2xl bg-bar py-1.5 pr-1.5 pl-4 text-bar-text shadow-lg">
      <span className="min-w-0 font-semibold">
        {label}
        {detail && <span className="ml-2 font-normal opacity-80">{detail}</span>}
      </span>
      <span className="flex gap-1.5">
        {action}
        <Button variant="secondary" size="sm" onClick={onCancel}>
          {cancelLabel}
        </Button>
      </span>
    </div>
  </div>
);
