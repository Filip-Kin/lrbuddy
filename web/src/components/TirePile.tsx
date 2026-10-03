import { useCallback, useState } from "react";
import { errorText } from "../lib/errors.ts";
import { ago, clock, mapsDirections } from "../lib/format.ts";
import { TIRE_SVG } from "../lib/map/markers.ts";
import type { MapMarker } from "../lib/map/MapView.tsx";
import { tirePhotoUrl, type TirePile, type TirePlacing } from "../lib/tires.ts";
import { trpc } from "../lib/trpc.ts";
import { Button, ButtonLink } from "./Button.tsx";
import { QtyStepper } from "./QtyStepper.tsx";
import { ConfirmSheet } from "./ConfirmSheet.tsx";
import { PhotoViewer } from "./photos/PhotoViewer.tsx";
import { Sheet } from "./Sheet.tsx";

/** The tire glyph the map draws, for buttons and the legend. */
export const TireGlyph = ({ size = 22 }: { size?: number }) => (
  <span aria-hidden="true" className="inline-grid shrink-0 place-items-center [&>svg]:h-full [&>svg]:w-full" style={{ width: size, height: size }} dangerouslySetInnerHTML={{ __html: TIRE_SVG }} />
);

// #region data
/** Add, move and delete, each refetching the list; errors as one label. */
export const useTireWrites = () => {
  const utils = trpc.useUtils();
  const refresh = useCallback(() => void utils.tires.list.invalidate(), [utils]);
  const [error, setError] = useState<string | null>(null);
  const onError = (e: unknown): void => setError(errorText(e));
  const add = trpc.tires.add.useMutation({ onSettled: refresh, onError, onSuccess: () => setError(null) });
  const move = trpc.tires.move.useMutation({ onSettled: refresh, onError, onSuccess: () => setError(null) });
  const remove = trpc.tires.remove.useMutation({ onSettled: refresh, onError, onSuccess: () => setError(null) });
  const setCount = trpc.tires.setCount.useMutation({ onSettled: refresh, onError, onSuccess: () => setError(null) });
  return { add, move, remove, setCount, error, clearError: () => setError(null) };
};

/**
 * Map markers for the piles, plus the pin of a pile being placed or moved (it stands in for the
 * pile it moves). A tap on a pile opens its sheet unless something is being placed.
 */
export const tireMarkers = (piles: readonly TirePile[] | undefined, placing: TirePlacing | null, onTap: (id: number) => void, onDrag: (lat: number, lng: number) => void): MapMarker[] => {
  const out: MapMarker[] = [];
  for (const p of piles ?? []) {
    if (placing?.mode === "move" && placing.id === p.id) continue;
    out.push({ id: `tire-${p.id}`, kind: "tire", lat: p.lat, lng: p.lng, noFit: true, title: "Tire pile", onClick: placing ? undefined : () => onTap(p.id) });
  }
  if (placing) out.push({ id: "pin", kind: "tire", pin: true, lat: placing.lat, lng: placing.lng, noFit: true, title: "Tire pile", onDragEnd: onDrag });
  return out;
};
// #endregion

/** A point `m` metres to the left or right of `heading` from `at`; `at` itself with no heading. */
export const besideRoad = (at: { lat: number; lng: number }, heading: number | null, side: "left" | "right", m = 8): { lat: number; lng: number } => {
  if (heading === null || !Number.isFinite(heading)) return at;
  const b = ((heading + (side === "left" ? -90 : 90)) * Math.PI) / 180;
  return { lat: at.lat + (Math.cos(b) * m) / 111_320, lng: at.lng + (Math.sin(b) * m) / (111_320 * Math.cos((at.lat * Math.PI) / 180)) };
};

/**
 * Tire pile from where the phone is (Filip, 2026-10-03: no Cancel/Save pin; count and side of the
 * road): the tire count, then Left or Right saves it 8 m to that side of the direction of travel.
 */
export const TireAddSheet = ({
  open,
  at,
  heading,
  onClose,
  onSaved,
}: {
  open: boolean;
  at: { lat: number; lng: number } | null;
  heading: number | null;
  onClose: () => void;
  onSaved?: (p: TirePile) => void;
}) => {
  const writes = useTireWrites();
  const [count, setCount] = useState(1);
  const save = (side: "left" | "right"): void => {
    if (!at) return;
    const p = besideRoad(at, heading, side);
    writes.add.mutate(
      { lat: p.lat, lng: p.lng, count, side },
      {
        onSuccess: (row) => {
          setCount(1);
          onSaved?.(row);
          onClose();
        },
      },
    );
  };
  return (
    <Sheet open={open} onClose={onClose} title="Tire pile">
      <div className="space-y-5 pb-2" data-tire-add-sheet>
        <div className="flex items-center justify-between gap-4">
          <span className="text-sm font-semibold">Tires</span>
          <QtyStepper value={count} onChange={setCount} max={999} label="Tires" />
        </div>
        {writes.error && (
          <p role="alert" className="text-sm font-semibold">
            {writes.error}
          </p>
        )}
        <div className="grid grid-cols-2 gap-3">
          {(["left", "right"] as const).map((side) => (
            <Button key={side} size="lg" className="min-h-20 text-xl" disabled={!at} busy={writes.add.isPending} onClick={() => save(side)} data-tire-side={side}>
              {side === "left" ? "Left" : "Right"}
            </Button>
          ))}
        </div>
      </div>
    </Sheet>
  );
};

/** The bar over the map while a pile is moved (green): its name, Cancel and Save. */
export const TirePlaceBar = ({ placing, busy, error, onCancel, onSave }: { placing: TirePlacing | null; busy: boolean; error: string | null; onCancel: () => void; onSave: () => void }) =>
  placing ? (
    <div className="pointer-events-none absolute inset-x-0 top-3 z-[1000] flex flex-col items-center gap-2 px-3" data-tire-place>
      <div className="pointer-events-auto flex max-w-full items-center gap-2 rounded-full bg-ink py-1 pr-1 pl-3 text-surface shadow-lg">
        <TireGlyph size={24} />
        <span className="truncate font-semibold">{placing.mode === "move" ? "Move tire pile" : "Tire pile"}</span>
        <button type="button" onClick={onCancel} className="min-h-10 shrink-0 rounded-full px-3 text-sm font-semibold text-surface ring-1 ring-surface/50">
          Cancel
        </button>
        <button type="button" onClick={onSave} disabled={busy} aria-busy={busy || undefined} className="min-h-10 shrink-0 rounded-full bg-brand px-4 text-sm font-bold text-on-brand disabled:opacity-60" data-tire-save>
          Save
        </button>
      </div>
      {error && (
        <p role="alert" className="pointer-events-auto rounded-full bg-surface px-3 py-1 text-sm font-semibold text-ink shadow">
          {error}
        </p>
      )}
    </div>
  ) : null;

/**
 * A pile's sheet: who made it and when, its photo (tap for full screen), and what this person may
 * do: Move (green), Delete (green, or the crew that made it). Drivers get Directions.
 */
export const TirePileSheet = ({
  pile,
  now,
  onClose,
  onMove,
  onDeleted,
  directions = false,
}: {
  pile: TirePile | null;
  now: number;
  onClose: () => void;
  onMove?: (p: TirePile) => void;
  onDeleted?: () => void;
  directions?: boolean;
}) => {
  const writes = useTireWrites();
  const [confirm, setConfirm] = useState(false);
  const [viewing, setViewing] = useState(false);
  const p = pile;
  const actions = p && ((onMove && p.canMove) || p.canDelete || directions);
  return (
    <>
      <Sheet open={p !== null && !confirm && !viewing} onClose={onClose} title="Tire pile">
        {p && (
          <div className="space-y-4 pb-2" data-tire-sheet={p.id}>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-base">
              <dt className="text-muted">Made by</dt>
              <dd className="min-w-0 font-semibold break-words" data-tire-by>
                {p.madeBy}
              </dd>
              <dt className="text-muted">Dropped</dt>
              <dd className="font-semibold tabular-nums">{`${clock(p.createdAt)}, ${ago(p.createdAt, now)}`}</dd>
              {p.side && (
                <>
                  <dt className="text-muted">Side</dt>
                  <dd className="font-semibold">{p.side === "left" ? "Left" : "Right"}</dd>
                </>
              )}
            </dl>
            <div className="flex items-center justify-between gap-4">
              <span className="text-sm font-semibold">Tires</span>
              {p.canDelete ? (
                <QtyStepper value={p.count ?? 1} onChange={(n) => writes.setCount.mutate({ id: p.id, count: n })} max={999} label="Tires" />
              ) : (
                <span className="text-lg font-bold tabular-nums" data-tire-count>
                  {p.count ?? "–"}
                </span>
              )}
            </div>
            {p.photoAt !== null ? (
              <button
                type="button"
                onClick={() => setViewing(true)}
                aria-label="Tire pile photo"
                className="relative block aspect-[4/3] w-full overflow-hidden rounded-2xl bg-surface-2 ring-1 ring-line"
                data-tire-photo
              >
                <img src={tirePhotoUrl(p, true)} alt="" className="h-full w-full object-cover" />
                <span className="absolute top-1.5 left-1.5 rounded-full bg-black/65 px-2 py-0.5 text-xs font-semibold text-white">{`Photo, ${clock(p.photoAt)}`}</span>
              </button>
            ) : (
              <div className="grid min-h-16 place-items-center rounded-2xl border-2 border-dashed border-line text-sm font-semibold text-muted" data-tire-no-photo>
                No photo
              </div>
            )}
            {writes.error && (
              <p role="alert" className="text-sm font-semibold text-ink">
                {writes.error}
              </p>
            )}
            {actions && (
              <div className="grid grid-cols-2 gap-2">
                {directions && (
                  <ButtonLink href={mapsDirections(p.lat, p.lng)} variant="secondary" className="col-span-2">
                    Directions
                  </ButtonLink>
                )}
                {onMove && p.canMove && (
                  <Button variant="secondary" onClick={() => onMove(p)} data-tire-move>
                    Move
                  </Button>
                )}
                {p.canDelete && (
                  <Button variant="danger" onClick={() => setConfirm(true)} data-tire-delete>
                    Delete
                  </Button>
                )}
              </div>
            )}
          </div>
        )}
      </Sheet>
      <ConfirmSheet
        open={p !== null && confirm}
        title="Delete tire pile"
        action="Delete"
        dismiss="Keep"
        busy={writes.remove.isPending}
        onClose={() => setConfirm(false)}
        onConfirm={() => {
          if (!p) return;
          writes.remove.mutate(
            { id: p.id },
            {
              onSuccess: () => {
                setConfirm(false);
                onDeleted?.();
                onClose();
              },
              onError: () => setConfirm(false),
            },
          );
        }}
      />
      {p && viewing && p.photoAt !== null && (
        <PhotoViewer tire={{ pileId: p.id, src: tirePhotoUrl(p), thumb: tirePhotoUrl(p, true), at: p.photoAt, by: p.photoBy }} onClose={() => setViewing(false)} />
      )}
    </>
  );
};
