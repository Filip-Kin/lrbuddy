import { Redirect, Route, Switch } from "wouter";
import type { NavLink } from "../../components/Nav.tsx";
import { trpc } from "../../lib/trpc.ts";
import { AdminAccessPage } from "../access/AccessQueue.tsx";
import { CatalogPage } from "./CatalogPage.tsx";
import { CompaniesPage } from "./CompaniesPage.tsx";
import { CrewsPage } from "./CrewsPage.tsx";
import { DayPage } from "./DayPage.tsx";
import { EventPage } from "./EventPage.tsx";
import { ExportPage } from "./ExportPage.tsx";
import { GreenPickerPage } from "./GreenPickerPage.tsx";
import { useAdminLive } from "./live.ts";
import { LotsPage } from "./LotsPage.tsx";
import { PhotosPage } from "./PhotosPage.tsx";

export const adminLinks: NavLink[] = [
  { href: "/admin", label: "Event" },
  { href: "/admin/companies", label: "Companies" },
  { href: "/admin/crews", label: "Crews" },
  { href: "/admin/lots", label: "Lots" },
  { href: "/admin/photos", label: "Photos" },
  { href: "/admin/catalog", label: "Catalog" },
  { href: "/plan/survey", label: "Plan" },
  { href: "/admin/export", label: "Export" },
  { href: "/admin/green", label: "Green view" },
  { href: "/admin/access", label: "Access" },
];

/** Admin links with the pending access count on Access. */
export const useAdminLinks = (): NavLink[] => {
  const count = trpc.access.adminPendingCount.useQuery(undefined, { refetchInterval: 60_000 });
  return adminLinks.map((l) => (l.href === "/admin/access" ? { ...l, badge: count.data ?? 0 } : l));
};

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
      <Route>
        <Redirect to="/admin" />
      </Route>
    </Switch>
  );
};
