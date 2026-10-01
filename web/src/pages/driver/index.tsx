import { Redirect, Route, Switch } from "wouter";
import { BroadcastBanner } from "../../components/BroadcastBanner.tsx";
import type { NavLink } from "../../components/Nav.tsx";
import { MapPage } from "./MapPage.tsx";
import { SettingsPage } from "./SettingsPage.tsx";
import { StockPage } from "./StockPage.tsx";

export const driverLinks: NavLink[] = [
  { href: "/", label: "Map" },
  { href: "/stock", label: "Stock" },
  { href: "/settings", label: "Settings" },
];

/** Broadcast banner on top, the page below it filling the rest (the map needs a fixed height). */
export const DriverRoutes = () => (
  <div className="flex h-full flex-col">
    <BroadcastBanner />
    <div className="relative min-h-0 flex-1 overflow-y-auto">
      <Switch>
        <Route path="/" component={MapPage} />
        <Route path="/stock" component={StockPage} />
        <Route path="/settings" component={SettingsPage} />
        <Route>
          <Redirect to="/" replace />
        </Route>
      </Switch>
    </div>
  </div>
);
