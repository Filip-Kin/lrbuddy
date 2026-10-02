import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useLocation } from "wouter";
import { media } from "../lib/safe.ts";
import { Sheet } from "./Sheet.tsx";

/** The body loads with the access screens' chunk, so the request form does not weigh on every first paint. */
const SwitchBody = lazy(() => import("../pages/access/SwitchBody.tsx").then((m) => ({ default: m.SwitchBody })));

const wideQuery = media("(min-width: 860px)");
const useWide = (): boolean => useSyncExternalStore(wideQuery.subscribe, wideQuery.matches, () => false);

const Loading = () => <div className="h-48 animate-pulse rounded-2xl bg-surface-2" aria-busy="true" />;

/** Under the chip, inside the window. */
const Popover = ({ anchor, onClose }: { anchor: RefObject<HTMLElement | null>; onClose: () => void }) => {
  const panel = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useLayoutEffect(() => {
    const place = (): void => {
      const r = anchor.current?.getBoundingClientRect();
      if (!r) return;
      const width = Math.min(416, window.innerWidth - 16);
      setPos({ top: r.bottom + 8, left: Math.max(8, Math.min(r.left, window.innerWidth - width - 8)) });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [anchor]);

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") closeRef.current();
    };
    const onDown = (e: PointerEvent): void => {
      const t = e.target;
      if (!(t instanceof Node)) return;
      if (panel.current?.contains(t) || anchor.current?.contains(t)) return;
      closeRef.current();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown, true);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown, true);
      prev?.focus?.();
    };
  }, [anchor]);

  return createPortal(
    <div
      ref={panel}
      role="dialog"
      aria-label="Switch"
      tabIndex={-1}
      data-switch-popover
      className="fixed z-[2000] flex w-[min(26rem,calc(100vw-1rem))] flex-col rounded-2xl bg-surface text-ink shadow-xl outline-none ring-1 ring-line"
      style={{ top: pos?.top ?? 64, left: pos?.left ?? 8, maxHeight: `calc(100dvh - ${(pos?.top ?? 64) + 16}px)` }}
    >
      <h2 className="px-4 pt-3 pb-2 text-lg font-bold">Switch</h2>
      <div className="overflow-y-auto px-4 pb-4">
        <Suspense fallback={<Loading />}>
          <SwitchBody onDone={onClose} />
        </Suspense>
      </div>
    </div>,
    document.body,
  );
};

/**
 * The Switch control behind the header's scope chip (SPEC 27): a bottom sheet
 * on phones, a popover under the chip on laptops. Closes on a pick, Escape, a
 * tap outside and a route change.
 */
export const SwitchPanel = ({ open, onClose, anchor }: { open: boolean; onClose: () => void; anchor: RefObject<HTMLElement | null> }) => {
  const wide = useWide();
  const [loc] = useLocation();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    closeRef.current();
  }, [loc]);
  if (!open) return null;
  if (wide) return <Popover anchor={anchor} onClose={onClose} />;
  return (
    <Sheet open onClose={onClose} title="Switch">
      <Suspense fallback={<Loading />}>
        <SwitchBody onDone={onClose} />
      </Suspense>
    </Sheet>
  );
};
