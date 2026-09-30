import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { Button } from "../../components/Button.tsx";
import { EmptyState } from "../../components/EmptyState.tsx";
import { TextArea } from "../../components/Field.tsx";
import { isActive, qtyText, unitLabel, type CrewRequest } from "../../components/crew/format.ts";
import { TypeIcon } from "../../components/crew/Icons.tsx";
import { Skeleton } from "../../components/crew/Skeleton.tsx";
import { Page } from "../../components/Page.tsx";
import { QtyStepper } from "../../components/QtyStepper.tsx";
import { Sheet } from "../../components/Sheet.tsx";
import { StatusPill } from "../../components/StatusPill.tsx";
import { useMyFix } from "../../lib/position.ts";
import { trpc, type RouterOutputs } from "../../lib/trpc.ts";

type RequestType = RouterOutputs["shared"]["catalog"][number];

/** Most advanced active request per type, for the badge on its tile. */
const activeByType = (rows: readonly CrewRequest[]): Map<number, CrewRequest> => {
  const rank = { en_route: 3, assigned: 2, open: 1, delivered: 0, cancelled: 0 } as const;
  const out = new Map<number, CrewRequest>();
  for (const r of rows) {
    if (!isActive(r)) continue;
    const prev = out.get(r.typeId);
    if (!prev || rank[r.status] > rank[prev.status]) out.set(r.typeId, r);
  }
  return out;
};

const Tile = ({ t, active, onOpen }: { t: RequestType; active: CrewRequest | undefined; onOpen: () => void }) => (
  <button
    type="button"
    onClick={onOpen}
    className="relative flex min-h-32 flex-col items-center justify-center gap-2.5 rounded-3xl bg-surface-2 px-2 py-4 text-center ring-1 ring-inset ring-line transition-transform active:scale-[0.97] active:brightness-95"
  >
    <span className="grid h-14 w-14 place-items-center rounded-2xl bg-brand text-on-brand">
      <TypeIcon typeKey={t.key} size={32} />
    </span>
    <span className="text-lg leading-tight font-bold break-words">{t.label}</span>
    {active && <StatusPill status={active.status} />}
  </button>
);

const RequestSheet = ({ t, active, onClose }: { t: RequestType | null; active: CrewRequest | undefined; onClose: () => void }) => {
  const [, navigate] = useLocation();
  const [qty, setQty] = useState(1);
  const [note, setNote] = useState("");
  const fix = useMyFix();
  const utils = trpc.useUtils();
  const send = trpc.crew.createRequest.useMutation({
    onSuccess: () => {
      void utils.crew.myRequests.invalidate();
      void utils.crew.map.invalidate();
      navigate("/requests");
    },
  });
  const isOther = t?.key === "other";
  const ready = !!t && (!isOther || note.trim() !== "");
  const close = (): void => {
    setQty(1);
    setNote("");
    send.reset();
    onClose();
  };
  return (
    <Sheet
      open={!!t}
      onClose={close}
      title={t?.label ?? "Request"}
      footer={
        <div className="space-y-2">
          {send.error && (
            <p role="alert" className="text-sm font-semibold">
              {send.error.data?.code === "BAD_REQUEST" ? send.error.message : "Not sent. Check signal and send again."}
            </p>
          )}
          <Button
            block
            size="lg"
            busy={send.isPending}
            disabled={!ready}
            onClick={() =>
              t &&
              send.mutate({ typeId: t.id, qty, note: note.trim() || null, lat: fix?.lat ?? null, lng: fix?.lng ?? null })
            }
          >
            {send.isPending ? "Sending" : "Send"}
          </Button>
        </div>
      }
    >
      {t && (
        <div className="space-y-5 pb-2">
          {active && (
            <div className="flex flex-wrap items-center gap-2 rounded-2xl bg-surface-2 px-3 py-2 text-sm">
              <span className="font-semibold">Already requested</span>
              <span className="text-muted">{qtyText(active.qty, active.unit)}</span>
              <StatusPill status={active.status} />
            </div>
          )}
          <div className="flex flex-col items-center gap-2">
            <span className="text-sm font-semibold">{unitLabel(t.unit)}</span>
            <QtyStepper value={qty} onChange={setQty} label={unitLabel(t.unit)} />
          </div>
          <TextArea
            label={isOther ? "Item" : "Note"}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={500}
            rows={2}
            required={isOther}
          />
        </div>
      )}
    </Sheet>
  );
};

export const RequestPage = () => {
  const catalog = trpc.shared.catalog.useQuery(undefined, { staleTime: 5 * 60_000 });
  const mine = trpc.crew.myRequests.useQuery();
  const [typeId, setTypeId] = useState<number | null>(null);
  const active = useMemo(() => activeByType(mine.data ?? []), [mine.data]);
  const picked = catalog.data?.find((t) => t.id === typeId) ?? null;

  return (
    <Page title="Request">
      {catalog.isLoading ? (
        <div aria-busy="true" className="grid grid-cols-2 gap-3 sm:grid-cols-3 nav:grid-cols-4">
          {Array.from({ length: 8 }, (_, i) => (
            <Skeleton key={i} className="h-32 rounded-3xl" />
          ))}
        </div>
      ) : catalog.isError ? (
        <EmptyState
          title="Items not loaded"
          action={
            <Button variant="secondary" onClick={() => void catalog.refetch()}>
              Retry
            </Button>
          }
        />
      ) : !catalog.data || catalog.data.length === 0 ? (
        <EmptyState title="No items available" />
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 nav:grid-cols-4">
          {catalog.data.map((t) => (
            <Tile key={t.id} t={t} active={active.get(t.id)} onOpen={() => setTypeId(t.id)} />
          ))}
        </div>
      )}
      <RequestSheet t={picked} active={picked ? active.get(picked.id) : undefined} onClose={() => setTypeId(null)} />
    </Page>
  );
};
