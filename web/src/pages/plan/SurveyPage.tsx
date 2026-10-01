import { ButtonLink } from "../../components/Button.tsx";
import { EmptyState } from "../../components/EmptyState.tsx";
import { Page } from "../../components/Page.tsx";
import { Panel, Stat } from "../../components/Panel.tsx";
import { SkeletonList } from "../../components/Skeleton.tsx";
import { trpc } from "../../lib/trpc.ts";
import { noEvent } from "./common.ts";

/** Survey on a laptop. Foundation: counts by grade; the map and table come with the survey slice. */
export const SurveyPage = () => {
  const list = trpc.plan.survey.list.useQuery(undefined, { retry: false });
  const cache = trpc.plan.parcels.stats.useQuery();
  const rows = list.data ?? [];
  const count = (g: string): number => rows.filter((r) => r.grade === g).length;
  return (
    <Page
      title="Survey"
      wide
      actions={
        <ButtonLink href="/plan/survey/drive" variant="secondary">
          Drive mode
        </ButtonLink>
      }
    >
      {list.isLoading ? (
        <SkeletonList rows={2} className="h-16" />
      ) : noEvent(list.error) ? (
        <Panel>
          <EmptyState title="No active event" />
        </Panel>
      ) : rows.length === 0 ? (
        <Panel>
          <EmptyState title="No parcels surveyed" />
        </Panel>
      ) : (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
          <Stat value={rows.length} label="Surveyed" />
          <Stat value={count("high")} label="High" tone="crew" />
          <Stat value={count("low")} label="Low" tone="warn" />
          <Stat value={count("clear")} label="Clear" tone="muted" />
          <Stat value={cache.data?.count ?? 0} label="Parcels loaded" />
        </div>
      )}
    </Page>
  );
};
