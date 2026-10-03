import { useMemo, useState } from "react";
import { Button } from "../../components/Button.tsx";
import { downloadText } from "../../components/admin/download.ts";
import { EmptyState } from "../../components/EmptyState.tsx";
import { Field } from "../../components/Field.tsx";
import { Page } from "../../components/Page.tsx";
import { Panel } from "../../components/Panel.tsx";
import { SkeletonList } from "../../components/Skeleton.tsx";
import { errorText } from "../../lib/errors.ts";
import { trpc } from "../../lib/trpc.ts";

const day = (at: number): string => new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

/**
 * `/plan/inventory` (SPEC 30): the equipment count sheet. Each item shows its last count and the
 * change from the one before; type today's numbers and Save. Add item for anything not listed.
 */
export const InventoryPage = () => {
  const utils = trpc.useUtils();
  const list = trpc.plan.inventory.list.useQuery();
  const refresh = (): void => void utils.plan.inventory.list.invalidate();
  const [err, setErr] = useState<string | null>(null);
  const onError = (e: unknown): void => setErr(errorText(e));
  const add = trpc.plan.inventory.addItem.useMutation({ onSuccess: refresh, onError });
  const remove = trpc.plan.inventory.removeItem.useMutation({ onSuccess: refresh, onError });
  const save = trpc.plan.inventory.saveCounts.useMutation({ onError });
  const [draft, setDraft] = useState<Record<number, string>>({});
  const [name, setName] = useState("");
  const [saved, setSaved] = useState<string | null>(null);

  const rows = list.data ?? [];
  const changed = useMemo(
    () =>
      rows.flatMap((r) => {
        const v = draft[r.id];
        if (v === undefined || v.trim() === "") return [];
        const n = Number(v);
        return Number.isInteger(n) && n >= 0 ? [{ itemId: r.id, count: n }] : [];
      }),
    [rows, draft],
  );

  const saveAll = (): void => {
    setErr(null);
    save.mutate(
      { counts: changed },
      {
        onSuccess: (r) => {
          setDraft({});
          setSaved(`${r.saved} saved`);
          refresh();
        },
      },
    );
  };
  const csv = async (): Promise<void> => {
    const text = await utils.plan.inventory.csv.fetch(undefined, { staleTime: 0 });
    downloadText(`lrbuddy-inventory-${new Date().toISOString().slice(0, 10)}.csv`, text);
  };

  return (
    <Page
      title="Inventory"
      actions={
        <>
          <Button variant="secondary" onClick={() => void csv()} data-inventory-csv>
            CSV
          </Button>
          <Button onClick={saveAll} disabled={changed.length === 0} busy={save.isPending} data-inventory-save>
            {changed.length > 0 ? `Save ${changed.length}` : "Save"}
          </Button>
        </>
      }
    >
      {(err || saved) && (
        <p role={err ? "alert" : "status"} className="mb-3 text-sm font-semibold" data-inventory-note>
          {err ?? saved}
        </p>
      )}
      <Panel flush>
        {list.isLoading ? (
          <div className="p-4">
            <SkeletonList rows={5} className="h-14" />
          </div>
        ) : rows.length === 0 ? (
          <EmptyState title="No items" />
        ) : (
          <ul className="divide-y divide-line" data-inventory-list>
            {rows.map((r) => {
              const diff = r.last && r.previous ? r.last.count - r.previous.count : null;
              return (
                <li key={r.id} className="flex items-center gap-3 px-4 py-2" data-inventory-item={r.name}>
                  <span className="min-w-0 flex-1">
                    <span className="block font-semibold break-words">{r.name}</span>
                    <span className="block text-sm text-muted tabular-nums">
                      {r.last ? `${r.last.count} · ${day(r.last.at)}` : "Not counted"}
                      {diff !== null && diff !== 0 && <span className={diff < 0 ? "font-semibold text-ink" : ""}>{` · ${diff > 0 ? "+" : ""}${diff}`}</span>}
                    </span>
                  </span>
                  <input
                    type="number"
                    inputMode="numeric"
                    min={0}
                    aria-label={`Count, ${r.name}`}
                    placeholder={r.last ? String(r.last.count) : ""}
                    value={draft[r.id] ?? ""}
                    onChange={(e) => {
                      setSaved(null);
                      setDraft((d) => ({ ...d, [r.id]: e.target.value }));
                    }}
                    className="h-12 w-24 shrink-0 rounded-xl bg-surface-2 px-3 text-right text-lg font-semibold tabular-nums ring-1 ring-line ring-inset"
                    data-inventory-count
                  />
                  <button
                    type="button"
                    aria-label={`Remove ${r.name}`}
                    onClick={() => remove.mutate({ id: r.id })}
                    className="grid size-11 shrink-0 place-items-center rounded-xl text-muted hover:bg-surface-2"
                  >
                    ×
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
      <form
        className="mt-4 flex items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim() === "") return;
          setErr(null);
          add.mutate({ name: name.trim() }, { onSuccess: () => setName("") });
        }}
      >
        <Field label="Item" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} className="min-w-0 flex-1" data-inventory-name />
        <Button type="submit" variant="secondary" busy={add.isPending} disabled={name.trim() === ""} data-inventory-add>
          Add item
        </Button>
      </form>
    </Page>
  );
};
