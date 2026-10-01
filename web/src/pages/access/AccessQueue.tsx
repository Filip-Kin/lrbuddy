import { useState } from "react";
import { Button } from "../../components/Button.tsx";
import { EmptyState } from "../../components/EmptyState.tsx";
import { ContactButtons } from "../../components/green/Contact.tsx";
import { Page } from "../../components/Page.tsx";
import { Panel } from "../../components/Panel.tsx";
import { Sheet } from "../../components/Sheet.tsx";
import { StatusPill } from "../../components/StatusPill.tsx";
import { dayDate, phoneText } from "../../components/admin/format.ts";
import { errorText } from "../../lib/errors.ts";
import { ago } from "../../lib/format.ts";
import { trpc, type RouterOutputs } from "../../lib/trpc.ts";

type Queue = RouterOutputs["access"]["pending"];
type Row = Queue["pending"][number];
type Decision = { id: number; decision: "approve" | "deny"; lead?: "replace" | "add" };
type Outcome = { ok: true } | { ok: false; leadChoice: string };

const who = (r: Row): string => r.user.name ?? (r.user.phone ? phoneText(r.user.phone) : (r.user.email ?? "No name"));

const what = (r: Row, showCc: boolean): string =>
  [r.target, showCc && r.ccName ? `CC ${r.ccName}` : null, r.dayLabel, r.dayDate ? dayDate(r.dayDate) : null].filter(Boolean).join(", ");

const Card = ({ r, showCc, busy, onDecide }: { r: Row; showCc: boolean; busy: boolean; onDecide: (d: Decision) => void }) => (
  <li className="space-y-3 rounded-2xl bg-surface p-4 ring-1 ring-line" data-access-request>
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="truncate text-lg font-bold">{who(r)}</div>
        <div className="text-sm text-muted">{[r.user.phone ? phoneText(r.user.phone) : null, r.user.email].filter(Boolean).join(", ") || "No phone"}</div>
      </div>
      <span className="shrink-0 text-sm text-muted">{ago(r.requestedAt)}</span>
    </div>
    <div>
      <div className="text-base font-semibold">{r.roleLabel}</div>
      <div className="text-sm text-muted">{what(r, showCc)}</div>
    </div>
    {r.user.phone && <ContactButtons phone={r.user.phone} who={who(r)} />}
    <div className="grid grid-cols-2 gap-2">
      <Button variant="secondary" size="lg" disabled={busy} onClick={() => onDecide({ id: r.id, decision: "deny" })}>
        Deny
      </Button>
      <Button size="lg" disabled={busy} onClick={() => onDecide({ id: r.id, decision: "approve" })}>
        Approve
      </Button>
    </div>
  </li>
);

/**
 * Pending access requests with Approve and Deny, then the latest decisions.
 * Green shirts see their CC (`/access`); admin sees every CC (`/admin/access`).
 * Approving a red shirt for a crew that has a lead asks Replace lead or Add.
 */
const AccessQueue = ({
  data,
  loading,
  failed,
  showCc,
  decide,
  pending,
}: {
  data: Queue | undefined;
  loading: boolean;
  failed: boolean;
  showCc: boolean;
  decide: (d: Decision) => Promise<Outcome>;
  pending: boolean;
}) => {
  const [lead, setLead] = useState<{ row: Row; current: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (d: Decision): Promise<void> => {
    setError(null);
    try {
      const r = await decide(d);
      if (!r.ok) {
        const row = data?.pending.find((x) => x.id === d.id);
        if (row) setLead({ row, current: r.leadChoice });
        return;
      }
      setLead(null);
    } catch (err) {
      setError(errorText(err, "Not saved, try again"));
    }
  };

  return (
    <Page title="Access" wide>
      <div className="space-y-4">
        {error && (
          <p role="alert" className="rounded-xl bg-crew/15 px-4 py-3 text-sm font-semibold">
            {error}
          </p>
        )}
        <Panel title={data ? `Pending, ${data.pending.length}` : "Pending"}>
          {loading ? (
            <div className="h-32 animate-pulse rounded-xl bg-surface-2" aria-busy="true" />
          ) : failed || !data ? (
            <EmptyState title="Requests not loaded" />
          ) : data.pending.length === 0 ? (
            <EmptyState title="No requests" />
          ) : (
            <ul className="grid gap-3 nav:grid-cols-2">
              {data.pending.map((r) => (
                <Card key={r.id} r={r} showCc={showCc} busy={pending} onDecide={(d) => void run(d)} />
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="Decided" flush>
          {!data || data.recent.length === 0 ? (
            <p className="px-4 py-6 text-center text-base text-muted">None yet</p>
          ) : (
            <ul className="divide-y divide-line">
              {data.recent.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <div className="truncate font-semibold">{who(r)}</div>
                    <div className="truncate text-sm text-muted">{[r.roleLabel, what(r, showCc)].filter(Boolean).join(", ")}</div>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <StatusPill status={r.status === "approved" ? "approved" : "denied"} />
                    <span className="text-xs text-muted">{ago(r.decidedAt)}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <Sheet
        open={lead !== null}
        onClose={() => setLead(null)}
        title={lead?.row.target ?? "Red shirt"}
        footer={
          <div className="grid grid-cols-2 gap-2">
            <Button variant="secondary" size="lg" className="px-3! whitespace-nowrap" disabled={pending} onClick={() => lead && void run({ id: lead.row.id, decision: "approve", lead: "add" })}>
              Add
            </Button>
            <Button size="lg" className="px-3! whitespace-nowrap" disabled={pending} onClick={() => lead && void run({ id: lead.row.id, decision: "approve", lead: "replace" })}>
              Replace lead
            </Button>
          </div>
        }
      >
        {lead && (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 pb-2 text-base">
            <dt className="text-muted">Lead now</dt>
            <dd className="font-semibold">{lead.current}</dd>
            <dt className="text-muted">Request</dt>
            <dd className="font-semibold">{who(lead.row)}</dd>
          </dl>
        )}
      </Sheet>
    </Page>
  );
};

/** `/access` for a green shirt (and admin inside a green view). */
export const GreenAccessPage = () => {
  const utils = trpc.useUtils();
  const q = trpc.access.pending.useQuery();
  const m = trpc.access.decide.useMutation({
    onSettled: () => {
      void utils.access.pending.invalidate();
      void utils.access.pendingCount.invalidate();
    },
  });
  return <AccessQueue data={q.data} loading={q.isLoading} failed={q.isError} showCc={false} decide={(d) => m.mutateAsync(d)} pending={m.isPending} />;
};

/** `/admin/access`: every CC of the active event. */
export const AdminAccessPage = () => {
  const utils = trpc.useUtils();
  const q = trpc.access.adminPending.useQuery();
  const m = trpc.access.adminDecide.useMutation({
    onSettled: () => {
      void utils.access.adminPending.invalidate();
      void utils.access.adminPendingCount.invalidate();
    },
  });
  return <AccessQueue data={q.data} loading={q.isLoading} failed={q.isError} showCc decide={(d) => m.mutateAsync(d)} pending={m.isPending} />;
};
