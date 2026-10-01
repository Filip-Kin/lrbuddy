import { useRef, type ReactNode } from "react";
import { Button } from "../../components/Button.tsx";
import { EmptyState } from "../../components/EmptyState.tsx";
import { Page } from "../../components/Page.tsx";
import { StatusPill } from "../../components/StatusPill.tsx";
import { unitPlural } from "../../components/driver/format.ts";
import { useWakeLock, type StockRow } from "../../components/driver/hooks.ts";
import { BoxIcon, MinusIcon, PlusIcon } from "../../components/driver/icons.tsx";
import { StockSkeleton } from "../../components/driver/Skeleton.tsx";
import { trpc } from "../../lib/trpc.ts";

const LOW_RATIO = 0.25;

const StepButton = ({ label, disabled, onClick, children }: { label: string; disabled: boolean; onClick: () => void; children: ReactNode }) => (
  <button
    type="button"
    aria-label={label}
    disabled={disabled}
    onClick={onClick}
    className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-surface-2 text-ink ring-1 ring-line ring-inset active:brightness-90 disabled:opacity-40"
  >
    {children}
  </button>
);

const Row = ({ s, onStep }: { s: StockRow; onStep: (delta: number) => void }) => {
  const pct = s.capacity > 0 ? Math.min(100, Math.round((s.qty / s.capacity) * 100)) : 0;
  const unit = unitPlural(s.unit);
  return (
    <li className="flex items-center gap-3 rounded-2xl bg-surface p-3 ring-1 ring-line ring-inset">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-base font-bold break-words">{s.label}</span>
          {s.low && <StatusPill status="low" label="Low" />}
        </div>
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-surface-2 ring-1 ring-line ring-inset" aria-hidden="true">
          <div className={`h-full rounded-full ${s.low ? "bg-warn" : "bg-brand-green"}`} style={{ width: `${pct}%` }} />
        </div>
        <div className="mt-1 text-sm text-muted tabular-nums">
          of {s.capacity}
          {unit ? ` ${unit}` : ""}
        </div>
      </div>
      <div role="group" aria-label={`${s.label} on the truck`} className="flex shrink-0 items-center gap-2">
        <StepButton label={`${s.label} minus one`} disabled={s.qty <= 0} onClick={() => onStep(-1)}>
          <MinusIcon />
        </StepButton>
        <output aria-live="polite" className="min-w-10 text-center text-2xl font-extrabold tabular-nums">
          {s.qty}
        </output>
        <StepButton label={`${s.label} plus one`} disabled={false} onClick={() => onStep(1)}>
          <PlusIcon />
        </StepButton>
      </div>
    </li>
  );
};

export const StockPage = () => {
  useWakeLock();
  const stock = trpc.driver.stock.useQuery();
  const utils = trpc.useUtils();
  const inFlight = useRef(0);
  const adjust = trpc.driver.adjustStock.useMutation({
    onMutate: ({ typeId, delta }) => {
      inFlight.current += 1;
      // Show the tap at once; the server clamps the same way.
      utils.driver.stock.setData(undefined, (prev) =>
        prev?.map((s) => {
          if (s.typeId !== typeId) return s;
          const qty = Math.max(0, s.qty + delta);
          return { ...s, qty, low: s.capacity > 0 && qty < s.capacity * LOW_RATIO };
        }),
      );
    },
    onSettled: (rows) => {
      inFlight.current -= 1;
      // Only the last answer of a burst of taps is current.
      if (inFlight.current === 0) {
        if (rows) utils.driver.stock.setData(undefined, rows);
        else void utils.driver.stock.invalidate();
        void utils.driver.queue.invalidate();
      }
    },
  });

  const rows = stock.data ?? [];
  const lowCount = rows.filter((s) => s.low).length;

  return (
    <Page title="Stock" actions={lowCount > 0 ? <StatusPill status="low" label={`${lowCount} low`} /> : undefined}>
      {stock.isLoading ? (
        <StockSkeleton />
      ) : stock.isError ? (
        <EmptyState
          title="Stock not loaded"
          action={
            <Button variant="secondary" onClick={() => void stock.refetch()}>
              Retry
            </Button>
          }
        />
      ) : rows.length === 0 ? (
        <EmptyState icon={<BoxIcon size={40} />} title="No tracked items" />
      ) : (
        <ul className="space-y-2">
          {rows.map((s) => (
            <Row key={s.typeId} s={s} onStep={(delta) => adjust.mutate({ typeId: s.typeId, delta })} />
          ))}
        </ul>
      )}
    </Page>
  );
};
