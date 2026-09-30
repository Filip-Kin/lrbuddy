import { QueryClient } from "@tanstack/react-query";
import {
  createTRPCClient,
  httpBatchLink,
  httpSubscriptionLink,
  splitLink,
  type TRPCLink,
} from "@trpc/client";
import { createTRPCReact, type inferReactQueryProcedureOptions } from "@trpc/react-query";
import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server";
import superjson from "superjson";
import type { AppRouter } from "../../../server/routers/index.ts";

export type { AppRouter };
export type RouterInputs = inferRouterInputs<AppRouter>;
export type RouterOutputs = inferRouterOutputs<AppRouter>;
export type ReactQueryOptions = inferReactQueryProcedureOptions<AppRouter>;

// #region admin CC override
const CC_KEY = "lrb.cc";
let ccOverride: number | null = (() => {
  if (typeof window === "undefined") return null;
  const v = Number(window.sessionStorage.getItem(CC_KEY));
  return Number.isInteger(v) && v > 0 ? v : null;
})();

/** Admin only: the CC a green view acts on. Sent as `x-lrb-cc` and as the SSE `cc` param. */
export const getCcOverride = (): number | null => ccOverride;
export const setCcOverride = (cc: number | null): void => {
  ccOverride = cc;
  if (cc === null) window.sessionStorage.removeItem(CC_KEY);
  else window.sessionStorage.setItem(CC_KEY, String(cc));
};
// #endregion

const links = (): TRPCLink<AppRouter>[] => [
  splitLink({
    condition: (op) => op.type === "subscription",
    true: httpSubscriptionLink({
      url: "/trpc",
      transformer: superjson,
      connectionParams: () => {
        const cc = getCcOverride();
        return cc === null ? {} : { cc: String(cc) };
      },
    }),
    false: httpBatchLink({
      url: "/trpc",
      transformer: superjson,
      headers: () => {
        const cc = getCcOverride();
        return cc === null ? {} : { "x-lrb-cc": String(cc) };
      },
    }),
  }),
];

/** React hooks: `trpc.shared.me.useQuery()`. */
export const trpc = createTRPCReact<AppRouter>();
export const trpcReactClient = trpc.createClient({ links: links() });

/** Imperative client for code outside React (position watcher, push). */
export const api = createTRPCClient<AppRouter>({ links: links() });

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      refetchOnWindowFocus: true,
      retry: (count, err) => {
        const code = (err as { data?: { code?: string } } | null)?.data?.code;
        if (code === "UNAUTHORIZED" || code === "FORBIDDEN" || code === "NOT_FOUND") return false;
        return count < 2;
      },
    },
  },
});
