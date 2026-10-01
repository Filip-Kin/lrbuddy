import { Redirect, Route, Switch } from "wouter";
import type { NavLink } from "../../components/Nav.tsx";
import { trpc } from "../../lib/trpc.ts";
import { GreenAccessPage } from "../access/AccessQueue.tsx";
import { BroadcastPage } from "./BroadcastPage.tsx";
import { CrewsPage } from "./CrewsPage.tsx";
import { LotsPage } from "./LotsPage.tsx";
import { MapPage } from "./MapPage.tsx";
import { PhotosPage } from "./PhotosPage.tsx";
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
    { href: "/photos", label: "Photos" },
    { href: "/crews", label: "Crews" },
    { href: "/trucks", label: "Trucks" },
    { href: "/broadcast", label: "Broadcast" },
    { href: "/stats", label: "Stats" },
    { href: "/access", label: "Access" },
  ].map((l) => ({ label: l.label, href: `${base}${l.href === "/" && base ? "" : l.href}${search}` }));

/** Green links with the pending access count on Access. */
export const useGreenLinks = (base = "", search = ""): NavLink[] => {
  const count = trpc.access.pendingCount.useQuery(undefined, { refetchInterval: 60_000 });
  return greenLinks(base, search).map((l) => (l.label === "Access" ? { ...l, badge: count.data ?? 0 } : l));
};


export const GreenRoutes = () => (
  <Switch>
    <Route path="/" component={MapPage} />
    <Route path="/requests" component={RequestsPage} />
    <Route path="/lots" component={LotsPage} />
    <Route path="/photos" component={PhotosPage} />
    <Route path="/crews" component={CrewsPage} />
    <Route path="/trucks" component={TrucksPage} />
    <Route path="/broadcast" component={BroadcastPage} />
    <Route path="/stats" component={StatsPage} />
    <Route path="/access" component={GreenAccessPage} />
    <Route>
      <Redirect to="/" />
    </Route>
  </Switch>
);
