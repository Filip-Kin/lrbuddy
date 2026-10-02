import { Button } from "../../../components/Button.tsx";
import { plural, UndoIcon, type PaintState } from "../../../components/PaintBar.tsx";

/**
 * The Flag map's paint bar (SPEC 22): Undo, the stroke counter and one
 * Do not touch switch. Off, the brush is the toggle (Todo and Not todo swap);
 * on, it paints Do not touch. No Done: Collapse ends paint.
 */
export const FlagPaintBar = ({ paint }: { paint: PaintState }) => {
  if (!paint.on) return null;
  const dnt = paint.brush === "do_not_touch";
  const off = !paint.zoomOk;
  return (
    <div
      data-paint-bar
      className="absolute inset-x-0 bottom-0 z-[1000] space-y-2 rounded-t-2xl bg-surface px-3 pt-2.5 pb-[max(0.75rem,env(safe-area-inset-bottom))] text-ink shadow-[0_-4px_16px_rgb(0_0_0/0.18)] ring-1 ring-line"
    >
      <div className="flex items-center gap-2">
        <Button variant="secondary" size="md" data-paint-undo disabled={paint.strokes === 0} busy={paint.undoBusy} onClick={paint.undo}>
          <UndoIcon />
          Undo
        </Button>
        <div role="status" aria-live="polite" className="min-w-0 flex-1 text-center leading-tight">
          {off ? (
            <span data-paint-zoom className="font-semibold">
              Zoom in to paint
            </span>
          ) : (
            <>
              <span data-paint-count className="block text-lg font-bold tabular-nums">
                {plural(paint.stroke)}
              </span>
              <span data-paint-total className="block text-xs text-muted tabular-nums">
                {paint.total.toLocaleString("en-US")} total
              </span>
            </>
          )}
        </div>
        <button
          type="button"
          aria-pressed={dnt}
          disabled={off}
          onClick={() => paint.setBrush(dnt ? "toggle" : "do_not_touch")}
          className={`flex min-h-11 shrink-0 touch-manipulation items-center gap-1.5 rounded-xl px-3 text-sm leading-tight font-semibold text-ink ring-inset transition-colors disabled:opacity-45 ${
            dnt ? "bg-surface-2 ring-[3px] ring-warn" : "bg-surface ring-1 ring-line"
          }`}
          data-flag-dnt-brush
        >
          <span aria-hidden="true" className="h-3.5 w-3.5 shrink-0 rounded-[3px] ring-2 ring-inset ring-warn" style={{ background: "color-mix(in srgb, var(--warn) 35%, transparent)" }} />
          Do not touch
        </button>
      </div>
      {paint.error && (
        <p role="alert" className="text-center text-sm font-semibold">
          {paint.error}
        </p>
      )}
    </div>
  );
};
