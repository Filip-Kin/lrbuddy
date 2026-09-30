import { useState } from "react";
import { Link } from "wouter";
import { Button } from "../../components/Button.tsx";
import { EmptyState } from "../../components/EmptyState.tsx";
import { Field } from "../../components/Field.tsx";
import { Page } from "../../components/Page.tsx";
import { QtyStepper } from "../../components/QtyStepper.tsx";
import { Sheet } from "../../components/Sheet.tsx";
import { StatusPill } from "../../components/StatusPill.tsx";
import { dateRange, dayDate, plural } from "../../components/admin/format.ts";
import { ChevronIcon, PlusIcon } from "../../components/admin/icons.tsx";
import { errorText, Notice, type NoticeValue } from "../../components/admin/Notice.tsx";
import { Panel, Skeleton, Stat } from "../../components/admin/Panel.tsx";
import { Toggle } from "../../components/admin/Toggle.tsx";
import { trpc } from "../../lib/trpc.ts";

const todayYmd = (): string => new Date().toLocaleDateString("sv-SE", { timeZone: "America/Detroit" });

const NewEventSheet = ({ open, onClose, hasActive, onDone }: { open: boolean; onClose: () => void; hasActive: boolean; onDone: (name: string) => void }) => {
  const utils = trpc.useUtils();
  const [name, setName] = useState("");
  const [start, setStart] = useState(todayYmd());
  const [count, setCount] = useState(6);
  const [active, setActive] = useState(true);
  const create = trpc.admin.events.create.useMutation({
    onSuccess: (ev) => {
      void utils.admin.invalidate();
      onDone(ev.name);
      setName("");
      onClose();
    },
  });
  const year = Number(start.slice(0, 4));
  const valid = name.trim().length > 0 && /^\d{4}-\d{2}-\d{2}$/.test(start) && year >= 2000;
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="New event"
      footer={
        <Button
          block
          size="lg"
          disabled={!valid}
          busy={create.isPending}
          onClick={() => create.mutate({ name: name.trim(), year, startDate: start, dayCount: count, active: hasActive ? active : true })}
        >
          Create event
        </Button>
      }
    >
      <form
        className="space-y-4 pb-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) create.mutate({ name: name.trim(), year, startDate: start, dayCount: count, active: hasActive ? active : true });
        }}
      >
        <Field label="Name" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} autoComplete="off" required />
        <Field label="First day" type="date" value={start} onChange={(e) => setStart(e.target.value)} required />
        <div className="space-y-1.5">
          <span className="block text-sm font-semibold">Days</span>
          <QtyStepper value={count} onChange={setCount} min={1} max={14} label="Days" size="md" />
        </div>
        {hasActive && <Toggle label="Make active" checked={active} onChange={setActive} />}
        {create.error && <p role="alert" className="text-sm font-semibold">{errorText(create.error)}</p>}
      </form>
    </Sheet>
  );
};

export const EventPage = () => {
  const overview = trpc.admin.overview.useQuery();
  const events = trpc.admin.events.list.useQuery();
  const utils = trpc.useUtils();
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState<NoticeValue>(null);
  const setActive = trpc.admin.events.setActive.useMutation({
    onSuccess: () => void utils.admin.invalidate(),
    onError: (e) => setNotice({ tone: "error", text: errorText(e) }),
  });

  const ev = overview.data?.event ?? null;
  const days = overview.data?.days ?? [];
  const list = events.data ?? [];
  const totals = days.reduce((a, d) => ({ ccs: a.ccs + d.ccCount, crews: a.crews + d.crewCount, trucks: a.trucks + d.truckCount }), { ccs: 0, crews: 0, trucks: 0 });

  const newButton = (
    <Button onClick={() => setCreating(true)}>
      <PlusIcon />
      New event
    </Button>
  );

  if (overview.isLoading || events.isLoading) {
    return (
      <Page title="Event">
        <Skeleton rows={4} />
      </Page>
    );
  }

  return (
    <Page title={ev ? ev.name : "Event"} actions={newButton}>
      <div className="space-y-4">
        <Notice value={notice} onClear={() => setNotice(null)} />
        {!ev ? (
          <Panel>
            <EmptyState title="No active event" action={list.length === 0 ? newButton : undefined} />
          </Panel>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat value={days.length} label="Days" />
              <Stat value={totals.crews} label="Crews" />
              <Stat value={totals.trucks} label="Trucks" />
              <Link href="/admin/lots" className="rounded-xl focus-visible:outline-2 focus-visible:outline-ink">
                <Stat value={overview.data?.lotCount ?? 0} label={overview.data?.unplacedLots ? `Lots, ${overview.data.unplacedLots.toLocaleString("en-US")} without CC` : "Lots"} tone={overview.data?.unplacedLots ? "warn" : undefined} />
              </Link>
            </div>
            <Panel title="Days" flush>
              {days.length === 0 ? (
                <EmptyState title="No days" />
              ) : (
                <ul className="divide-y divide-line">
                  {days.map((d) => (
                    <li key={d.id}>
                      <Link href={`/admin/days/${d.id}`} className="flex min-h-16 items-center gap-3 px-4 py-3 hover:bg-surface-2">
                        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-surface-2 text-lg font-bold tabular-nums ring-1 ring-inset ring-line">
                          {d.sort}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block font-semibold">
                            {d.label}
                            <span className="ml-2 font-normal text-muted">{dayDate(d.date)}</span>
                          </span>
                          <span className="block truncate text-sm text-muted">
                            {d.ccCount === 0 ? "No command centers" : `${plural(d.ccCount, "CC")}, ${plural(d.crewCount, "crew")}, ${plural(d.truckCount, "truck")}`}
                          </span>
                        </span>
                        <span className="text-muted">
                          <ChevronIcon />
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </>
        )}
        <Panel title="Events" flush>
          {list.length === 0 ? (
            <EmptyState title="No events yet" />
          ) : (
            <ul className="divide-y divide-line">
              {list.map((e) => (
                <li key={e.id} className="flex min-h-16 flex-wrap items-center gap-3 px-4 py-3">
                  <span className="min-w-0 flex-1">
                    <span className="block font-semibold">{e.name}</span>
                    <span className="block text-sm text-muted">
                      {[dateRange(e.firstDate, e.lastDate), plural(e.dayCount, "day")].filter(Boolean).join(", ")}
                    </span>
                  </span>
                  {e.active ? (
                    <StatusPill status="delivered" label="Active" />
                  ) : (
                    <Button variant="secondary" size="sm" busy={setActive.isPending && setActive.variables?.id === e.id} onClick={() => setActive.mutate({ id: e.id })}>
                      Set active
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
      <NewEventSheet
        open={creating}
        onClose={() => setCreating(false)}
        hasActive={!!ev}
        onDone={(name) => setNotice({ tone: "ok", text: `${name} created` })}
      />
    </Page>
  );
};
