import { storageGet, storageSet } from "./safe.ts";

/**
 * Crash reports to `POST /client-error`: the error boundaries, `window.onerror` and unhandled
 * rejections. A blank screen in the field then leaves a row on `/admin/client-errors`.
 */

/** Per page load: a render loop must not post forever. The server limits too. */
const MAX_PER_LOAD = 20;
/** The same message within this long is one report. */
const REPEAT_MS = 10_000;

let role: string | null = null;
let sent = 0;
const lastSent = new Map<string, number>();

/** The signed-in role, sent with every report once `shared.me` has answered. */
export const setReportRole = (r: string | null): void => {
  role = r;
};

const describe = (err: unknown): { message: string; stack: string | null } => {
  if (err instanceof Error) return { message: `${err.name}: ${err.message}`, stack: err.stack ?? null };
  if (typeof err === "string") return { message: err, stack: null };
  try {
    return { message: JSON.stringify(err) ?? String(err), stack: null };
  } catch {
    return { message: String(err), stack: null };
  }
};

export const errorMessage = (err: unknown): string => describe(err).message;

/** A failed `import()` after a deploy replaced the chunk files. */
export const isChunkLoadError = (err: unknown): boolean =>
  /dynamically imported module|Importing a module script failed|error loading dynamically imported|Failed to fetch dynamically/i.test(describe(err).message);

export const reportError = (err: unknown, extraStack?: string | null): void => {
  const { message, stack } = describe(err);
  const now = Date.now();
  if (sent >= MAX_PER_LOAD || now - (lastSent.get(message) ?? 0) < REPEAT_MS) return;
  sent += 1;
  lastSent.set(message, now);
  const body = JSON.stringify({
    message,
    stack: [stack, extraStack].filter(Boolean).join("\n\nComponent stack:") || null,
    url: window.location.pathname + window.location.search,
    userAgent: navigator.userAgent,
    role,
  });
  try {
    void fetch("/client-error", { method: "POST", headers: { "content-type": "application/json" }, body, credentials: "same-origin", keepalive: true }).catch(() => undefined);
  } catch {
    // Reporting must never throw on top of the error it reports.
  }
};

/**
 * One reload per tab when a lazy screen fails to load: after a deploy the old chunk names are
 * gone and the fresh index.html points at the new ones.
 */
const RELOAD_KEY = "lrb.chunkReload";
export const reloadOnceForChunk = (err: unknown): boolean => {
  if (!isChunkLoadError(err)) return false;
  if (storageGet("session", RELOAD_KEY)) return false;
  storageSet("session", RELOAD_KEY, "1");
  // Storage refused: no way to know this is the second try, so no reload loop.
  if (!storageGet("session", RELOAD_KEY)) return false;
  window.location.reload();
  return true;
};

declare global {
  interface Window {
    /** Set once this module's handlers are in; the boot script in index.html stops reporting then. */
    __lrbBooted?: boolean;
  }
}

export const installGlobalErrorReporting = (): void => {
  window.__lrbBooted = true;
  window.addEventListener("error", (e) => {
    // Resource load errors (an <img> 404) have no `error` and are not crashes.
    if (e.error === undefined && !e.message) return;
    reportError(e.error ?? e.message);
  });
  window.addEventListener("unhandledrejection", (e) => {
    reportError(e.reason);
  });
};
