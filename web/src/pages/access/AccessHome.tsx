import { useEffect, useMemo, useState } from "react";
import { Button } from "../../components/Button.tsx";
import { EmptyState } from "../../components/EmptyState.tsx";
import { Select } from "../../components/Field.tsx";
import { ContactButtons } from "../../components/green/Contact.tsx";
import { Page } from "../../components/Page.tsx";
import { Panel } from "../../components/Panel.tsx";
import { Chips, Segmented } from "../../components/Segmented.tsx";
import { StatusPill } from "../../components/StatusPill.tsx";
import { dayDate, phoneText } from "../../components/admin/format.ts";
import { errorText } from "../../lib/errors.ts";
import { ago } from "../../lib/format.ts";
import { trpc, type RouterOutputs } from "../../lib/trpc.ts";

type Mine = RouterOutputs["access"]["mine"];
type View = Mine["approved"][number];
type Options = RouterOutputs["access"]["options"];
type AskRole = "crew" | "driver" | "green";

const ROLES: ReadonlyArray<{ value: AskRole; label: string }> = [
  { value: "crew", label: "Red shirt" },
  { value: "driver", label: "Driver" },
  { value: "green", label: "Green shirt" },
];

/** "Crew 2, Ford" / "Truck 1" / "CC East", then "CC East, Day 1". */
const titleOf = (v: View): string => v.target ?? (v.ccName ? `CC ${v.ccName}` : v.roleLabel);
const placeOf = (v: View): string => [v.target && v.ccName ? `CC ${v.ccName}` : null, v.dayLabel, v.dayDate ? dayDate(v.dayDate) : null].filter(Boolean).join(", ");

// #region request form
const RequestForm = ({ options, onDone }: { options: Options; onDone: () => void }) => {
  const utils = trpc.useUtils();
  const [role, setRole] = useState<AskRole | null>(null);
  const [dayId, setDayId] = useState<number | null>(options.defaultDayId);
  const [ccId, setCcId] = useState<number | null>(null);
  const [companyId, setCompanyId] = useState<number | "none" | null>(null);
  const [crewId, setCrewId] = useState<number | null>(null);
  const [truckId, setTruckId] = useState<number | null>(null);
  const request = trpc.access.request.useMutation({
    onSuccess: () => {
      void utils.access.mine.invalidate();
      onDone();
    },
  });

  const day = options.days.find((d) => d.id === dayId) ?? null;
  const ccs = day?.ccs ?? [];
  const cc = ccs.find((c) => c.id === ccId) ?? null;
  useEffect(() => {
    // One CC that day: nothing to choose.
    if (ccs.length === 1 && ccId !== ccs[0]!.id) setCcId(ccs[0]!.id);
  }, [ccs, ccId]);

  const companies = useMemo(() => {
    const seen = new Map<number | "none", string>();
    for (const c of cc?.crews ?? []) seen.set(c.companyId ?? "none", c.companyName ?? "No company");
    return [...seen.entries()].map(([value, label]) => ({ value, label }));
  }, [cc]);
  const crews = (cc?.crews ?? []).filter((c) => companyId === null || (c.companyId ?? "none") === companyId);

  const ready = role !== null && day !== null && cc !== null && (role === "green" || (role === "crew" ? crewId !== null : truckId !== null));

  return (
    <form
      noValidate
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready || !role || !day || !cc) return;
        request.mutate({ role, dayId: day.id, ccId: cc.id, crewId: role === "crew" ? crewId : null, truckId: role === "driver" ? truckId : null });
      }}
    >
      <div className="space-y-1.5">
        <div className="text-sm font-semibold">
          Role
        </div>
        <Segmented label="Role" value={role ?? ("" as AskRole)} options={ROLES} onChange={(v) => setRole(v)} size="lg" />
      </div>

      {role && (
        <>
          {options.days.length === 1 && day && (
            <div className="space-y-1.5">
              <div className="text-sm font-semibold">Day</div>
              <div className="text-base">
                {day.label}, {dayDate(day.date)}
              </div>
            </div>
          )}
          {options.days.length > 1 && (
            <Select
              label="Day"
              value={dayId ?? ""}
              onChange={(e) => {
                setDayId(Number(e.target.value));
                setCcId(null);
                setCrewId(null);
                setTruckId(null);
                setCompanyId(null);
              }}
            >
              {options.days.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}, {dayDate(d.date)}
                </option>
              ))}
            </Select>
          )}

          <div className="space-y-1.5">
            <div className="text-sm font-semibold">Command center</div>
            {ccs.length === 0 ? (
              <p className="text-base text-muted">No command centers</p>
            ) : (
              <Chips
                label="Command center"
                value={ccId}
                options={ccs.map((c) => ({ value: c.id, label: `CC ${c.name}` }))}
                onChange={(v) => {
                  setCcId(v);
                  setCrewId(null);
                  setTruckId(null);
                  setCompanyId(null);
                }}
              />
            )}
          </div>

          {role === "crew" && cc && (
            <>
              {companies.length > 1 && (
                <div className="space-y-1.5">
                  <div className="text-sm font-semibold">Company</div>
                  <Chips
                    label="Company"
                    value={companyId}
                    options={companies}
                    onChange={(v) => {
                      setCompanyId(v);
                      setCrewId(null);
                    }}
                  />
                </div>
              )}
              <div className="space-y-1.5">
                <div className="text-sm font-semibold">Crew</div>
                {crews.length === 0 ? (
                  <p className="text-base text-muted">No crews</p>
                ) : (
                  <Chips
                    label="Crew"
                    value={crewId}
                    options={crews.map((c) => ({ value: c.id, label: companyId === null && c.companyName ? `${c.name}, ${c.companyName}` : c.name }))}
                    onChange={setCrewId}
                  />
                )}
              </div>
            </>
          )}

          {role === "driver" && cc && (
            <div className="space-y-1.5">
              <div className="text-sm font-semibold">Truck</div>
              {cc.trucks.length === 0 ? (
                <p className="text-base text-muted">No trucks</p>
              ) : (
                <Chips label="Truck" value={truckId} options={cc.trucks.map((t) => ({ value: t.id, label: t.name }))} onChange={setTruckId} />
              )}
            </div>
          )}

          {request.error && (
            <p role="alert" className="text-sm font-semibold before:mr-1.5 before:inline-block before:h-2 before:w-2 before:rounded-full before:bg-crew before:content-['']">
              {errorText(request.error, "Not sent, try again")}
            </p>
          )}
          <Button type="submit" size="lg" block disabled={!ready} busy={request.isPending}>
            Request
          </Button>
        </>
      )}
    </form>
  );
};
// #endregion

// #region cards
const Pending = ({ v }: { v: Mine["pending"][number] }) => {
  const utils = trpc.useUtils();
  const cancel = trpc.access.cancel.useMutation({ onSuccess: () => void utils.access.mine.invalidate() });
  return (
    <Panel
      title={
        <span className="flex flex-wrap items-center gap-2">
          {v.roleLabel}
          <StatusPill status="pending" />
        </span>
      }
    >
      <div className="space-y-4">
        <div>
          <div className="text-lg font-bold">{titleOf(v)}</div>
          <div className="text-sm text-muted">
            {placeOf(v)}
            {placeOf(v) ? ", " : ""}
            {ago(v.requestedAt)}
          </div>
        </div>
        <div className="space-y-3">
          <div className="text-sm font-semibold">Green shirts{v.ccName ? `, CC ${v.ccName}` : ""}</div>
          {v.greens.length === 0 ? (
            <p className="text-base text-muted">None listed</p>
          ) : (
            <ul className="space-y-3">
              {v.greens.map((g) => (
                <li key={`${g.name}-${g.phone ?? ""}`} className="space-y-1.5">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-2">
                    <span className="font-semibold">{g.name}</span>
                    <span className="text-sm text-muted">{[g.roleLabel, g.phone ? phoneText(g.phone) : null].filter(Boolean).join(", ")}</span>
                  </div>
                  <ContactButtons phone={g.phone} who={g.name} />
                </li>
              ))}
            </ul>
          )}
        </div>
        <Button variant="secondary" block busy={cancel.isPending} onClick={() => cancel.mutate({ id: v.id })}>
          Withdraw request
        </Button>
      </div>
    </Panel>
  );
};

const Choose = ({ list }: { list: readonly View[] }) => {
  const enter = trpc.access.enter.useMutation({ onSuccess: () => window.location.assign("/") });
  return (
    <Panel title="Sign in as" flush>
      <ul className="divide-y divide-line">
        {list.map((v) => (
          <li key={v.id}>
            <button
              type="button"
              disabled={enter.isPending}
              onClick={() => enter.mutate({ id: v.id })}
              className="flex min-h-16 w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-surface-2 disabled:opacity-60"
            >
              <span className="min-w-0">
                <span className="block truncate text-base font-bold">{titleOf(v)}</span>
                <span className="block truncate text-sm text-muted">{[v.roleLabel, placeOf(v)].filter(Boolean).join(", ")}</span>
              </span>
              <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" className="shrink-0 text-muted">
                <path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
              </svg>
            </button>
          </li>
        ))}
      </ul>
    </Panel>
  );
};
// #endregion

/**
 * The access screen for a signed-in user with no role (SPEC 18): pending
 * requests with the CC's green shirts to call, approved roles to choose from,
 * and the request form. A decision arrives on `access.onMine`; an approval
 * has already moved this session into the role, so `me` is refetched and the
 * app opens on the role's home.
 */
export const AccessHome = ({ name }: { name: string | null }) => {
  const utils = trpc.useUtils();
  const mine = trpc.access.mine.useQuery(undefined, { refetchInterval: 30_000 });
  const options = trpc.access.options.useQuery();
  const [asking, setAsking] = useState(false);

  trpc.access.onMine.useSubscription(undefined, {
    onData: (d) => {
      void utils.access.mine.invalidate();
      if (d.status === "approved") void utils.shared.me.invalidate();
    },
    onError: () => void utils.shared.me.invalidate(),
  });

  if (mine.isLoading || options.isLoading) {
    return (
      <Page title="Access">
        <div className="h-40 animate-pulse rounded-2xl bg-surface-2" aria-busy="true" />
      </Page>
    );
  }
  if (mine.error || options.error || !mine.data || !options.data) {
    return (
      <Page title="Access">
        <EmptyState title="Access not loaded" action={<Button onClick={() => void mine.refetch()}>Retry</Button>} />
      </Page>
    );
  }
  const m = mine.data;
  const o = options.data;
  if (!o.event || o.days.length === 0) {
    return (
      <Page title="Access">
        <EmptyState title="No event set up yet" description="Command centers appear here once Life Remodeled adds them." />
      </Page>
    );
  }
  const showForm = asking || (m.pending.length === 0 && m.approved.length === 0);

  return (
    <Page title={name ? name : "Access"}>
      <div className="space-y-4">
        {m.pending.map((v) => (
          <Pending key={v.id} v={v} />
        ))}
        {m.approved.length > 0 && <Choose list={m.approved} />}
        {m.denied && m.pending.length === 0 && (
          <Panel
            title={
              <span className="flex flex-wrap items-center gap-2">
                {m.denied.roleLabel}
                <StatusPill status="denied" />
              </span>
            }
          >
            <div className="text-base font-semibold">{titleOf(m.denied)}</div>
            <div className="text-sm text-muted">{placeOf(m.denied)}</div>
          </Panel>
        )}
        {showForm ? (
          <Panel title="Request access">
            <RequestForm options={o} onDone={() => setAsking(false)} />
          </Panel>
        ) : (
          <Panel>
            <Button variant="secondary" size="lg" block onClick={() => setAsking(true)}>
              New request
            </Button>
          </Panel>
        )}
      </div>
    </Page>
  );
};
