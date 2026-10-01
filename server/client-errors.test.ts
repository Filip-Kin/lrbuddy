import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "lrbuddy-client-errors-test-"));
process.env.DATA_DIR = dir;

const ce = await import("./client-errors.ts");

afterAll(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => ce.resetClientErrorLimit());

const post = (body: unknown, ip = "1.2.3.4", role: string | null = null): Promise<Response> =>
  ce.handleClientError(new Request("http://x/client-error", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }), ip, role);

describe("POST /client-error", () => {
  test("stores the report with the session's role over the claimed one", async () => {
    const res = await post({ message: "TypeError: x is undefined", stack: "at Flag", url: "/flag", userAgent: "Phone", role: "admin" }, "1.1.1.1", "green");
    expect(res.status).toBe(204);
    const [row] = ce.recentClientErrors(1);
    expect(row?.message).toBe("TypeError: x is undefined");
    expect(row?.role).toBe("green");
    expect(row?.url).toBe("/flag");
  });

  test("rejects a body with no message", async () => {
    expect((await post({ stack: "x" })).status).toBe(400);
    expect((await post("not json")).status).toBe(400);
  });

  test("truncates long fields", async () => {
    await post({ message: "m".repeat(5000), stack: "s".repeat(9000) }, "2.2.2.2");
    const [row] = ce.recentClientErrors(1);
    expect(row?.message.length).toBe(1000);
    expect(row?.stack?.length).toBe(8000);
  });

  test("rate limits per address and recovers after the window", async () => {
    for (let i = 0; i < ce.CLIENT_ERROR_LIMIT; i++) expect((await post({ message: `e${i}` }, "9.9.9.9")).status).toBe(204);
    expect((await post({ message: "over" }, "9.9.9.9")).status).toBe(429);
    // Another phone is not held back by the first one's crash loop.
    expect((await post({ message: "other" }, "8.8.8.8")).status).toBe(204);
    const later = Date.now() + ce.CLIENT_ERROR_WINDOW_MS + 1;
    expect(ce.allowClientError("9.9.9.9", later)).toBe(true);
    expect(ce.recentClientErrors(200).some((r) => r.message === "over")).toBe(false);
  });

  test("lists newest first, at most the limit asked", async () => {
    await post({ message: "older" }, "3.3.3.3");
    await post({ message: "newer" }, "3.3.3.3");
    const rows = ce.recentClientErrors(2);
    expect(rows.map((r) => r.message)).toEqual(["newer", "older"]);
  });
});
