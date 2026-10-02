import type { Map as LeafletMap } from "leaflet";
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { errorText } from "../lib/errors.ts";
import { STATUS_LABEL, STATUS_ORDER, type LotStatus } from "../lib/lotStatus.ts";
import { candidates, type Candidate, type PaintTarget } from "../lib/map/paintHit.ts";
import { usePaintStroke } from "../lib/map/paintStroke.ts";
import { trpc } from "../lib/trpc.ts";
import { Button } from "./Button.tsx";
import { FilterSelect } from "./green/ui.tsx";

// #region brush
/** `toggle` is the Flag map's brush (SPEC 22): Todo to Not todo, Not todo or bare to Todo. */
export type BrushKey = LotStatus | "crew" | "toggle";

/** The brush colour: the SPEC 21 status colours, ink for Crew, Todo's for the toggle. */
export const BRUSH_COLOR: Record<BrushKey, string> = {
  not_todo: "var(--muted)",
  open: "var(--crew)",
  in_progress: "var(--brand)",
  done: "var(--brand-green)",
  not_done: "var(--not-done)",
  do_not_touch: "var(--warn)",
  crew: "var(--ink)",
  toggle: "var(--crew)",
};

/** The status the toggle brush gives a parcel, or null where it leaves it (server `toggled`). */
export const toggled = (status: LotStatus | null): LotStatus | null => (status === "open" ? "not_todo" : status === null || status === "not_todo" ? "open" : null);

export const plural = (n: number): string => `${n.toLocaleString("en-US")} ${n === 1 ? "lot" : "lots"}`;
// #endregion

// #region state
export type PaintScope = { kind: "green" } | { kind: "admin"; ccId: number | null };

/**
 * Paint mode state for one map (SPEC 23): the brush, the stroke in progress,
 * the session total, Undo, and pending colours keyed like `useSetLot`'s so
 * the map shows a stroke at once and goes back to the server's answer after
 * the refetch.
 */
export const usePaint = (map: LeafletMap | null, scope: PaintScope, targets: readonly PaintTarget[]) => {
  const utils = trpc.useUtils();
  const [on, setOn] = useState(false);
  const [brush, setBrush] = useState<BrushKey>("open");
  const [crewId, setCrewId] = useState<number | null>(null);
  const [stroke, setStroke] = useState(0);
  const [total, setTotal] = useState(0);
  const [pending, setPending] = useState<ReadonlyMap<string, LotStatus>>(() => new Map());
  const [error, setError] = useState<string | null>(null);
  const greenPaint = trpc.green.paint.useMutation();
  const greenUndo = trpc.green.paintUndo.useMutation();
  const adminPaint = trpc.admin.lots.paint.useMutation();
  const adminUndo = trpc.admin.lots.paintUndo.useMutation();
  const adminCc = scope.kind === "admin" ? scope.ccId : null;
  const greenState = trpc.green.paintState.useQuery(undefined, { enabled: on && scope.kind === "green" });
  const adminState = trpc.admin.lots.paintState.useQuery({ ccId: adminCc ?? 0 }, { enabled: on && adminCc !== null });
  const [strokesOverride, setStrokes] = useState<number | null>(null);
  const strokes = strokesOverride ?? (scope.kind === "green" ? greenState.data?.strokes : adminState.data?.strokes) ?? 0;

  const refetch = useCallback(async (): Promise<void> => {
    // The driver map of a green shirt driving (SPEC 27) paints through green and draws from driver.lots.
    if (scope.kind === "green") await Promise.all([utils.green.invalidate(), utils.driver.lots.invalidate()]);
    else await Promise.all([utils.admin.lots.invalidate(), utils.admin.overview.invalidate()]);
  }, [scope.kind, utils]);

  // A stroke not yet back from the server counts as done, so the next stroke (the toggle brush
  // above all) sees each parcel's new status.
  const cands = useMemo(() => candidates(pending.size === 0 ? targets : targets.map((t) => (pending.has(t.key) ? { ...t, status: pending.get(t.key) ?? t.status } : t))), [targets, pending]);
  const statusOf = useCallback((c: Candidate): LotStatus | null => (brush === "crew" ? null : brush === "toggle" ? toggled(c.status) : brush), [brush]);
  const skip = useCallback(
    (c: Candidate): boolean => {
      if (brush === "crew") return crewId === null || c.lotId === null || c.status === "not_todo" || c.crewId === crewId;
      if (brush === "toggle") return toggled(c.status) === null;
      return (c.status ?? "not_todo") === brush;
    },
    [brush, crewId],
  );

  const onStroke = useCallback(
    (hits: Candidate[]): void => {
      setError(null);
      const keys = hits.map((h) => h.key);
      const painted = hits.flatMap((h) => {
        const st = statusOf(h);
        return st ? [[h.key, st] as const] : [];
      });
      if (painted.length > 0) {
        setPending((m) => {
          const next = new Map(m);
          for (const [k, st] of painted) next.set(k, st);
          return next;
        });
      }
      const drop = (): void =>
        setPending((m) => {
          const next = new Map(m);
          for (const k of keys) next.delete(k);
          return next;
        });
      const lotIds = hits.flatMap((h) => (h.lotId !== null ? [h.lotId] : []));
      const parcelIds = hits.flatMap((h) => (h.lotId === null && h.parcelId ? [h.parcelId] : []));
      const b = brush === "crew" ? { kind: "crew" as const, crewId: crewId ?? 0 } : brush === "toggle" ? { kind: "toggle" as const } : { kind: "status" as const, status: brush };
      const done = {
        onSuccess: (r: { changed: number; refused: number; strokes: number }) => {
          setStroke(r.changed);
          setTotal((t) => t + r.changed);
          setStrokes(r.strokes);
          if (r.refused > 0) setError(`${plural(r.refused)} not allowed`);
          void refetch().then(drop);
        },
        onError: (err: unknown) => {
          drop();
          setStroke(0);
          setError(errorText(err, "Not saved. Check signal and paint again."));
        },
      };
      if (scope.kind === "green") greenPaint.mutate({ brush: b, lotIds, parcelIds }, done);
      else if (scope.ccId !== null) adminPaint.mutate({ ccId: scope.ccId, brush: b, lotIds, parcelIds }, done);
    },
    [statusOf, brush, crewId, scope, greenPaint, adminPaint, refetch],
  );

  const { zoomOk } = usePaintStroke(map, { on: on && (scope.kind === "green" || scope.ccId !== null), targets: cands, statusOf, skip, onCount: setStroke, onStroke });

  const undo = (): void => {
    setError(null);
    const done = {
      onSuccess: (r: { restored: number; strokes: number }) => {
        setStrokes(r.strokes);
        setStroke(0);
        setTotal((t) => Math.max(0, t - r.restored));
        void refetch();
      },
      onError: (err: unknown) => setError(errorText(err, "Undo not saved. Try again.")),
    };
    if (scope.kind === "green") greenUndo.mutate(undefined, done);
    else if (scope.ccId !== null) adminUndo.mutate({ ccId: scope.ccId }, done);
  };

  /** Opens Paint, on `start` when given (the Flag map opens on the toggle brush). */
  const open = (start?: BrushKey): void => {
    if (start) setBrush(start);
    setStroke(0);
    setTotal(0);
    setError(null);
    setStrokes(null);
    setOn(true);
  };
  const close = (): void => {
    setOn(false);
    setStrokes(null);
  };

  return {
    on,
    open,
    close,
    brush,
    setBrush,
    crewId,
    setCrewId,
    stroke,
    total,
    strokes,
    zoomOk,
    pending,
    error,
    undo,
    busy: greenPaint.isPending || adminPaint.isPending,
    undoBusy: greenUndo.isPending || adminUndo.isPending,
  };
};
export type PaintState = ReturnType<typeof usePaint>;
// #endregion

// #region UI
export const PaintIcon = () => (
  <svg viewBox="0 0 24 24" width={22} height={22} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M18 3l3 3-9 9-4 1 1-4z" />
    <path d="M7 17c-2 0-3 1.5-3 4 2.5 0 4-1 4-3" />
  </svg>
);

export const UndoIcon = () => (
  <svg viewBox="0 0 24 24" width={20} height={20} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9 14L4 9l5-5" />
    <path d="M4 9h11a5 5 0 010 10h-3" />
  </svg>
);

const Swatch = ({ brush }: { brush: BrushKey }) =>
  brush === "crew" ? (
    <svg viewBox="0 0 24 24" width={16} height={16} aria-hidden="true" className="shrink-0">
      <circle cx="12" cy="8" r="4" fill="currentColor" />
      <path d="M4 21c0-4.5 3.5-7 8-7s8 2.5 8 7z" fill="currentColor" />
    </svg>
  ) : (
    <span
      aria-hidden="true"
      className="h-3.5 w-3.5 shrink-0 rounded-[3px] ring-2 ring-inset"
      style={{ background: brush === "not_todo" ? "transparent" : `color-mix(in srgb, ${BRUSH_COLOR[brush]} 35%, transparent)`, ["--tw-ring-color" as string]: BRUSH_COLOR[brush] }}
    />
  );

/** A thin border round the map in the brush colour while Paint is on. */
export const PaintFrame = ({ paint }: { paint: PaintState }) =>
  paint.on ? (
    <div aria-hidden="true" data-paint-frame className="pointer-events-none absolute inset-0 z-[950] border-[3px]" style={{ borderColor: BRUSH_COLOR[paint.brush] }} />
  ) : null;

/**
 * The brush bar along the bottom of the map: Undo, the counter and Done, then
 * the six statuses (and Crew on the green map) as chips: two rows on a phone. `extra` holds a
 * picker the page needs (the admin map's CC).
 */
export const PaintBar = ({
  paint,
  crews,
  extra,
  onDone,
}: {
  paint: PaintState;
  /** Done does this instead of closing Paint (Wrap up's full-screen map collapses). */
  onDone?: () => void;
  /** Crews for the Crew brush; leave out for no Crew brush. */
  crews?: ReadonlyArray<{ id: number; name: string }>;
  extra?: ReactNode;
}) => {
  if (!paint.on) return null;
  const brushes: Array<LotStatus | "crew"> = crews ? [...STATUS_ORDER, "crew"] : [...STATUS_ORDER];
  const off = !paint.zoomOk;
  return (
    <div
      data-paint-bar
      className="absolute inset-x-0 bottom-0 z-[1000] space-y-2 rounded-t-2xl bg-surface px-3 pt-2.5 pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-[0_-4px_16px_rgb(0_0_0/0.18)] ring-1 ring-line"
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
        <Button size="md" data-paint-exit onClick={onDone ?? paint.close}>
          Done
        </Button>
      </div>
      <div role="radiogroup" aria-label="Brush" className={`grid gap-1.5 ${crews ? "grid-cols-4 sm:grid-cols-7" : "grid-cols-3 sm:grid-cols-6"}`}>
        {brushes.map((b) => {
          const active = paint.brush === b;
          return (
            <button
              key={b}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={off}
              data-brush={b}
              onClick={() => {
                paint.setBrush(b);
                if (b === "crew" && paint.crewId === null && crews?.[0]) paint.setCrewId(crews[0].id);
              }}
              className={`flex min-h-11 min-w-0 touch-manipulation items-center justify-center gap-1 rounded-xl px-1 text-[13px] leading-tight font-semibold sm:gap-1.5 sm:text-sm text-ink ring-inset transition-colors disabled:opacity-45 ${
                active ? "bg-surface-2 ring-[3px]" : "bg-surface ring-1 ring-line"
              }`}
              style={active ? { ["--tw-ring-color" as string]: BRUSH_COLOR[b] } : undefined}
            >
              <Swatch brush={b} />
              <span className="text-center break-words">{b === "crew" ? "Crew" : STATUS_LABEL[b]}</span>
            </button>
          );
        })}
      </div>
      {crews && paint.brush === "crew" && (
        <FilterSelect label="Crew" value={paint.crewId ?? ""} onChange={(e) => paint.setCrewId(Number(e.target.value))} className="w-full">
          {crews.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </FilterSelect>
      )}
      {extra}
      {paint.error && (
        <p role="alert" className="text-center text-sm font-semibold">
          {paint.error}
        </p>
      )}
    </div>
  );
};
// #endregion
