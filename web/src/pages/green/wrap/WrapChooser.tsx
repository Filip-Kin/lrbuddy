import { useEffect, useRef } from "react";
import { Sheet } from "../../../components/Sheet.tsx";
import type { LotStatus } from "../../../lib/lotStatus.ts";

export type WrapChoice = "done" | "not_done";

/**
 * Wrap up's tap on a lot (SPEC 28): Done or Not done, nothing else, with Details for the full lot
 * sheet and its photos. The address is the heading. The lot's current choice is marked.
 */
export const WrapChooser = ({
  title,
  status,
  open,
  onChoose,
  onDetails,
  onClose,
}: {
  title: string;
  status: LotStatus | null;
  open: boolean;
  onChoose: (s: WrapChoice) => void;
  onDetails: () => void;
  onClose: () => void;
}) => (
  <Sheet open={open} onClose={onClose} title={title}>
    <div data-wrap-chooser className="space-y-3 pb-1">
      <div className="grid grid-cols-2 gap-3">
        <button
          type="button"
          aria-pressed={status === "done"}
          data-choose="done"
          onClick={() => onChoose("done")}
          className={`flex min-h-24 items-center justify-center rounded-2xl bg-brand-green/20 px-3 text-xl font-bold text-ink ring-inset active:brightness-95 ${status === "done" ? "ring-4 ring-brand-green" : "ring-2 ring-brand-green"}`}
        >
          Done
        </button>
        <button
          type="button"
          aria-pressed={status === "not_done"}
          data-choose="not_done"
          onClick={() => onChoose("not_done")}
          className={`flex min-h-24 items-center justify-center rounded-2xl bg-not-done/20 px-3 text-xl font-bold text-ink ring-inset active:brightness-95 ${status === "not_done" ? "ring-4 ring-not-done" : "ring-2 ring-not-done"}`}
        >
          Not done
        </button>
      </div>
      <button type="button" data-wrap-details onClick={onDetails} className="mx-auto block min-h-11 px-4 text-sm font-semibold text-muted underline underline-offset-4">
        Details
      </button>
    </div>
  </Sheet>
);

/**
 * The phone's Back closes an overlay instead of leaving the page: one history entry while `open`,
 * taken back off when the overlay closes some other way.
 */
export const useBackCloses = (open: boolean, onClose: () => void): void => {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!open) return;
    window.history.pushState({ lrbOverlay: true }, "");
    let popped = false;
    const onPop = (): void => {
      popped = true;
      close.current();
    };
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      const st: unknown = window.history.state;
      if (!popped && typeof st === "object" && st !== null && "lrbOverlay" in st) window.history.back();
    };
  }, [open]);
};
