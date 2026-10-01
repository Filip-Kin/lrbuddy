import { ButtonLink } from "../../components/Button.tsx";
import { EmptyState } from "../../components/EmptyState.tsx";
import { Page } from "../../components/Page.tsx";
import { Panel } from "../../components/Panel.tsx";

/** Survey drive mode on a phone. Foundation: the route and the way back; the map comes with the drive slice. */
export const DrivePage = () => (
  <Page title="Drive mode">
    <Panel>
      <EmptyState
        title="No GPS fix"
        action={
          <ButtonLink href="/plan/survey" variant="secondary">
            Survey
          </ButtonLink>
        }
      />
    </Panel>
  </Page>
);
