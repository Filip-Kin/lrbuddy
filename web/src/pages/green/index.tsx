import { lazy, Suspense } from "react";
import { Redirect, Route, Switch } from "wouter";
import { ErrorBoundary } from "../../components/ErrorBoundary.tsx";
import { ScreenLoading } from "../../components/ScreenLoading.tsx";
import { GreenAccessPage } from "../access/AccessQueue.tsx";
import { InvitePage } from "../access/InvitePage.tsx";
import { BroadcastPage } from "./BroadcastPage.tsx";
import { CrewsPage } from "./CrewsPage.tsx";
import { MapPage } from "./MapPage.tsx";
import { PhotosPage } from "./PhotosPage.tsx";
import { RequestsPage } from "./RequestsPage.tsx";
import { StatsPage } from "./StatsPage.tsx";
import { TrucksPage } from "./TrucksPage.tsx";

/** The camera screens are their own chunks: the green map does not wait for them, and a crash there stays there. */
const FlagPage = lazy(() => import("./flag/FlagPage.tsx").then((m) => ({ default: m.FlagPage })));
const WrapPage = lazy(() => import("./WrapPage.tsx").then((m) => ({ default: m.WrapPage })));

const Flag = () => (
  <ErrorBoundary>
    <Suspense fallback={<ScreenLoading dark />}>
      <FlagPage />
    </Suspense>
  </ErrorBoundary>
);

const Wrap = () => (
  <ErrorBoundary>
    <Suspense fallback={<ScreenLoading dark />}>
      <WrapPage />
    </Suspense>
  </ErrorBoundary>
);

export const GreenRoutes = () => (
  <Switch>
    <Route path="/" component={MapPage} />
    <Route path="/wrap" component={Wrap} />
    <Route path="/flag" component={Flag} />
    <Route path="/requests" component={RequestsPage} />
    <Route path="/photos" component={PhotosPage} />
    <Route path="/crews" component={CrewsPage} />
    <Route path="/trucks" component={TrucksPage} />
    <Route path="/broadcast" component={BroadcastPage} />
    <Route path="/stats" component={StatsPage} />
    <Route path="/access" component={GreenAccessPage} />
    <Route path="/invite" component={InvitePage} />
    <Route>
      <Redirect to="/" />
    </Route>
  </Switch>
);
