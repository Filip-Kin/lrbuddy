/**
 * The last answer of the map queries, kept on the phone (IndexedDB) per CC and day, so a cold
 * open draws the map at once and refreshes behind it. Pure rules here; the store is passed in
 * (`idbStore.ts` in the browser, a Map in tests).
 */

/** The queries kept, by tRPC path. Every one takes no input. */
export const CACHED_PATHS = [
  "green.overview",
  "green.parcels",
  "green.plan",
  "green.lots",
  "driver.route",
  "driver.lots",
  "driver.crews",
] as const;
export type CachedPath = (typeof CACHED_PATHS)[number];

/** Live event kinds as `web/src/lib/live.ts` names them. */
export type LiveKind = "requests" | "positions" | "route" | "lots" | "stock" | "broadcast" | "access" | "all";

/** Entries older than this are dropped on start, whatever their day. */
export const MAX_AGE_MS = 3 * 24 * 3600_000;

export interface CacheEntry {
  /** Build stamp: a deploy can change a query's shape, so a new build ignores old entries. */
  v: string;
  at: number;
  data: unknown;
}

export interface CacheStore {
  get(key: string): Promise<CacheEntry | undefined>;
  set(key: string, entry: CacheEntry): Promise<void>;
  del(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

/** Whose data: the role and the CC and day it is scoped to. Null when nothing should be kept. */
export interface CacheScope {
  role: string;
  ccId: number;
  dayId: number;
}

export const scopeOf = (me: { role: string; cc?: { id: number } | null; day?: { id: number } | null } | null | undefined): CacheScope | null =>
  me && me.cc && me.day ? { role: me.role, ccId: me.cc.id, dayId: me.day.id } : null;

export const cacheKey = (scope: CacheScope, path: CachedPath): string => `${scope.role}|${scope.ccId}|${scope.dayId}|${path}`;

/** The paths a role's screens read; the others are never written for it. */
export const pathsForRole = (role: string): CachedPath[] =>
  role === "driver" ? ["driver.route", "driver.lots", "driver.crews"] : role === "green" || role === "admin" ? ["green.overview", "green.parcels", "green.plan", "green.lots"] : [];

/**
 * Which kept answers an event makes stale. The same rules as the query invalidation in
 * `live.ts`: a lot change touches every lot list and the parcels, a request or a route the
 * overview and the driver's route, a position the overview and the driver's crew list.
 */
export const pathsInvalidatedBy = (kind: LiveKind): CachedPath[] => {
  switch (kind) {
    case "lots":
      return ["green.overview", "green.parcels", "green.plan", "green.lots", "driver.lots"];
    case "requests":
    case "route":
      return ["green.overview", "driver.route"];
    case "positions":
      return ["green.overview", "driver.crews"];
    case "stock":
      return ["driver.route"];
    case "all":
      return [...CACHED_PATHS];
    case "broadcast":
    case "access":
      return [];
  }
};

/** An entry is usable when it is from this build and not too old. */
export const usable = (entry: CacheEntry | undefined, version: string, now = Date.now()): entry is CacheEntry =>
  !!entry && entry.v === version && now - entry.at < MAX_AGE_MS;

/** Drops the kept answers an event makes stale, so a reload before the refetch lands does not draw them. */
export const invalidateCached = async (store: CacheStore, scope: CacheScope | null, kind: LiveKind): Promise<void> => {
  if (!scope) return;
  await Promise.all(pathsInvalidatedBy(kind).map((p) => store.del(cacheKey(scope, p))));
};

/** Drops entries from another build or older than `MAX_AGE_MS`. */
export const pruneCache = async (store: CacheStore, version: string, now = Date.now()): Promise<number> => {
  let n = 0;
  for (const key of await store.keys()) {
    const e = await store.get(key);
    if (!usable(e, version, now)) {
      await store.del(key);
      n += 1;
    }
  }
  return n;
};
