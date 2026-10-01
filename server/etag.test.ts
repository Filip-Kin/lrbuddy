import { describe, expect, test } from "bun:test";
import { REVALIDATE, withEtag } from "./etag.ts";

const json = (body: unknown): Response => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
const get = (inm?: string): Request => new Request("http://x/trpc/green.parcels", { headers: inm ? { "if-none-match": inm } : {} });

describe("withEtag", () => {
  test("tags a JSON answer and revalidates it", async () => {
    const res = await withEtag(get(), json({ a: 1 }));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe(REVALIDATE);
    const tag = res.headers.get("etag");
    expect(tag).toMatch(/^"[a-z0-9]+-[a-z0-9]+"$/);
    expect(await res.json()).toEqual({ a: 1 });
    const again = await withEtag(get(tag!), json({ a: 1 }));
    expect(again.status).toBe(304);
    expect(await again.text()).toBe("");
    // A proxy that weakened the tag still matches.
    expect((await withEtag(get(`W/${tag}`), json({ a: 1 }))).status).toBe(304);
  });

  test("a changed answer is sent in full", async () => {
    const tag = (await withEtag(get(), json({ a: 1 }))).headers.get("etag")!;
    const res = await withEtag(get(tag), json({ a: 2 }));
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).not.toBe(tag);
  });

  test("leaves errors, posts and streams alone", async () => {
    const err = new Response("{}", { status: 500, headers: { "content-type": "application/json" } });
    expect((await withEtag(get(), err)).headers.get("etag")).toBeNull();
    const post = new Request("http://x/trpc/green.paint", { method: "POST", body: "{}" });
    expect((await withEtag(post, json({}))).headers.get("etag")).toBeNull();
    const sse = new Response("data: 1\n\n", { headers: { "content-type": "text/event-stream" } });
    expect((await withEtag(get(), sse)).headers.get("etag")).toBeNull();
  });
});
