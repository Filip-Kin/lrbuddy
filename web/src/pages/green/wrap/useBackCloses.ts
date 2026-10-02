import { useEffect, useRef } from "react";

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
