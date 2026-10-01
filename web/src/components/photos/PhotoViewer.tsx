import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { errorText } from "../../lib/errors.ts";
import { dateTime } from "../../lib/format.ts";
import { KIND_LABEL, photoUrl, useInvalidatePhotos } from "../../lib/photos.ts";
import { trpc, type RouterOutputs } from "../../lib/trpc.ts";
import { CloseIcon, NextIcon, PrevIcon, TrashIcon } from "./icons.tsx";

type Photo = RouterOutputs["shared"]["lotPhotos"]["photos"][number];

const MAX_ZOOM = 5;
const SWIPE_PX = 60;
const ROLE_LABEL: Record<Photo["role"], string> = { crew: "Crew", driver: "Driver", green: "Green shirt", admin: "Admin" };

/**
 * Older befores, the newest before, the newest after, older afters: the pair
 * sits in the middle, one swipe apart, and history runs out to either end.
 */
export const viewerOrder = (photos: readonly Photo[]): Photo[] => {
  const newestFirst = [...photos].sort((a, b) => b.at - a.at || b.id - a.id);
  const before = newestFirst.filter((p) => p.kind === "before").reverse();
  const after = newestFirst.filter((p) => p.kind === "after");
  return [...before, ...after];
};

interface Zoom {
  s: number;
  x: number;
  y: number;
}
const NO_ZOOM: Zoom = { s: 1, x: 0, y: 0 };

/**
 * Full-screen photo viewer for one lot: swipe or arrows between photos, pinch
 * or double tap to zoom, drag to pan when zoomed. Escape closes. Taken-by and
 * time at the foot, with Delete where the server allows it.
 */
export const PhotoViewer = ({ lotId, startId, onClose }: { lotId: number; startId: number; onClose: () => void }) => {
  const q = trpc.shared.lotPhotos.useQuery({ lotId });
  const refresh = useInvalidatePhotos();
  const slides = useMemo(() => viewerOrder(q.data?.photos ?? []), [q.data]);
  const [index, setIndex] = useState<number | null>(null);
  const [zoom, setZoom] = useState<Zoom>(NO_ZOOM);
  const [dragX, setDragX] = useState(0);
  const [gesture, setGesture] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<Record<number, boolean>>({});
  const stage = useRef<HTMLDivElement>(null);
  const closeBtn = useRef<HTMLButtonElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const start = useRef<{ zoom: Zoom; dist: number; mid: { x: number; y: number }; at: { x: number; y: number } } | null>(null);
  const lastTap = useRef<{ t: number; x: number; y: number } | null>(null);

  // First load: start at the photo that was tapped.
  useEffect(() => {
    if (index === null && slides.length > 0) {
      const i = slides.findIndex((p) => p.id === startId);
      setIndex(i < 0 ? 0 : i);
    }
  }, [slides, startId, index]);

  const i = index === null ? 0 : Math.min(index, Math.max(0, slides.length - 1));
  const photo: Photo | undefined = slides[i];

  const go = useCallback(
    (step: number) => {
      setIndex((cur) => {
        const n = Math.min(Math.max(0, (cur ?? 0) + step), Math.max(0, slides.length - 1));
        return n;
      });
      setZoom(NO_ZOOM);
      setConfirm(false);
      setErr(null);
    },
    [slides.length],
  );

  // Latest handlers for the one window listener, so it is added once and focus moves once.
  const keys = useRef({ onClose, go });
  keys.current = { onClose, go };
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    closeBtn.current?.focus();
    // Capture on window so a lot sheet underneath does not close on the same Escape.
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.stopPropagation();
        keys.current.onClose();
      } else if (e.key === "ArrowLeft") keys.current.go(-1);
      else if (e.key === "ArrowRight") keys.current.go(1);
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      prev?.focus?.();
    };
  }, []);

  const del = trpc.shared.deletePhoto.useMutation({
    onSuccess: () => {
      setConfirm(false);
      refresh();
      if (slides.length <= 1) onClose();
      else setIndex((cur) => Math.max(0, Math.min(cur ?? 0, slides.length - 2)));
    },
    onError: (e) => setErr(errorText(e, "Not deleted. Try again.")),
  });

  // #region gestures
  const center = (): { x: number; y: number } => {
    const r = stage.current?.getBoundingClientRect();
    return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : { x: 0, y: 0 };
  };

  const clampZoom = (z: Zoom): Zoom => {
    const r = stage.current?.getBoundingClientRect();
    if (!r || z.s <= 1) return NO_ZOOM;
    const mx = ((z.s - 1) * r.width) / 2;
    const my = ((z.s - 1) * r.height) / 2;
    return { s: z.s, x: Math.max(-mx, Math.min(mx, z.x)), y: Math.max(-my, Math.min(my, z.y)) };
  };

  /** Zoom to `s`, keeping the screen point `p` where it is. */
  const zoomAt = (from: Zoom, s: number, p: { x: number; y: number }, to = p): Zoom => {
    const c = center();
    const lx = (p.x - c.x - from.x) / from.s;
    const ly = (p.y - c.y - from.y) / from.s;
    return clampZoom({ s, x: to.x - c.x - s * lx, y: to.y - c.y - s * ly });
  };

  const begin = (): void => {
    const pts = [...pointers.current.values()];
    if (pts.length === 0) {
      start.current = null;
      return;
    }
    const a = pts[0]!;
    const b = pts[1] ?? a;
    start.current = {
      zoom,
      dist: Math.hypot(a.x - b.x, a.y - b.y),
      mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      at: a,
    };
  };

  const onDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if ((e.target as HTMLElement).closest("button")) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    setGesture(true);
    begin();
  };

  const onMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (!pointers.current.has(e.pointerId) || !start.current) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const pts = [...pointers.current.values()];
    const st = start.current;
    if (pts.length >= 2) {
      const a = pts[0]!;
      const b = pts[1]!;
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const s = Math.min(MAX_ZOOM, Math.max(1, st.zoom.s * (st.dist > 0 ? dist / st.dist : 1)));
      setZoom(zoomAt(st.zoom, s, st.mid, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }));
      setDragX(0);
      return;
    }
    const p = pts[0]!;
    if (st.zoom.s > 1) setZoom(clampZoom({ s: st.zoom.s, x: st.zoom.x + p.x - st.at.x, y: st.zoom.y + p.y - st.at.y }));
    else setDragX(p.x - st.at.x);
  };

  const onUp = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (!pointers.current.has(e.pointerId)) return;
    const st = start.current;
    pointers.current.delete(e.pointerId);
    if (pointers.current.size > 0) {
      // A finger stays down after a pinch: pan from here.
      begin();
      return;
    }
    setGesture(false);
    const moved = st ? Math.hypot(e.clientX - st.at.x, e.clientY - st.at.y) : 0;
    if (zoom.s === 1 && Math.abs(dragX) > SWIPE_PX) go(dragX < 0 ? 1 : -1);
    setDragX(0);
    if (moved < 10 && e.pointerType !== "mouse") {
      const now = Date.now();
      const t = lastTap.current;
      if (t && now - t.t < 320 && Math.hypot(e.clientX - t.x, e.clientY - t.y) < 30) {
        setZoom(zoom.s > 1 ? NO_ZOOM : zoomAt(zoom, 2.5, { x: e.clientX, y: e.clientY }));
        lastTap.current = null;
      } else lastTap.current = { t: now, x: e.clientX, y: e.clientY };
    }
    start.current = null;
  };
  // #endregion

  // "1 of 3" counts within the kind, newest first.
  const sameKind = photo ? slides.filter((p) => p.kind === photo.kind) : [];
  const pos = photo ? sameKind.indexOf(photo) : -1;
  const nOf = photo && sameKind.length > 1 ? `${photo.kind === "before" ? sameKind.length - pos : pos + 1} of ${sameKind.length}` : null;

  return createPortal(
    <div
      data-viewer
      role="dialog"
      aria-modal="true"
      aria-label={q.data?.lot.address ? `Photos, ${q.data.lot.address}` : "Photos"}
      className="fixed inset-0 z-[2100] flex h-[100dvh] flex-col bg-black text-white pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)]"
    >
      <div className="flex min-h-14 items-center gap-2 px-2">
        <button ref={closeBtn} type="button" onClick={onClose} aria-label="Close" className="grid h-11 w-11 shrink-0 place-items-center rounded-full hover:bg-white/10">
          <CloseIcon size={24} />
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="text-lg font-bold">{photo ? KIND_LABEL[photo.kind] : "Photos"}</span>
            {nOf && <span className="text-sm text-white/75 tabular-nums">{nOf}</span>}
          </div>
          {q.data?.lot.address && <div className="truncate text-sm text-white/75">{q.data.lot.address}</div>}
        </div>
      </div>

      <div
        ref={stage}
        className="relative min-h-0 flex-1 touch-none overflow-hidden select-none"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onDoubleClick={(e) => setZoom(zoom.s > 1 ? NO_ZOOM : zoomAt(zoom, 2.5, { x: e.clientX, y: e.clientY }))}
      >
        {q.isLoading && <div className="absolute inset-0 grid place-items-center text-white/75">Loading</div>}
        {q.isError && <div className="absolute inset-0 grid place-items-center font-semibold">Photos not loaded</div>}
        {photo && (
          <div
            className={`absolute inset-0 ${gesture ? "" : "transition-transform duration-200"}`}
            style={{ transform: `translate(${zoom.x + dragX}px, ${zoom.y}px) scale(${zoom.s})` }}
          >
            <img
              key={`t${photo.id}`}
              src={photoUrl(photo.id, true)}
              alt=""
              draggable={false}
              className={`absolute inset-0 h-full w-full object-contain ${loaded[photo.id] ? "invisible" : ""}`}
            />
            <img
              key={photo.id}
              src={photoUrl(photo.id)}
              alt={`${KIND_LABEL[photo.kind]} photo`}
              draggable={false}
              onLoad={() => setLoaded((m) => ({ ...m, [photo.id]: true }))}
              className="absolute inset-0 h-full w-full object-contain"
            />
          </div>
        )}
        {i > 0 && (
          <button
            type="button"
            onClick={() => go(-1)}
            aria-label="Previous photo"
            className="absolute top-1/2 left-2 grid h-12 w-12 -translate-y-1/2 place-items-center rounded-full bg-black/55 hover:bg-black/75"
          >
            <PrevIcon size={26} />
          </button>
        )}
        {i < slides.length - 1 && (
          <button
            type="button"
            onClick={() => go(1)}
            aria-label="Next photo"
            className="absolute top-1/2 right-2 grid h-12 w-12 -translate-y-1/2 place-items-center rounded-full bg-black/55 hover:bg-black/75"
          >
            <NextIcon size={26} />
          </button>
        )}
      </div>

      {photo && (
        <div className="flex min-h-16 flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2">
          <div className="min-w-0 flex-1 text-sm">
            <div className="truncate font-semibold">{photo.takenBy ?? ROLE_LABEL[photo.role]}</div>
            <div className="text-white/75">{dateTime(photo.at)}</div>
          </div>
          {err && (
            <p role="alert" className="w-full text-sm font-semibold sm:order-first sm:w-auto">
              {err}
            </p>
          )}
          {photo.canDelete &&
            (confirm ? (
              <div className="flex gap-2">
                <button type="button" onClick={() => setConfirm(false)} className="min-h-11 rounded-xl bg-white/15 px-4 font-semibold hover:bg-white/25">
                  Keep
                </button>
                <button
                  type="button"
                  disabled={del.isPending}
                  aria-busy={del.isPending || undefined}
                  onClick={() => del.mutate({ id: photo.id })}
                  className="min-h-11 rounded-xl bg-white px-4 font-semibold text-black ring-2 ring-inset ring-crew disabled:opacity-60"
                >
                  Delete photo
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirm(true)}
                className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-white/15 px-4 font-semibold hover:bg-white/25"
              >
                <TrashIcon size={18} />
                Delete
              </button>
            ))}
        </div>
      )}
    </div>,
    document.body,
  );
};
