import { useEffect, useRef, useState } from "react";
import { trpc } from "./trpc.ts";
import type { Role } from "./session.ts";

type Utils = ReturnType<typeof trpc.useUtils>;
type Kind = "requests" | "positions" | "route" | "lots" | "stock" | "broadcast";

const COALESCE_MS = 1500;
/**
 * The stream opens a moment after the page settles. An open SSE request
 * counts as network activity forever, so opening it at once would keep the
 * page from ever reaching network idle (the gate and the screenshot harness
 * wait for that). Queries load on mount anyway and the stream's start
 * refetches them, so nothing is missed.
 */
const START_DELAY_MS = 2500;

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
      break;
    case "route":
      void utils.driver.queue.invalidate();
      void utils.driver.route.invalidate();
      void utils.crew.myRequests.invalidate();
      void utils.green.trucks.invalidate();
      void utils.green.requests.invalidate();
      break;
    case "lots":
      void utils.crew.lots.invalidate();
      void utils.crew.map.invalidate();
      void utils.green.lots.invalidate();
      void utils.green.overview.invalidate();
      void utils.green.stats.invalidate();
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
};

/**
 * One `shared.onCc` stream per signed-in CC role. Each event marks the
 * matching queries stale, coalesced to one refetch per kind every 1.5 s. A
 * reconnect refetches everything.
 */
export const useLiveInvalidation = (role: Role, enabled: boolean): void => {
  const utils = trpc.useUtils();
  const timers = useRef(new Map<Kind, ReturnType<typeof setTimeout>>());
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSettled(true), START_DELAY_MS);
    return () => clearTimeout(t);
  }, []);
  const on = settled && enabled && (role === "crew" || role === "driver" || role === "green" || role === "admin");
  trpc.shared.onCc.useSubscription(undefined, {
    enabled: on,
    onStarted: () => {
      void utils.invalidate();
    },
    onData: (msg) => {
      const kind = KIND[msg.type];
      if (!kind || timers.current.has(kind)) return;
      timers.current.set(
        kind,
        setTimeout(() => {
          timers.current.delete(kind);
          invalidate(utils, kind);
        }, COALESCE_MS),
      );
    },
  });
};
