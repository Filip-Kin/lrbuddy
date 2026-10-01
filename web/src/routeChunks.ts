import { lazy } from "react";
import { storageGet, storageSet } from "./lib/safe.ts";

/**
 * One code chunk per role group (SPEC 2: Leaflet and the maps stay out of the sign-in page).
 * Each loader is also called early, from the last role this phone used and again once
 * `shared.me` answers, so the chunk downloads alongside the first queries instead of after them.
 */
export const loaders = {
  access: () => import("./pages/access/AccessHome.tsx"),
  crew: () => import("./pages/crew/index.tsx"),
  driver: () => import("./pages/driver/index.tsx"),
  green: () => import("./pages/green/index.tsx"),
  flag: () => import("./pages/green/flag/FlagPage.tsx"),
  admin: () => import("./pages/admin/index.tsx"),
  plan: () => import("./pages/plan/index.tsx"),
};

export const AccessHome = lazy(() => loaders.access().then((m) => ({ default: m.AccessHome })));
export const CrewRoutes = lazy(() => loaders.crew().then((m) => ({ default: m.CrewRoutes })));
export const DriverRoutes = lazy(() => loaders.driver().then((m) => ({ default: m.DriverRoutes })));
export const GreenRoutes = lazy(() => loaders.green().then((m) => ({ default: m.GreenRoutes })));
export const AdminRoutes = lazy(() => loaders.admin().then((m) => ({ default: m.AdminRoutes })));
export const PlanRoutes = lazy(() => loaders.plan().then((m) => ({ default: m.PlanRoutes })));

const LAST_ROLE = "lrb.lastRole";

/** The chunks a role opens at `path`, started now; a failed download is retried by the lazy screen. */
export const preloadFor = (role: string, path: string): void => {
  const start = (l: () => Promise<unknown>): void => {
    l().catch(() => undefined);
  };
  const inGreen = path === "/green" || path.startsWith("/green/");
  if (role === "crew") start(loaders.crew);
  else if (role === "driver") start(loaders.driver);
  else if (role === "green" || (role === "admin" && inGreen)) {
    start(loaders.green);
    if (path.endsWith("/flag")) start(loaders.flag);
  } else if (role === "admin") start(path.startsWith("/plan") ? loaders.plan : loaders.admin);
  else if (role === "none") start(loaders.access);
};

export const rememberRole = (role: string): void => {
  storageSet("local", LAST_ROLE, role === "anon" ? null : role);
};

/** At boot, before `shared.me` answers: the chunk of the role this phone had last time. */
export const preloadLastRole = (): void => {
  const role = storageGet("local", LAST_ROLE);
  if (role && window.location.pathname !== "/login") preloadFor(role, window.location.pathname);
};
