import { useEffect, useState } from "react";
import { Button } from "../../components/Button.tsx";
import { Chips } from "../../components/Segmented.tsx";
import { StatusPill } from "../../components/StatusPill.tsx";
import { errorText } from "../../lib/errors.ts";
import { logout, useSwitchRole } from "../../lib/session.ts";
import { trpc, type RouterOutputs } from "../../lib/trpc.ts";
import { RequestForm } from "./AccessHome.tsx";

type View = RouterOutputs["access"]["switchOptions"];
type SwitchRole = View["days"][number]["ccs"][number]["roles"][number];

const GROUP: Record<SwitchRole["role"], string> = { green: "Green shirt", driver: "Driver", crew: "Red shirt" };

const Chevron = () => (
  <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" className="shrink-0 text-muted">
    <path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
  </svg>
);

const rowClass = "flex min-h-12 w-full items-center text-ink justify-between gap-3 rounded-xl px-3 py-2 text-left ring-1 ring-inset ring-line hover:bg-surface-2";
/** The current row is not a choice but stays full strength; others dim while a switch is on its way. */
const rowState = (current: boolean): string => (current ? "bg-brand/15 ring-2 ring-brand" : "disabled:opacity-60");

/** One role at the picked CC: enter it, take the truck, send the one-tap request, or wait on one. */
const RoleRow = ({ r, busy, onPick, onRequest }: { r: SwitchRole; busy: boolean; onPick: () => void; onRequest: () => void }) => {
  const tail =
    r.current ? (
      <StatusPill status="approved" label="Current" />
    ) : r.action === "pending" ? (
      <StatusPill status="pending" />
    ) : r.action === "request" ? (
      <span className="shrink-0 rounded-lg px-2.5 py-1 text-sm font-bold ring-1 ring-inset ring-ink">Request</span>
    ) : (
      <Chevron />
    );
  return (
    <button
      type="button"
      data-switch-role={r.key}
      data-action={r.action}
      aria-current={r.current ? "true" : undefined}
      disabled={busy || r.current || r.action === "pending"}
      onClick={r.action === "request" ? onRequest : onPick}
      className={`${rowClass} ${rowState(r.current)}`}
    >
      <span className="min-w-0 truncate text-base font-semibold">{r.name}</span>
      {tail}
    </button>
  );
};

/**
 * The Switch sheet's body (SPEC 27): Admin for admins, then Day (today first
 * and marked), CC for that day, and the roles there. A pick signs the session
 * in at once; a role from another day is a one-tap request; New request opens
 * the access request prefilled with the day and CC. Sign out at the end.
 */
export const SwitchBody = ({ onDone }: { onDone: () => void }) => {
  const utils = trpc.useUtils();
  const q = trpc.access.switchOptions.useQuery(undefined, { staleTime: 0 });
  const options = trpc.access.options.useQuery(undefined, { staleTime: 60_000 });
  const sw = useSwitchRole();
  const request = trpc.access.request.useMutation({ onSuccess: () => void utils.access.switchOptions.invalidate() });
  const [dayId, setDayId] = useState<number | null>(null);
  const [ccId, setCcId] = useState<number | null>(null);
  const [asking, setAsking] = useState(false);

  const v = q.data;
  // First pick: the day and CC the session is in, else today, else the first day.
  useEffect(() => {
    if (!v || dayId !== null) return;
    const d = (v.current && v.days.find((x) => x.id === v.current?.dayId)) ?? v.days[0];
    if (!d) return;
    setDayId(d.id);
    setCcId(v.current && v.current.dayId === d.id ? v.current.ccId : (d.ccs[0]?.id ?? null));
  }, [v, dayId]);

  if (q.isLoading) return <div className="h-48 animate-pulse rounded-2xl bg-surface-2" aria-busy="true" />;
  if (q.error || !v) {
    return (
      <div className="flex items-center justify-between gap-3 py-2">
        <span className="font-semibold">Not loaded</span>
        <Button variant="secondary" onClick={() => void q.refetch()}>
          Retry
        </Button>
      </div>
    );
  }

  const day = v.days.find((d) => d.id === dayId) ?? null;
  const cc = day?.ccs.find((c) => c.id === ccId) ?? null;
  const pick = async (t: Parameters<typeof sw.go>[0]): Promise<void> => {
    if (await sw.go(t)) onDone();
  };

  if (asking && options.data) {
    return (
      <div className="space-y-4 pb-2" data-switch-request>
        <Button variant="ghost" onClick={() => setAsking(false)}>
          Back
        </Button>
        <RequestForm options={options.data} initial={{ dayId, ccId }} onDone={() => setAsking(false)} />
      </div>
    );
  }

  const groups = cc ? (["green", "driver", "crew"] as const).map((g) => ({ g, rows: cc.roles.filter((r) => r.role === g) })).filter((x) => x.rows.length > 0) : [];
  const busy = sw.busy || request.isPending;
  const error = sw.error ?? (request.error ? errorText(request.error, "Not sent, try again") : null);

  return (
    <div className="space-y-5 pb-2" data-switch>
      {v.admin.held && (
        <button
          type="button"
          data-switch-admin
          aria-current={v.admin.current ? "true" : undefined}
          disabled={busy || v.admin.current}
          onClick={() => void pick({ role: "admin" })}
          className={`${rowClass} ${rowState(v.admin.current)}`}
        >
          <span className="text-base font-semibold">Admin</span>
          {v.admin.current ? <StatusPill status="approved" label="Current" /> : <Chevron />}
        </button>
      )}

      <div className="space-y-1.5">
        <div className="text-sm font-semibold">Day</div>
        {v.days.length === 0 ? (
          <p className="text-base text-muted">No days</p>
        ) : (
          <Chips
            label="Day"
            value={dayId}
            options={v.days.map((d) => ({ value: d.id, label: d.label, badge: d.today ? "Today" : undefined }))}
            onChange={(id) => {
              setDayId(id);
              const d = v.days.find((x) => x.id === id);
              setCcId(v.current && v.current.dayId === id ? v.current.ccId : (d?.ccs[0]?.id ?? null));
            }}
          />
        )}
      </div>

      {day && (
        <div className="space-y-1.5">
          <div className="text-sm font-semibold">Command center</div>
          {day.ccs.length === 0 ? (
            <p className="text-base text-muted">No access</p>
          ) : (
            <Chips label="Command center" value={ccId} options={day.ccs.map((c) => ({ value: c.id, label: `CC ${c.name}` }))} onChange={setCcId} />
          )}
        </div>
      )}

      {groups.length > 0 && (
        <div className="space-y-3">
          {groups.map(({ g, rows }) => (
            <div key={g} className="space-y-1.5" role="group" aria-label={GROUP[g]}>
              {g !== "green" && <div className="text-sm font-semibold">{GROUP[g]}</div>}
              <ul className="space-y-1.5">
                {rows.map((r) => (
                  <li key={r.key}>
                    <RoleRow r={r} busy={busy} onPick={() => void pick(r.target)} onRequest={() => r.request && request.mutate(r.request)} />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      {error && (
        <p role="alert" className="text-sm font-semibold before:mr-1.5 before:inline-block before:h-2 before:w-2 before:rounded-full before:bg-crew before:content-['']">
          {error}
        </p>
      )}

      <div className="grid gap-2 border-t border-line pt-4">
        {!v.admin.held && (
          <Button variant="secondary" block disabled={!options.data} onClick={() => setAsking(true)} data-switch-new-request>
            New request
          </Button>
        )}
        <Button variant="ghost" block onClick={() => void logout()} data-switch-sign-out>
          Sign out
        </Button>
      </div>
    </div>
  );
};
