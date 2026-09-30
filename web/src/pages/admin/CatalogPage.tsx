import { useCallback, useEffect, useState } from "react";
import { Button } from "../../components/Button.tsx";
import { EmptyState } from "../../components/EmptyState.tsx";
import { Field, Select } from "../../components/Field.tsx";
import { Page } from "../../components/Page.tsx";
import { Sheet } from "../../components/Sheet.tsx";
import { StatusPill } from "../../components/StatusPill.tsx";
import { plural, PRIORITY_LABEL, UNIT_LABEL } from "../../components/admin/format.ts";
import { DownIcon, PlusIcon, UpIcon } from "../../components/admin/icons.tsx";
import { errorText, Notice, type NoticeValue } from "../../components/admin/Notice.tsx";
import { Panel, Skeleton } from "../../components/admin/Panel.tsx";
import { Segmented } from "../../components/admin/Segmented.tsx";
import { Toggle } from "../../components/admin/Toggle.tsx";
import { trpc, type RouterOutputs } from "../../lib/trpc.ts";

type Item = RouterOutputs["admin"]["catalog"]["list"][number];
type Unit = Item["unit"];

const UNITS: readonly Unit[] = ["case", "box", "can", "each", "roll"];
const PRIORITIES = [
  { value: 1, label: "Low" },
  { value: 2, label: "Normal" },
  { value: 3, label: "Urgent" },
] as const;

const ItemSheet = ({ item, open, onClose, notify }: { item: Item | null; open: boolean; onClose: () => void; notify: (n: NoticeValue) => void }) => {
  const utils = trpc.useUtils();
  const [label, setLabel] = useState("");
  const [unit, setUnit] = useState<Unit>("each");
  const [priority, setPriority] = useState<1 | 2 | 3>(2);
  const [tracks, setTracks] = useState(true);
  const [capacity, setCapacity] = useState("0");
  const [active, setActive] = useState(true);
  useEffect(() => {
    if (!open) return;
    setLabel(item?.label ?? "");
    setUnit(item?.unit ?? "each");
    setPriority(item?.priority === 1 || item?.priority === 3 ? item.priority : 2);
    setTracks(item?.tracksStock ?? true);
    setCapacity(String(item?.defaultCapacity ?? 0));
    setActive(item?.active ?? true);
  }, [open, item]);
  const done = (text: string): void => {
    void utils.admin.catalog.list.invalidate();
    void utils.admin.days.get.invalidate();
    notify({ tone: "ok", text });
    onClose();
  };
  const create = trpc.admin.catalog.create.useMutation({ onSuccess: (t) => done(`${t.label} added`) });
  const update = trpc.admin.catalog.update.useMutation({ onSuccess: (t) => done(`${t.label} saved`) });
  const cap = Number(capacity);
  const capOk = !tracks || (capacity.trim() !== "" && Number.isInteger(cap) && cap >= 0 && cap <= 1000);
  const valid = label.trim().length > 0 && capOk;
  const submit = (): void => {
    if (!valid) return;
    const body = { label: label.trim(), unit, priority, tracksStock: tracks, defaultCapacity: tracks ? cap : 0 };
    if (item) update.mutate({ id: item.id, ...body, active });
    else create.mutate(body);
  };
  const err = create.error ?? update.error;
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={item ? item.label : "New item"}
      footer={
        <Button block size="lg" disabled={!valid} busy={create.isPending || update.isPending} onClick={submit}>
          {item ? "Save" : "Add item"}
        </Button>
      }
    >
      <form
        className="space-y-4 pb-2"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Field label="Label" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60} autoComplete="off" />
        <Select label="Unit" value={unit} onChange={(e) => setUnit(e.target.value as Unit)}>
          {UNITS.map((u) => (
            <option key={u} value={u}>
              {UNIT_LABEL[u]}
            </option>
          ))}
        </Select>
        <div className="space-y-1.5">
          <span className="block text-sm font-semibold">Priority</span>
          <Segmented label="Priority" value={priority} options={PRIORITIES} onChange={(v) => setPriority(v)} />
        </div>
        <Toggle label="Tracks stock" checked={tracks} onChange={setTracks} />
        {tracks && (
          <Field
            label="Capacity per truck"
            type="number"
            inputMode="numeric"
            min={0}
            max={1000}
            value={capacity}
            onChange={(e) => setCapacity(e.target.value)}
            error={capOk ? null : "Whole number, 0 to 1000"}
          />
        )}
        {item && <Toggle label="Active" checked={active} onChange={setActive} />}
        {err && <p role="alert" className="text-sm font-semibold">{errorText(err)}</p>}
      </form>
    </Sheet>
  );
};

export const CatalogPage = () => {
  const list = trpc.admin.catalog.list.useQuery(undefined, { retry: false });
  const utils = trpc.useUtils();
  const [editing, setEditing] = useState<Item | "new" | null>(null);
  const [notice, setNotice] = useState<NoticeValue>(null);
  const clear = useCallback(() => setNotice(null), []);
  const [order, setOrder] = useState<Item[] | null>(null);
  const reorder = trpc.admin.catalog.reorder.useMutation({
    onSettled: () => {
      void utils.admin.catalog.list.invalidate().then(() => setOrder(null));
    },
    onError: (e) => setNotice({ tone: "error", text: errorText(e) }),
  });
  const toggle = trpc.admin.catalog.update.useMutation({
    onSuccess: () => void utils.admin.catalog.list.invalidate(),
    onError: (e) => setNotice({ tone: "error", text: errorText(e) }),
  });
  const rows = order ?? list.data ?? [];
  const noEvent = list.error?.data?.code === "PRECONDITION_FAILED";

  const move = (i: number, dir: -1 | 1): void => {
    const j = i + dir;
    if (j < 0 || j >= rows.length) return;
    const next = [...rows];
    const [a, b] = [next[i]!, next[j]!];
    next[i] = b;
    next[j] = a;
    setOrder(next);
    reorder.mutate({ ids: next.map((r) => r.id) });
  };

  const addButton = (
    <Button onClick={() => setEditing("new")} disabled={noEvent}>
      <PlusIcon />
      Add item
    </Button>
  );

  return (
    <Page title="Catalog" actions={addButton}>
      <div className="space-y-4">
        <Notice value={notice} onClear={clear} />
        <Panel flush title={rows.length ? `${plural(rows.filter((r) => r.active).length, "active item")}` : undefined}>
          {list.isLoading ? (
            <Skeleton rows={6} className="p-4" />
          ) : noEvent ? (
            <EmptyState title="No active event" />
          ) : rows.length === 0 ? (
            <EmptyState title="No items yet" action={addButton} />
          ) : (
            <ol className="divide-y divide-line">
              {rows.map((t, i) => (
                <li key={t.id} className={`flex items-center gap-2 py-2 pr-2 pl-4 ${t.active ? "" : "bg-surface-2/60"}`}>
                  <button type="button" onClick={() => setEditing(t)} className="min-h-12 min-w-0 flex-1 text-left">
                    <span className={`flex flex-wrap items-center gap-2 font-semibold ${t.active ? "" : "text-muted"}`}>
                      {t.label}
                      {t.priority === 3 && <StatusPill status="urgent" />}
                      {!t.active && <StatusPill status="cancelled" label="Hidden" />}
                    </span>
                    <span className="block truncate text-sm text-muted">
                      {[UNIT_LABEL[t.unit], PRIORITY_LABEL[t.priority], t.tracksStock ? `${t.defaultCapacity} per truck` : "Not stocked"].filter(Boolean).join(", ")}
                    </span>
                  </button>
                  <label className="hidden min-h-10 items-center gap-2 text-sm font-semibold sm:flex">
                    <input
                      type="checkbox"
                      className="h-5 w-5 accent-[var(--brand-green)]"
                      checked={t.active}
                      onChange={(e) => toggle.mutate({ id: t.id, active: e.target.checked })}
                    />
                    Active
                  </label>
                  <span className="flex shrink-0 gap-1">
                    <button
                      type="button"
                      aria-label={`Move ${t.label} up`}
                      disabled={i === 0 || reorder.isPending}
                      onClick={() => move(i, -1)}
                      className="grid h-10 w-10 place-items-center rounded-lg bg-surface-2 ring-1 ring-inset ring-line disabled:opacity-40"
                    >
                      <UpIcon />
                    </button>
                    <button
                      type="button"
                      aria-label={`Move ${t.label} down`}
                      disabled={i === rows.length - 1 || reorder.isPending}
                      onClick={() => move(i, 1)}
                      className="grid h-10 w-10 place-items-center rounded-lg bg-surface-2 ring-1 ring-inset ring-line disabled:opacity-40"
                    >
                      <DownIcon />
                    </button>
                  </span>
                </li>
              ))}
            </ol>
          )}
        </Panel>
      </div>
      <ItemSheet item={editing === "new" ? null : editing} open={editing !== null} onClose={() => setEditing(null)} notify={setNotice} />
    </Page>
  );
};
