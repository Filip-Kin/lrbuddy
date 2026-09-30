import { Redirect, Route, Switch } from "wouter";
import { BroadcastBanner } from "../../components/crew/BroadcastBanner.tsx";
import type { NavLink } from "../../components/Nav.tsx";
import { CcPage } from "./CcPage.tsx";
import { LotsPage } from "./LotsPage.tsx";
import { MapPage } from "./MapPage.tsx";
import { RequestPage } from "./RequestPage.tsx";
import { RequestsPage } from "./RequestsPage.tsx";
import { SettingsPage } from "./SettingsPage.tsx";

export const crewLinks: NavLink[] = [
  { href: "/", label: "Map" },
  { href: "/request", label: "Request" },
  { href: "/requests", label: "Requests" },
  { href: "/lots", label: "Lots" },
  { href: "/cc", label: "Command center" },
  { href: "/settings", label: "Settings" },
];

/** Broadcast banner on top, the page below it filling the rest (the map needs a fixed height). */
export const CrewRoutes = () => (
  <div className="flex h-full flex-col">
    <BroadcastBanner />
    <div className="relative min-h-0 flex-1 overflow-y-auto">
      <Switch>
        <Route path="/" component={MapPage} />
        <Route path="/request" component={RequestPage} />
        <Route path="/requests" component={RequestsPage} />
        <Route path="/lots" component={LotsPage} />
        <Route path="/cc" component={CcPage} />
        <Route path="/settings" component={SettingsPage} />
        <Route>
          <Redirect to="/" />
        </Route>
      </Switch>
    </div>
  </div>
);
