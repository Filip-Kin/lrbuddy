/**
 * Local stand-in for the production front door, which gzips responses. `scripts/perf.py` measures
 * through it so local byte counts match what a phone downloads from lrbuddy.filipkin.com.
 *
 *   bun scripts/gzip-proxy.ts 3062 http://127.0.0.1:3061
 *
 * Measurement only; the app server itself does not compress.
 */
const port = Number(process.argv[2] ?? "3062");
const upstream = (process.argv[3] ?? "http://127.0.0.1:3061").replace(/\/$/, "");

Bun.serve({
  port,
  idleTimeout: 255,
  async fetch(req) {
    const url = new URL(req.url);
    const headers = new Headers(req.headers);
    headers.delete("accept-encoding");
    headers.set("host", new URL(upstream).host);
    const res = await fetch(upstream + url.pathname + url.search, {
      method: req.method,
      headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer(),
      redirect: "manual",
    });
    const out = new Headers(res.headers);
    out.delete("content-length");
    out.delete("content-encoding");
    const type = res.headers.get("content-type") ?? "";
    const gzip = (req.headers.get("accept-encoding") ?? "").includes("gzip") && !type.includes("event-stream") && res.body !== null && res.status !== 304;
    if (!gzip) return new Response(res.body, { status: res.status, headers: out });
    out.set("content-encoding", "gzip");
    return new Response(Bun.gzipSync(new Uint8Array(await res.arrayBuffer())), { status: res.status, headers: out });
  },
});
