import { getQueryKey } from "@trpc/react-query";
import type { QueryKey } from "@tanstack/react-query";
import { useEffect } from "react";
import { preloadFor, rememberRole } from "../routeChunks.ts";
import { idbStore } from "./idbStore.ts";
import { CACHED_PATHS, cacheKey, pathsForRole, pruneCache, scopeOf, usable, type CachedPath, type CacheScope } from "./queryCache.ts";
import type { Me } from "./session.ts";
import { queryClient, trpc } from "./trpc.ts";

declare const __LRB_BUILD__: string;
/** Set by vite.config.ts per build; a deploy starts the phone cache over. */
export const BUILD = typeof __LRB_BUILD__ === "string" ? __LRB_BUILD__ : "dev";

// #region keys
const KEYS: Record<CachedPath, QueryKey> = {
  "green.overview": getQueryKey(trpc.green.overview, undefined, "query"),
  "green.parcels": getQueryKey(trpc.green.parcels, undefined, "query"),
  "green.plan": getQueryKey(trpc.green.plan, undefined, "query"),
  "green.lots": getQueryKey(trpc.green.lots, undefined, "query"),
  "driver.route": getQueryKey(trpc.driver.route, undefined, "query"),
  "driver.lots": getQueryKey(trpc.driver.lots, undefined, "query"),
  "driver.crews": getQueryKey(trpc.driver.crews, undefined, "query"),
};
const KEY_TO_PATH = new Map(CACHED_PATHS.map((p) => [JSON.stringify(KEYS[p]), p] as const));
// #endregion

// #region scope
let current: CacheScope | null = null;
/** The CC and day whose answers are being kept, for `live.ts` to drop stale ones. */
export const cacheScope = (): CacheScope | null => current;
// #endregion

// #region persist
/** Every successful fetch of a kept query is written to the phone, at most once a second per key. */
const writes = new Map<string, ReturnType<typeof setTimeout>>();
let persisting = false;
const persist = (): void => {
  if (persisting) return;
  persisting = true;
  queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== "updated" || event.action.type !== "success" || !current) return;
    const path = KEY_TO_PATH.get(JSON.stringify(event.query.queryKey));
    if (!path || !pathsForRole(current.role).includes(path)) return;
    const key = cacheKey(current, path);
    const prev = writes.get(key);
    if (prev) clearTimeout(prev);
    writes.set(
      key,
      setTimeout(() => {
        writes.delete(key);
        const data: unknown = event.query.state.data;
        if (data !== undefined) void idbStore.set(key, { v: BUILD, at: event.query.state.dataUpdatedAt, data });
      }, 1000),
    );
  });
};

/** Puts kept answers into the query cache, unless the network already answered. Marked stale, so screens refetch. */
const hydrate = async (scope: CacheScope): Promise<void> => {
  await Promise.all(
    pathsForRole(scope.role).map(async (path) => {
      const entry = await idbStore.get(cacheKey(scope, path));
      if (!usable(entry, BUILD)) return;
      const state = queryClient.getQueryState(KEYS[path]);
      if (state?.data !== undefined && state.dataUpdatedAt >= entry.at) return;
      queryClient.setQueryData(KEYS[path], entry.data, { updatedAt: entry.at });
    }),
  );
};
// #endregion

/**
 * After `shared.me`: remember the role, start its chunk, its first screen's queries and the phone
 * cache. The queries start in one tick so `httpBatchLink` sends them as one request (the parcels
 * go on their own, see `trpc.ts`) while the chunk downloads; before, each started only when its
 * screen mounted, after the chunk.
 */
export const usePrefetchRole = (me: Me | undefined): void => {
  const utils = trpc.useUtils();
  const role = me?.role ?? null;
  const scope = scopeOf(me && me.role !== "anon" && me.role !== "none" ? me : null);
  const scopeKey = scope ? cacheKey(scope, "green.overview") : "";
  useEffect(() => {
    if (!role) return;
    rememberRole(role);
    const path = window.location.pathname;
    preloadFor(role, path);
    current = scope;
    persist();
    void pruneCache(idbStore, BUILD).catch(() => undefined);
    if (scope) void hydrate(scope).catch(() => undefined);
    const inGreen = role === "green" || (role === "admin" && (path === "/green" || path.startsWith("/green/")) && scope !== null);
    if (inGreen) {
      void utils.green.overview.prefetch();
      void utils.green.plan.prefetch();
      void utils.green.parcels.prefetch();
      void utils.access.pendingCount.prefetch();
      if (!path.endsWith("/flag")) void utils.green.catalog.prefetch();
    } else if (role === "driver") {
      void utils.driver.route.prefetch();
      void utils.driver.lots.prefetch();
      void utils.driver.crews.prefetch();
      void utils.shared.latestBroadcast.prefetch();
    } else if (role === "crew") {
      void utils.crew.map.prefetch();
      void utils.crew.myRequests.prefetch();
      void utils.shared.latestBroadcast.prefetch();
    }
    // `scope` is a new object each render; `scopeKey` stands for it.
  }, [role, scopeKey, utils]);
};
