import { useEffect, useRef } from "react";
import { useSettled } from "../../lib/live.ts";
import { trpc } from "../../lib/trpc.ts";

type Utils = ReturnType<typeof trpc.useUtils>;
type Kind = "requests" | "positions" | "lots" | "stock";

/** Positions arrive every few seconds per truck and crew; admin screens only need a slow trickle. */
const COALESCE_MS: Record<Kind, number> = { requests: 1500, positions: 10_000, lots: 1500, stock: 3000 };

const KIND: Record<string, Kind> = {
  "request.changed": "requests",
  "truck.position": "positions",
  "crew.position": "positions",
  "lot.changed": "lots",
  "stock.changed": "stock",
};

const invalidate = (utils: Utils, kind: Kind): void => {
  switch (kind) {
    case "requests":
      void utils.admin.export.counts.invalidate();
      break;
    case "positions":
      void utils.admin.crews.list.invalidate();
      void utils.admin.days.get.invalidate();
      void utils.admin.export.counts.invalidate();
      break;
    case "lots":
      void utils.admin.lots.list.invalidate();
      void utils.admin.lots.counts.invalidate();
      void utils.admin.overview.invalidate();
      break;
    case "stock":
      void utils.admin.days.get.invalidate();
      break;
  }
};

/** Admin screens follow `admin.onEvent`: each event marks the matching queries stale, coalesced per kind. */
export const useAdminLive = (): void => {
  const utils = trpc.useUtils();
  const timers = useRef(new Map<Kind, ReturnType<typeof setTimeout>>());
  const settled = useSettled();
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const x of pending.values()) clearTimeout(x);
      pending.clear();
    };
  }, []);
  trpc.admin.onEvent.useSubscription(undefined, {
    enabled: settled,
    onStarted: () => {
      void utils.admin.invalidate();
    },
    onData: (msg) => {
      const kind = KIND[msg.type];
      if (!kind || timers.current.has(kind)) return;
      timers.current.set(
        kind,
        setTimeout(() => {
          timers.current.delete(kind);
          invalidate(utils, kind);
        }, COALESCE_MS[kind]),
      );
    },
  });
};
