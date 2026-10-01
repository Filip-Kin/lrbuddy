import { EmptyState } from "../../components/EmptyState.tsx";
import { Page } from "../../components/Page.tsx";
import { Panel, Stat } from "../../components/Panel.tsx";
import { SkeletonList } from "../../components/Skeleton.tsx";
import { trpc } from "../../lib/trpc.ts";
import { noEvent } from "./common.ts";

/** Block sides by work count. Foundation: the totals bar; the map and table come with the blocks slice. */
export const BlocksPage = () => {
  const totals = trpc.plan.blocks.totals.useQuery(undefined, { retry: false });
  const t = totals.data;
  return (
    <Page title="Blocks" wide>
      {totals.isLoading ? (
        <SkeletonList rows={1} className="h-16" />
      ) : noEvent(totals.error) ? (
        <Panel>
          <EmptyState title="No active event" />
        </Panel>
      ) : !t || t.sides === 0 ? (
        <Panel>
          <EmptyState title="No block sides surveyed" />
        </Panel>
      ) : (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
          <Stat value={t.workParcels} label="Work parcels" />
          <Stat value={t.high} label="High" tone="crew" />
          <Stat value={t.low} label="Low" tone="warn" />
          <Stat value={t.sidesDark} label="Sides with 10+" />
          <Stat value={t.crewsNeeded} label="Crews needed" tone="brand" />
        </div>
      )}
    </Page>
  );
};
