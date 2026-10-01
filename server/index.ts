import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { existsSync } from "node:fs";
import { join, normalize } from "node:path";
import { clearRole, joinByLink, linkTarget, resolveSession, upsertUser, type LinkKind } from "./access.ts";
import {
  allowLogin,
  clearCookie,
  clearJoinCookie,
  createSession,
  deleteSession,
  getSession,
  JOIN_COOKIE,
  joinCookie,
  loginWithCode,
  parseCookies,
  sessionCookie,
  sessionIdFrom,
  setSessionName,
} from "./auth.ts";
import { handleClientError } from "./client-errors.ts";
import { withEtag } from "./etag.ts";
import { firebaseEnabled, verifyIdToken } from "./firebase.ts";
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

const redirect = (location: string, cookie?: string): Response =>
  new Response(null, { status: 302, headers: cookie ? { location, "set-cookie": cookie } : { location } });

const LINK_KINDS: Record<"j" | "t" | "g", LinkKind> = { j: "crew", t: "truck", g: "cc" };
const LINK_COOKIE = /^(crew|truck|cc):([A-Za-z0-9_-]{4,64})$/;

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

    // Firebase's sign-in handler, served from our own domain so the redirect flow survives
    // Chrome's storage partitioning (Firebase docs: "authDomain on your own domain, proxy /__/auth").
    if (path.startsWith("/__/auth/") || path.startsWith("/__/firebase/")) {
      const upstream = new URL(path + url.search, "https://lrbuddy-filipkin.firebaseapp.com");
      const headers = new Headers(req.headers);
      headers.delete("host");
      headers.delete("cookie");
      const res = await fetch(upstream, {
        method: req.method,
        headers,
        body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer(),
        redirect: "manual",
      });
      const out = new Headers(res.headers);
      out.delete("content-encoding");
      out.delete("content-length");
      out.delete("transfer-encoding");
      return new Response(res.body, { status: res.status, headers: out });
    }

    if (path === "/health") {
      let dbState = "ok";
      try {
        sqlite.query("select 1").get();
      } catch {
        dbState = "error";
      }
      return json({ ok: dbState === "ok", version: config.version, db: dbState }, { status: dbState === "ok" ? 200 : 503 });
    }

    if (path === "/client-error" && req.method === "POST") {
      return handleClientError(req, clientIp(req, srv), getSession(sessionIdFrom(req))?.role ?? null);
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
      const name = setSessionName(sessionIdFrom(req), body.displayName, body.phone);
      if (!name) return json({ ok: false, error: "Name required" }, { status: sessionIdFrom(req) ? 400 : 401 });
      return json({ ok: true, displayName: name });
    }

    if (path === "/auth/firebase" && req.method === "POST") {
      if (!firebaseEnabled()) return json({ ok: false, error: "Sign-in unavailable" }, { status: 503 });
      if (!allowLogin(clientIp(req, srv))) return json({ ok: false, error: "Too many tries" }, { status: 429 });
      const body = await readBody(req);
      const token = await verifyIdToken(body.idToken ?? "");
      if (!token) return json({ ok: false, error: "Sign in again" }, { status: 401 });
      const user = upsertUser(token, body.name);
      deleteSession(sessionIdFrom(req));
      const session = createSession({ role: "none", userId: user.id, displayName: user.name, userAgent: req.headers.get("user-agent") });
      const cookies = [sessionCookie(session.id)];
      const pending = LINK_COOKIE.exec(parseCookies(req.headers.get("cookie"))[JOIN_COOKIE] ?? "");
      let state: "entered" | "choose" | "request";
      if (pending && joinByLink(user.id, session.id, pending[1] as LinkKind, pending[2]!)) state = "entered";
      else state = resolveSession(session.id, user.id);
      if (pending) cookies.push(clearJoinCookie());
      const headers = new Headers({ "content-type": "application/json" });
      for (const c of cookies) headers.append("set-cookie", c);
      return new Response(JSON.stringify({ ok: true, state }), { headers });
    }

    if (path === "/auth/leave" && req.method === "POST") {
      // A user steps out of the role and keeps the sign-in; a code session simply ends.
      const session = getSession(sessionIdFrom(req));
      if (session?.userId != null) {
        clearRole(session.id);
        return json({ ok: true, signedOut: false });
      }
      deleteSession(sessionIdFrom(req));
      return json({ ok: true, signedOut: true }, { headers: { "set-cookie": clearCookie() } });
    }

    if (path === "/auth/logout" && req.method === "POST") {
      deleteSession(sessionIdFrom(req));
      return json({ ok: true }, { headers: { "set-cookie": clearCookie() } });
    }

    // #region QR links: /j/<crew token>, /t/<truck code>, /g/<green code>
    const link = /^\/([jtg])\/([A-Za-z0-9_-]{4,64})\/?$/.exec(path);
    if (link && req.method === "GET") {
      const kind = LINK_KINDS[link[1] as "j" | "t" | "g"];
      const raw = link[2]!;
      if (!linkTarget(kind, raw)) return redirect("/login?link=unknown");
      if (!firebaseEnabled()) {
        // No Firebase project yet: the printed QR still signs in on the spot, as before SPEC 18.
        const session = loginWithCode(raw, req.headers.get("user-agent"));
        if (!session || session.role === "admin") return redirect("/login?link=unknown");
        deleteSession(sessionIdFrom(req));
        return redirect("/", sessionCookie(session.id));
      }
      const current = getSession(sessionIdFrom(req));
      if (current?.userId != null) {
        joinByLink(current.userId, current.id, kind, raw);
        return redirect("/", clearJoinCookie());
      }
      return redirect("/login", joinCookie(`${kind}:${raw}`));
    }
    // #endregion

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
      const res = await fetchRequestHandler({
        endpoint: "/trpc",
        req,
        router: appRouter,
        createContext: createContextFor(ip),
        allowMethodOverride: false,
        onError({ error, path: p }) {
          if (error.code === "INTERNAL_SERVER_ERROR") console.error(`[trpc] ${p ?? "?"}:`, error.message, error.cause ?? "");
        },
      });
      return withEtag(req, res);
    }

    return serveStatic(path);
  },
});

startRouteRefresh();
const swept = sweepPhotoFiles();
if (swept > 0) console.log(`[lrbuddy] removed ${swept} photo files with no live row`);

if (!existsSync(join(DIST, "index.html"))) console.warn(`[lrbuddy] web build missing at ${DIST}; run: bun run build`);
console.log(`[lrbuddy] ${config.version} listening on :${server.port}, data in ${config.dataDir}`);
