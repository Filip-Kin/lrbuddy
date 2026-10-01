import { QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { ErrorBoundary } from "./components/ErrorBoundary.tsx";
import { installGlobalErrorReporting } from "./lib/clientErrors.ts";
import { registerServiceWorker } from "./lib/push.ts";
import { queryClient, trpc, trpcReactClient } from "./lib/trpc.ts";
import { preloadLastRole } from "./routeChunks.ts";
import "./styles.css";

installGlobalErrorReporting();
preloadLastRole();

const root = document.getElementById("root");
if (!root) throw new Error("#root missing");

createRoot(root).render(
  <StrictMode>
    <trpc.Provider client={trpcReactClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <ErrorBoundary>
          <App />
        </ErrorBoundary>
      </QueryClientProvider>
    </trpc.Provider>
  </StrictMode>,
);

// Install and push only; the worker caches nothing.
if (import.meta.env.PROD) void registerServiceWorker();
