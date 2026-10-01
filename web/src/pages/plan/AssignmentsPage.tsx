import { EmptyState } from "../../components/EmptyState.tsx";
import { Page } from "../../components/Page.tsx";
import { Panel, Stat } from "../../components/Panel.tsx";
import { SkeletonList } from "../../components/Skeleton.tsx";
import { trpc } from "../../lib/trpc.ts";
import { noEvent } from "./common.ts";

/** Block sides handed to companies and crews. Foundation: totals; the day, CC and map come with the assignments slice. */
export const AssignmentsPage = () => {
  const list = trpc.plan.assignments.list.useQuery(undefined, { retry: false });
  const rows = list.data ?? [];
  const crews = new Set(rows.map((r) => r.assignment?.crewId).filter((x): x is number => x != null));
  const companies = new Set(rows.map((r) => r.assignment?.companyId).filter((x): x is number => x != null));
  return (
    <Page title="Assignments" wide>
      {list.isLoading ? (
        <SkeletonList rows={1} className="h-16" />
      ) : noEvent(list.error) ? (
        <Panel>
          <EmptyState title="No active event" />
        </Panel>
      ) : rows.length === 0 ? (
        <Panel>
          <EmptyState title="No block sides assigned" />
        </Panel>
      ) : (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat value={rows.length} label="Block sides" />
          <Stat value={rows.reduce((n, r) => n + r.workCount, 0)} label="Work parcels" />
          <Stat value={companies.size} label="Companies" />
          <Stat value={crews.size} label="Crews" />
        </div>
      )}
    </Page>
  );
};
