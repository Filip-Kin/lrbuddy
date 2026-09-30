import { Redirect, Route, Switch } from "wouter";
import type { NavLink } from "../../components/Nav.tsx";
import { MapPage } from "./MapPage.tsx";
import { QueuePage } from "./QueuePage.tsx";
import { SettingsPage } from "./SettingsPage.tsx";
import { StockPage } from "./StockPage.tsx";

export const driverLinks: NavLink[] = [
  { href: "/", label: "Queue" },
  { href: "/map", label: "Map" },
  { href: "/stock", label: "Stock" },
  { href: "/settings", label: "Settings" },
];


export const DriverRoutes = () => (
  <Switch>
    <Route path="/" component={QueuePage} />
    <Route path="/map" component={MapPage} />
    <Route path="/stock" component={StockPage} />
    <Route path="/settings" component={SettingsPage} />
    <Route>
      <Redirect to="/" />
    </Route>
  </Switch>
);
