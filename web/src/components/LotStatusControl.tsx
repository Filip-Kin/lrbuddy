import { useCallback, useState } from "react";
import { errorText } from "../lib/errors.ts";
import { GRADE_LABEL, STATUS_LABEL, STATUS_ORDER, type LotGrade, type LotStatus } from "../lib/lotStatus.ts";
import { trpc } from "../lib/trpc.ts";
import { ToggleChip } from "./Segmented.tsx";

export type { LotGrade, LotStatus };

const ON: Record<LotStatus, string> = {
  not_todo: "bg-surface ring-2 ring-inset ring-muted",
  open: "bg-crew/20 ring-2 ring-inset ring-crew",
  in_progress: "bg-brand text-on-brand ring-2 ring-inset ring-on-brand/40",
  done: "bg-brand-green/20 ring-2 ring-inset ring-brand-green",
  do_not_touch: "bg-warn/20 ring-2 ring-inset ring-warn",
};

/**
 * The five statuses of SPEC 21 as one row, in their order: Not todo, Todo,
 * In progress, Done, Do not touch. Do not touch is set and cleared by green
 * shirts and admin only (`canDnt`); for anyone else a Do not touch lot shows
 * the control with every segment off limits.
 */
export const LotStatusControl = ({
  status,
  onChange,
  canDnt = false,
  label = "Status",
}: {
  status: LotStatus;
  onChange: (s: LotStatus) => void;
  canDnt?: boolean;
  label?: string;
}) => {
  const locked = !canDnt && status === "do_not_touch";
  return (
    <div role="radiogroup" aria-label={label} className="grid grid-cols-5 gap-1 rounded-2xl bg-surface-2 p-1 ring-1 ring-inset ring-line">
      {STATUS_ORDER.map((s) => {
        const on = status === s;
        const off = locked || (s === "do_not_touch" && !canDnt);
        return (
          <button
            key={s}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={off && !on}
            aria-disabled={off || undefined}
            data-status={s}
            onClick={() => {
              if (!on && !off) onChange(s);
            }}
            className={`flex min-h-12 min-w-0 items-center justify-center rounded-xl px-1 text-[14px] leading-tight font-semibold text-ink transition-colors disabled:opacity-45 ${
              on ? ON[s] : "bg-transparent active:bg-surface"
            }`}
          >
            <span className="text-center break-words">{STATUS_LABEL[s]}</span>
          </button>
        );
      })}
    </div>
  );
};

/** Full day or Light on a Todo lot; tapping the lit one clears it. */
export const GradeTags = ({ grade, onChange }: { grade: LotGrade | null; onChange: (g: LotGrade | null) => void }) => (
  <div role="group" aria-label="Size" className="flex flex-wrap gap-2">
    {(["high", "low"] as const).map((g) => (
      <ToggleChip key={g} on={grade === g} onChange={(v) => onChange(v ? g : null)}>
        {GRADE_LABEL[g]}
      </ToggleChip>
    ))}
  </div>
);

// #region writes
export type LotRole = "crew" | "driver" | "green";

/** A lot by id, or a bare parcel by parcel id. */
export interface LotTarget {
  lotId: number | null;
  parcelId: string | null;
}

export interface LotPatch {
  status?: LotStatus;
  grade?: LotGrade | null;
  note?: string | null;
}

/** Key for the optimistic overrides: one per lot, or per bare parcel. */
export const targetKey = (t: LotTarget): string => (t.lotId !== null ? `l:${t.lotId}` : `p:${t.parcelId ?? ""}`);

/**
 * Status, grade and note writes for one role, through that role's procedure.
 * The map recolours at once from `pending` (status per target key) and goes
 * back to the server's answer once the role's queries have refetched; a
 * refusal clears the override and leaves the reason in `error`.
 */
export const useSetLot = (role: LotRole) => {
  const utils = trpc.useUtils();
  const crew = trpc.crew.setLotStatus.useMutation();
  const driver = trpc.driver.setLotStatus.useMutation();
  const green = trpc.green.setLotStatus.useMutation();
  const [pending, setPending] = useState<ReadonlyMap<string, LotStatus>>(() => new Map());
  const [error, setError] = useState<{ key: string; message: string } | null>(null);

  const refetch = useCallback(async (): Promise<void> => {
    if (role === "crew") await Promise.all([utils.crew.lots.invalidate(), utils.crew.map.invalidate()]);
    // A driver who holds green also draws bare parcels (SPEC 27); a Todo takes one off that list.
    else if (role === "driver") await Promise.all([utils.driver.lots.invalidate(), utils.green.parcels.invalidate()]);
    else await utils.green.invalidate();
  }, [role, utils]);

  const set = useCallback(
    (t: LotTarget, patch: LotPatch): void => {
      const key = targetKey(t);
      setError(null);
      const status = patch.status;
      if (status) setPending((m) => new Map(m).set(key, status));
      const drop = (): void =>
        setPending((m) => {
          const next = new Map(m);
          next.delete(key);
          return next;
        });
      const input = { lotId: t.lotId, parcelId: t.lotId === null ? t.parcelId : null, ...patch };
      const done = {
        onError: (err: unknown) => {
          drop();
          setError({ key, message: errorText(err, "Not saved. Check signal and tap again.") });
        },
        onSuccess: () => {
          void refetch().then(drop);
        },
      };
      if (role === "crew") crew.mutate({ lotId: input.lotId, parcelId: input.parcelId, status: input.status, grade: input.grade }, done);
      else if (role === "driver") driver.mutate({ lotId: input.lotId, parcelId: input.parcelId, status: input.status, grade: input.grade }, done);
      else green.mutate(input, done);
    },
    [role, crew, driver, green, refetch],
  );

  /**
   * The lot id of a target, creating the lot as Todo first for a bare parcel
   * (the Flag screen's path), so a photo can attach to it. Rejects with the
   * server's reason when the role may not.
   */
  const ensure = useCallback(
    async (t: LotTarget): Promise<number> => {
      if (t.lotId !== null) return t.lotId;
      const key = targetKey(t);
      setPending((m) => new Map(m).set(key, "open"));
      const input = { lotId: null, parcelId: t.parcelId, status: "open" as const };
      try {
        const r = role === "crew" ? await crew.mutateAsync(input) : role === "driver" ? await driver.mutateAsync(input) : await green.mutateAsync(input);
        if (!r.lot) throw new Error("Lot not saved");
        return r.lot.id;
      } finally {
        void refetch().then(() =>
          setPending((m) => {
            const next = new Map(m);
            next.delete(key);
            return next;
          }),
        );
      }
    },
    [role, crew, driver, green, refetch],
  );

  return {
    set,
    ensure,
    pending,
    /** The status to draw: a pending tap wins over the server's last answer. */
    statusOf: (t: LotTarget, base: LotStatus | null): LotStatus | null => pending.get(targetKey(t)) ?? base,
    error: error?.message ?? null,
    errorFor: error?.key ?? null,
    busy: crew.isPending || driver.isPending || green.isPending,
  };
};
// #endregion
