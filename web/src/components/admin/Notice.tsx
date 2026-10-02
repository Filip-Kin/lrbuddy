import { useEffect, useRef } from "react";

export type NoticeValue = { tone: "ok" | "error"; text: string } | null;

/**
 * Result line after an action ("142 added"). Lives in a polite live region so
 * screen readers hear it; clears itself after a while when it is good news.
 */
export const Notice = ({ value, onClear }: { value: NoticeValue; onClear: () => void }) => {
  // An inline onClear is new on every parent render; a ref keeps a re-render from restarting the timer.
  const clear = useRef(onClear);
  clear.current = onClear;
  useEffect(() => {
    if (!value || value.tone === "error") return;
    const t = setTimeout(() => clear.current(), 6000);
    return () => clearTimeout(t);
  }, [value]);
  return (
    <div role="status" aria-live="polite" className="empty:hidden">
      {value && (
        <div
          className={`flex items-center justify-between gap-3 rounded-xl px-4 py-2 text-sm font-semibold ${
            value.tone === "ok" ? "bg-brand-green/15" : "bg-crew/15"
          }`}
        >
          <span className="flex min-w-0 items-center gap-2">
            <span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-full ${value.tone === "ok" ? "bg-brand-green" : "bg-crew"}`} />
            <span className="min-w-0 break-words">{value.text}</span>
          </span>
          <button type="button" onClick={onClear} aria-label="Dismiss" className="-mr-2 grid h-10 w-10 shrink-0 place-items-center rounded-full hover:bg-surface-2">
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      )}
    </div>
  );
};

export { errorText } from "../../lib/errors.ts";
