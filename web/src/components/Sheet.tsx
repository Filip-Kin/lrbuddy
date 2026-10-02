import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * Bottom sheet on phones, centred dialog from 640 px. Closes on Escape and
 * on a scrim tap. Focus moves into the sheet and back out on close.
 */
export const Sheet = ({
  open,
  onClose,
  title,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
}) => {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  // Parents pass a new onClose on every render. Read it through a ref so a re-render (a GPS
  // fix, a live refetch, a keystroke in the parent's state) does not re-run the focus effect,
  // which pulled focus out of the field being typed in and closed the phone keyboard.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") closeRef.current();
    };
    document.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panel.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      prev?.focus?.();
    };
  }, [open]);

  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-[2000] flex items-end justify-center sm:items-center">
      <div data-scrim className="absolute inset-0 bg-black/50" onClick={onClose} aria-hidden="true" />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="relative flex max-h-[90dvh] w-full flex-col rounded-t-3xl bg-surface text-ink shadow-xl outline-none ring-1 ring-line sm:max-w-lg sm:rounded-3xl"
      >
        <div className="flex items-center justify-between gap-3 px-5 pt-4 pb-2">
          <h2 id={titleId} className="text-lg font-bold">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="grid h-11 w-11 place-items-center rounded-full text-muted hover:bg-surface-2"
          >
            <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        <div className="overflow-y-auto px-5 pb-[max(1rem,env(safe-area-inset-bottom))]">{children}</div>
        {footer && <div className="border-t border-line px-5 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
};
