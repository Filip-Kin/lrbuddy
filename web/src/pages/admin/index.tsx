import { Redirect, Route, Switch } from "wouter";
import { AdminAccessPage } from "../access/AccessQueue.tsx";
import { InvitePage } from "../access/InvitePage.tsx";
import { CatalogPage } from "./CatalogPage.tsx";
import { ClientErrorsPage, CrashTest } from "./ClientErrorsPage.tsx";
import { CompaniesPage } from "./CompaniesPage.tsx";
import { CrewsPage } from "./CrewsPage.tsx";
import { DayPage } from "./DayPage.tsx";
import { EventPage } from "./EventPage.tsx";
import { ExportPage } from "./ExportPage.tsx";
import { GreenPickerPage } from "./GreenPickerPage.tsx";
import { useAdminLive } from "./live.ts";
import { LotsPage } from "./LotsPage.tsx";
import { PeoplePage } from "./PeoplePage.tsx";
import { PhotosPage } from "./PhotosPage.tsx";

/** Admin screens. `/admin/green` picks a CC for the green view at `/green?cc=<id>`. */
export const AdminRoutes = () => {
  useAdminLive();
  return (
    <Switch>
      <Route path="/admin" component={EventPage} />
      <Route path="/admin/days/:id">{(p) => <DayPage id={Number(p.id)} />}</Route>
      <Route path="/admin/companies" component={CompaniesPage} />
      <Route path="/admin/crews" component={CrewsPage} />
      <Route path="/admin/lots" component={LotsPage} />
      <Route path="/admin/photos" component={PhotosPage} />
      <Route path="/admin/catalog" component={CatalogPage} />
      <Route path="/admin/print">
        <Redirect to="/plan/print" />
      </Route>
      <Route path="/admin/export" component={ExportPage} />
      <Route path="/admin/green" component={GreenPickerPage} />
      <Route path="/admin/access" component={AdminAccessPage} />
      <Route path="/admin/people" component={PeoplePage} />
      <Route path="/admin/invite" component={InvitePage} />
      <Route path="/admin/client-errors/test" component={CrashTest} />
      <Route path="/admin/client-errors" component={ClientErrorsPage} />
      <Route>
        <Redirect to="/admin" />
      </Route>
    </Switch>
  );
};
