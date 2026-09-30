import { Redirect, Route, Switch } from "wouter";
import type { NavLink } from "../../components/Nav.tsx";
import { BroadcastPage } from "./BroadcastPage.tsx";
import { CrewsPage } from "./CrewsPage.tsx";
import { LotsPage } from "./LotsPage.tsx";
import { MapPage } from "./MapPage.tsx";
import { RequestsPage } from "./RequestsPage.tsx";
import { StatsPage } from "./StatsPage.tsx";
import { TrucksPage } from "./TrucksPage.tsx";

/**
 * Green routes are relative. A green shirt sees them at `/`; an admin sees
 * them nested under `/green` with `?cc=<id>`, so `base` and `search` are
 * prefixed and appended here.
 */
export const greenLinks = (base = "", search = ""): NavLink[] =>
  [
    { href: "/", label: "Map" },
    { href: "/requests", label: "Requests" },
    { href: "/lots", label: "Lots" },
    { href: "/crews", label: "Crews" },
    { href: "/trucks", label: "Trucks" },
    { href: "/broadcast", label: "Broadcast" },
    { href: "/stats", label: "Stats" },
  ].map((l) => ({ label: l.label, href: `${base}${l.href === "/" && base ? "" : l.href}${search}` }));


export const GreenRoutes = () => (
  <Switch>
    <Route path="/" component={MapPage} />
    <Route path="/requests" component={RequestsPage} />
    <Route path="/lots" component={LotsPage} />
    <Route path="/crews" component={CrewsPage} />
    <Route path="/trucks" component={TrucksPage} />
    <Route path="/broadcast" component={BroadcastPage} />
    <Route path="/stats" component={StatsPage} />
    <Route>
      <Redirect to="/" />
    </Route>
  </Switch>
);
