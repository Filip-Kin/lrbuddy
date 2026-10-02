import { useCallback, useEffect, useRef, useState } from "react";
import { idbStore } from "./idbStore.ts";
import { cacheScope } from "./prefetch.ts";
import { invalidateCached } from "./queryCache.ts";
import { trpc } from "./trpc.ts";
import type { Role } from "./session.ts";

type Utils = ReturnType<typeof trpc.useUtils>;
type Kind = "requests" | "positions" | "route" | "lots" | "stock" | "broadcast" | "access";

const COALESCE_MS = 1500;

// #region settle
/**
 * The stream opens once the page's first load has gone quiet. An open SSE
 * request counts as network activity forever, so opening it while map tiles
 * are still arriving would keep the page from ever reaching network idle
 * (the gate and the screenshot harness wait for that). Queries load on mount
 * anyway and the stream's start refetches them, so nothing is missed.
 */
const SETTLE_MIN_MS = 2500;
const SETTLE_QUIET_MS = 1200;
const SETTLE_MAX_MS = 12_000;

/** True once no resource has finished loading for a moment (at least 2.5 s after mount, at most 12 s). */
export const useSettled = (): boolean => {
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    const start = performance.now();
    let last = start;
    let observer: PerformanceObserver | null = null;
    try {
      observer = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) last = Math.max(last, e.startTime + e.duration);
      });
      observer.observe({ type: "resource", buffered: false });
    } catch {
      observer = null;
    }
    const t = window.setInterval(() => {
      const now = performance.now();
      if (now - start >= SETTLE_MAX_MS || (now - start >= SETTLE_MIN_MS && now - last >= SETTLE_QUIET_MS)) {
        window.clearInterval(t);
        observer?.disconnect();
        setSettled(true);
      }
    }, 250);
    return () => {
      window.clearInterval(t);
      observer?.disconnect();
    };
  }, []);
  return settled;
};
// #endregion

/** Which cached queries each kind of event makes stale. Role pages add their own as they grow. */
const invalidate = (utils: Utils, kind: Kind): void => {
  switch (kind) {
    case "requests":
      void utils.crew.myRequests.invalidate();
      void utils.crew.map.invalidate();
      void utils.driver.queue.invalidate();
      void utils.driver.route.invalidate();
      void utils.green.invalidate();
      break;
    case "positions":
      void utils.crew.map.invalidate();
      void utils.green.overview.invalidate();
      void utils.green.crews.invalidate();
      void utils.green.trucks.invalidate();
      void utils.driver.crews.invalidate();
      break;
    case "route":
      void utils.driver.queue.invalidate();
      void utils.driver.route.invalidate();
      void utils.crew.myRequests.invalidate();
      void utils.green.trucks.invalidate();
      void utils.green.requests.invalidate();
      void utils.green.overview.invalidate();
      break;
    case "lots":
      void utils.crew.lots.invalidate();
      void utils.crew.map.invalidate();
      void utils.crew.hasArea.invalidate();
      void utils.green.lots.invalidate();
      void utils.green.parcels.invalidate();
      void utils.driver.lots.invalidate();
      void utils.green.overview.invalidate();
      void utils.green.plan.invalidate();
      void utils.green.stats.invalidate();
      void utils.green.photos.invalidate();
      void utils.green.wrap.invalidate();
      void utils.shared.lotPhotos.invalidate();
      break;
    case "stock":
      void utils.driver.stock.invalidate();
      void utils.driver.queue.invalidate();
      void utils.green.trucks.invalidate();
      break;
    case "broadcast":
      void utils.shared.latestBroadcast.invalidate();
      void utils.green.broadcasts.invalidate();
      break;
    case "access":
      void utils.access.pending.invalidate();
      void utils.access.pendingCount.invalidate();
      break;
  }
};

const KIND: Record<string, Kind> = {
  "request.changed": "requests",
  "truck.position": "positions",
  "crew.position": "positions",
  "route.changed": "route",
  "lot.changed": "lots",
  "stock.changed": "stock",
  broadcast: "broadcast",
  "membership.changed": "access",
};

// #region retry
const RETRY_FIRST_MS = 2000;
const RETRY_MAX_MS = 30_000;

/**
 * Turns a stream back on after it fails. A reconnect that gets a non-200 answer (the
 * front door's 502 while the app restarts) closes the EventSource for good, and tRPC
 * does not subscribe again on its own, so the screen would stay without live updates
 * until a reload. The stream is switched off and on again after 2, 4, 8 ... 30 s.
 */
export const useStreamRetry = (): { up: boolean; started: () => void; failed: () => void } => {
  const [up, setUp] = useState(true);
  const tries = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );
  const started = useCallback(() => {
    tries.current = 0;
  }, []);
  const failed = useCallback(() => {
    if (timer.current !== null) return;
    setUp(false);
    const wait = Math.min(RETRY_MAX_MS, RETRY_FIRST_MS * 2 ** tries.current);
    tries.current += 1;
    timer.current = setTimeout(() => {
      timer.current = null;
      setUp(true);
    }, wait);
  }, []);
  return { up, started, failed };
};
// #endregion

/**
 * One `shared.onCc` stream per signed-in CC role. Each event marks the
 * matching queries stale, coalesced to one refetch per kind every 1.5 s. A
 * reconnect, or a move of the truck or crew to another CC, refetches everything.
 */
export const useLiveInvalidation = (role: Role, enabled: boolean): void => {
  const utils = trpc.useUtils();
  const timers = useRef(new Map<Kind, ReturnType<typeof setTimeout>>());
  const settled = useSettled();
  const retry = useStreamRetry();
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const x of pending.values()) clearTimeout(x);
      pending.clear();
    };
  }, []);
  const on = settled && enabled && retry.up && (role === "crew" || role === "driver" || role === "green" || role === "admin");
  trpc.shared.onCc.useSubscription(undefined, {
    enabled: on,
    onStarted: () => {
      retry.started();
      void utils.invalidate();
    },
    onData: (msg) => {
      // The truck or crew moved to another CC: the scope line and every list change.
      if (msg.type === "scope.changed") {
        void invalidateCached(idbStore, cacheScope(), "all").catch(() => undefined);
        void utils.invalidate();
        return;
      }
      const kind = KIND[msg.type];
      if (!kind) return;
      // The phone's copy goes at once, so a reload before the refetch lands does not draw it.
      void invalidateCached(idbStore, cacheScope(), kind).catch(() => undefined);
      if (timers.current.has(kind)) return;
      timers.current.set(
        kind,
        setTimeout(() => {
          timers.current.delete(kind);
          invalidate(utils, kind);
        }, COALESCE_MS),
      );
    },
    // The server ends the stream when the session is revoked; `me` then reads anon and the app shows the login.
    // Any other failure (a 502 during a restart) opens the stream again after a wait.
    onError: () => {
      void utils.shared.me.invalidate();
      retry.failed();
    },
  });
};
