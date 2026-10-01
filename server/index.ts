import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { existsSync } from "node:fs";
import { join, normalize } from "node:path";
import { allowLogin, clearCookie, deleteSession, getSession, joinWithToken, loginWithCode, sessionCookie, sessionIdFrom, setSessionName } from "./auth.ts";
import { config } from "./config.ts";
import { sqlite } from "./db/index.ts";
import { startRouteRefresh } from "./dispatch.ts";
import { eventPhotos, handlePhotoUpload, photoZipStream, servePhoto, sweepPhotoFiles } from "./photos.ts";
import { activeEvent } from "./queries.ts";
import { appRouter } from "./routers/index.ts";
import { createContextFor } from "./trpc.ts";

const DIST = config.webDist.endsWith("/") ? config.webDist : `${config.webDist}/`;

const json = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(body), { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });

/**
 * The socket address, or with TRUST_PROXY_HOPS set, the X-Forwarded-For entry
 * the outermost trusted proxy appended. The left-most entry is whatever the
 * caller sent, so keying the login limit on it lets anyone reset the limit.
 */
const clientIp = (req: Request, server: { requestIP(r: Request): { address: string } | null }): string => {
  const socket = server.requestIP(req)?.address || "unknown";
  if (config.trustProxyHops === 0) return socket;
  const list = (req.headers.get("x-forwarded-for") ?? "").split(",").map((v) => v.trim()).filter(Boolean);
  return list[list.length - config.trustProxyHops] ?? socket;
};

// #region static
const IMMUTABLE = /^\/assets\//;

const serveStatic = async (pathname: string): Promise<Response> => {
  const rel = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "").replace(/^\/+/, "");
  if (rel && !rel.endsWith("/")) {
    const file = Bun.file(join(DIST, rel));
    if (await file.exists()) {
      const headers: Record<string, string> = {};
      if (IMMUTABLE.test(pathname)) headers["cache-control"] = "public, max-age=31536000, immutable";
      else if (rel === "sw.js") headers["cache-control"] = "no-cache";
      return new Response(file, { headers });
    }
  }
  // Paths that look like files and are missing are real 404s, not the app shell.
  if (/\.[a-z0-9]{2,5}$/i.test(rel)) return new Response("Not found", { status: 404 });
  const shell = Bun.file(join(DIST, "index.html"));
  if (await shell.exists()) return new Response(shell, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } });
  return new Response("Web build missing. Run: bun run build", { status: 503 });
};
// #endregion

// #region auth routes
/** JSON body (or a form post) as string fields. */
const readBody = async (req: Request): Promise<Record<string, string>> => {
  const out: Record<string, string> = {};
  const type = req.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    const body: unknown = await req.json().catch(() => null);
    if (typeof body === "object" && body !== null) {
      for (const [k, v] of Object.entries(body)) if (typeof v === "string") out[k] = v;
    }
    return out;
  }
  const form = await req.formData().catch(() => null);
  form?.forEach((v, k) => {
    if (typeof v === "string") out[k] = v;
  });
  return out;
};
// #endregion

const server = Bun.serve({
  port: config.port,
  idleTimeout: 255,
  async fetch(req, srv) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/health") {
      let dbState = "ok";
      try {
        sqlite.query("select 1").get();
      } catch {
        dbState = "error";
      }
      return json({ ok: dbState === "ok", version: config.version, db: dbState }, { status: dbState === "ok" ? 200 : 503 });
    }

    if (path === "/auth/login" && req.method === "POST") {
      if (!allowLogin(clientIp(req, srv))) return json({ ok: false, error: "Too many tries" }, { status: 429 });
      const body = await readBody(req);
      const session = loginWithCode(body.code ?? "", req.headers.get("user-agent"), body.displayName);
      if (!session) return json({ ok: false, error: "Unknown code" }, { status: 401 });
      deleteSession(sessionIdFrom(req));
      return json({ ok: true, role: session.role }, { headers: { "set-cookie": sessionCookie(session.id) } });
    }

    if (path === "/auth/name" && req.method === "POST") {
      const body = await readBody(req);
      const name = setSessionName(sessionIdFrom(req), body.displayName);
      if (!name) return json({ ok: false, error: "Name required" }, { status: sessionIdFrom(req) ? 400 : 401 });
      return json({ ok: true, displayName: name });
    }

    if (path === "/auth/logout" && req.method === "POST") {
      deleteSession(sessionIdFrom(req));
      return json({ ok: true }, { headers: { "set-cookie": clearCookie() } });
    }

    const join = /^\/j\/([A-Za-z0-9_-]{4,64})\/?$/.exec(path);
    if (join && req.method === "GET") {
      const session = joinWithToken(join[1]!, req.headers.get("user-agent"));
      if (!session) return new Response(null, { status: 302, headers: { location: "/login?link=unknown" } });
      deleteSession(sessionIdFrom(req));
      return new Response(null, { status: 302, headers: { location: "/", "set-cookie": sessionCookie(session.id) } });
    }

    // #region photos
    if (path === "/photos" && req.method === "POST") return handlePhotoUpload(req);

    const photo = /^\/photos\/(\d+)(\/thumb)?\/?$/.exec(path);
    if (photo && (req.method === "GET" || req.method === "HEAD")) return servePhoto(req, Number(photo[1]), photo[2] !== undefined);

    if (path === "/admin/photos.zip" && req.method === "GET") {
      if (getSession(sessionIdFrom(req))?.role !== "admin") return new Response("Sign in", { status: 401 });
      const ev = activeEvent();
      if (!ev) return new Response("No active event", { status: 404 });
      const id = (k: string): number | null => {
        const n = Number(url.searchParams.get(k) ?? "");
        return Number.isInteger(n) && n > 0 ? n : null;
      };
      const rows = eventPhotos(ev.id, { dayId: id("day"), ccId: id("cc") });
      const stamp = new Date().toLocaleDateString("sv-SE", { timeZone: "America/Detroit" });
      const name = `lrbuddy-photos-${stamp}.zip`;
      return new Response(photoZipStream(rows), {
        headers: { "content-type": "application/zip", "content-disposition": `attachment; filename="${name}"`, "cache-control": "no-store" },
      });
    }
    // #endregion

    if (path === "/trpc" || path.startsWith("/trpc/")) {
      const ip = clientIp(req, srv);
      return fetchRequestHandler({
        endpoint: "/trpc",
        req,
        router: appRouter,
        createContext: createContextFor(ip),
        allowMethodOverride: false,
        onError({ error, path: p }) {
          if (error.code === "INTERNAL_SERVER_ERROR") console.error(`[trpc] ${p ?? "?"}:`, error.message, error.cause ?? "");
        },
      });
    }

    return serveStatic(path);
  },
});

startRouteRefresh();
const swept = sweepPhotoFiles();
if (swept > 0) console.log(`[lrbuddy] removed ${swept} photo files with no live row`);

if (!existsSync(join(DIST, "index.html"))) console.warn(`[lrbuddy] web build missing at ${DIST}; run: bun run build`);
console.log(`[lrbuddy] ${config.version} listening on :${server.port}, data in ${config.dataDir}`);
