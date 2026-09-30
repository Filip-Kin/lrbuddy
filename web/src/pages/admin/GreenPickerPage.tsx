import { Link } from "wouter";
import { EmptyState } from "../../components/EmptyState.tsx";
import { Page } from "../../components/Page.tsx";
import { trpc } from "../../lib/trpc.ts";

/** Admin picks a CC to open its green view at `/green?cc=<id>`. */
export const GreenPickerPage = () => {
  const ccs = trpc.admin.ccs.list.useQuery();
  const rows = ccs.data ?? [];
  return (
    <Page title="Green view">
      {ccs.isLoading ? null : rows.length === 0 ? (
        <EmptyState title="No command centers" />
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-2xl bg-surface ring-1 ring-line">
          {rows.map((cc) => (
            <li key={cc.id}>
              <Link href={`/green?cc=${cc.id}`} className="flex min-h-12 items-center justify-between gap-3 px-4 py-3 hover:bg-surface-2">
                <span className="font-semibold">CC {cc.name}</span>
                <span className="text-sm text-muted">
                  {cc.dayLabel}, {cc.date}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Page>
  );
};
