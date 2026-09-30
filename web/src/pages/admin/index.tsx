import { Redirect, Route, Switch } from "wouter";
import type { NavLink } from "../../components/Nav.tsx";
import { CatalogPage } from "./CatalogPage.tsx";
import { CompaniesPage } from "./CompaniesPage.tsx";
import { CrewsPage } from "./CrewsPage.tsx";
import { DayPage } from "./DayPage.tsx";
import { EventPage } from "./EventPage.tsx";
import { ExportPage } from "./ExportPage.tsx";
import { GreenPickerPage } from "./GreenPickerPage.tsx";
import { LotsPage } from "./LotsPage.tsx";
import { PrintPage } from "./PrintPage.tsx";

export const adminLinks: NavLink[] = [
  { href: "/admin", label: "Event" },
  { href: "/admin/companies", label: "Companies" },
  { href: "/admin/crews", label: "Crews" },
  { href: "/admin/lots", label: "Lots" },
  { href: "/admin/catalog", label: "Catalog" },
  { href: "/admin/print", label: "Print" },
  { href: "/admin/export", label: "Export" },
  { href: "/admin/green", label: "Green view" },
];


/** Admin screens. `/admin/green` picks a CC for the green view at `/green?cc=<id>`. */
export const AdminRoutes = () => (
  <Switch>
    <Route path="/admin" component={EventPage} />
    <Route path="/admin/days/:id">{(p) => <DayPage id={Number(p.id)} />}</Route>
    <Route path="/admin/companies" component={CompaniesPage} />
    <Route path="/admin/crews" component={CrewsPage} />
    <Route path="/admin/lots" component={LotsPage} />
    <Route path="/admin/catalog" component={CatalogPage} />
    <Route path="/admin/print" component={PrintPage} />
    <Route path="/admin/export" component={ExportPage} />
    <Route path="/admin/green" component={GreenPickerPage} />
    <Route>
      <Redirect to="/admin" />
    </Route>
  </Switch>
);
