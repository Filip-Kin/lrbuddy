import { Redirect, Route, Switch } from "wouter";
import { AssignmentsPage } from "./AssignmentsPage.tsx";
import { BlocksPage } from "./BlocksPage.tsx";
import { DrivePage } from "./DrivePage.tsx";
import { InventoryPage } from "./InventoryPage.tsx";
import { PrintPage } from "./PrintPage.tsx";
import { SurveyPage } from "./SurveyPage.tsx";

/** Planning portal pages (SPEC 16). Admin only; App.tsx guards the prefix. */
export const PlanRoutes = () => (
  <Switch>
    <Route path="/plan/survey" component={SurveyPage} />
    <Route path="/plan/survey/drive" component={DrivePage} />
    <Route path="/plan/blocks" component={BlocksPage} />
    <Route path="/plan/assignments" component={AssignmentsPage} />
    <Route path="/plan/print" component={PrintPage} />
    <Route path="/plan/inventory" component={InventoryPage} />
    <Route>
      <Redirect to="/plan/survey" />
    </Route>
  </Switch>
);
