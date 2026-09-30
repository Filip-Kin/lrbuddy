import { Link } from "wouter";
import { EmptyState } from "../../components/EmptyState.tsx";
import { Page } from "../../components/Page.tsx";
import { dayDate } from "../../components/admin/format.ts";
import { ChevronIcon } from "../../components/admin/icons.tsx";
import { Panel } from "../../components/Panel.tsx";
import { SkeletonList } from "../../components/Skeleton.tsx";
import { trpc, type RouterOutputs } from "../../lib/trpc.ts";

type Cc = RouterOutputs["admin"]["ccs"]["list"][number];

/** Admin picks a CC to open its green view at `/green?cc=<id>`. */
export const GreenPickerPage = () => {
  const ccs = trpc.admin.ccs.list.useQuery(undefined, { retry: false });
  const rows = ccs.data ?? [];
  const byDay = new Map<number, Cc[]>();
  for (const c of rows) byDay.set(c.dayId, [...(byDay.get(c.dayId) ?? []), c]);
  return (
    <Page title="Green view">
      {ccs.isLoading ? (
        <SkeletonList rows={4} className="h-14" />
      ) : rows.length === 0 ? (
        <Panel>
          <EmptyState title="No command centers" />
        </Panel>
      ) : (
        <div className="space-y-4">
          {[...byDay.values()].map((list) => (
            <Panel key={list[0]!.dayId} flush title={`${list[0]!.dayLabel}, ${dayDate(list[0]!.date)}`}>
              <ul className="divide-y divide-line">
                {list.map((cc) => (
                  <li key={cc.id}>
                    <Link href={`/green?cc=${cc.id}`} className="flex min-h-14 items-center gap-3 px-4 py-2 hover:bg-surface-2">
                      <span aria-hidden="true" className="h-3 w-3 shrink-0 rounded-full bg-brand-green" />
                      <span className="min-w-0 flex-1">
                        <span className="block font-semibold">CC {cc.name}</span>
                        {cc.address && <span className="block truncate text-sm text-muted">{cc.address}</span>}
                      </span>
                      <span className="text-muted">
                        <ChevronIcon />
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </Panel>
          ))}
        </div>
      )}
    </Page>
  );
};
