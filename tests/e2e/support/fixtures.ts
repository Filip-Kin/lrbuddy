/**
 * Shared fixtures for the e2e specs.
 *
 * `as(who)` opens a new browser context signed in as `who` and returns its page plus a tRPC client
 * on the same cookies. `who` is a QR or invite link path (`/g/<green code>`, `/t/<truck code>`,
 * `/j/<crew token>`, `/i/<invite>`): a fresh user signs in through the fake Auth emulator and then
 * opens the link, as a person scanning after sign-in. Or `who` is the `admin` fixture: the seed's
 * admin user signs in and lands in its admin membership (SPEC 26). There is no password. Every
 * context:
 *
 * - carries its own X-Forwarded-For address (the servers trust one proxy hop), so the login limit
 *   of 20 a minute counts per context, as it would per phone;
 * - answers Esri tile requests with a blank PNG and refuses every other outside request, which then
 *   fails the test: the suite never touches the network;
 * - fails the test on an uncaught page error, and checks every open page for horizontal overflow
 *   when the test ends.
 */
import { test as base, expect, type Browser, type BrowserContext, type BrowserContextOptions, type Page } from "@playwright/test";
import { firebaseSignIn } from "./firebase.ts";
import { adminUid, laneFrom, seedCodes, type Lane, type LaneId } from "./lanes.ts";

/** The `admin` fixture's value: `as(admin)` signs in as the seed's admin user. */
const ADMIN = "admin";

// #region tRPC over the context's cookies
export class TrpcError extends Error {
  constructor(
    readonly path: string,
    readonly code: string,
    message: string,
  ) {
    super(`${path}: ${code} ${message}`);
  }
}

interface TrpcBody {
  result?: { data?: { json?: unknown } };
  error?: { json?: { message?: string; data?: { code?: string } } };
}

export class Api {
  constructor(
    private readonly ctx: BrowserContext,
    readonly base: string,
  ) {}

  private unwrap<T>(path: string, body: TrpcBody): T {
    if (body.error) throw new TrpcError(path, body.error.json?.data?.code ?? "ERROR", body.error.json?.message ?? "");
    return body.result?.data?.json as T;
  }

  async query<T = unknown>(path: string, input?: unknown): Promise<T> {
    const qs = input === undefined ? "" : `?input=${encodeURIComponent(JSON.stringify({ json: input }))}`;
    const res = await this.ctx.request.get(`${this.base}/trpc/${path}${qs}`);
    return this.unwrap<T>(path, (await res.json()) as TrpcBody);
  }

  async mutate<T = unknown>(path: string, input?: unknown): Promise<T> {
    const res = await this.ctx.request.post(`${this.base}/trpc/${path}`, { data: input === undefined ? {} : { json: input } });
    return this.unwrap<T>(path, (await res.json()) as TrpcBody);
  }

  /** The tRPC error code a call fails with, or null when it succeeds. */
  async refusal(kind: "query" | "mutate", path: string, input?: unknown): Promise<string | null> {
    try {
      if (kind === "query") await this.query(path, input);
      else await this.mutate(path, input);
      return null;
    } catch (err) {
      if (err instanceof TrpcError) return err.code;
      throw err;
    }
  }
}
// #endregion

// #region helpers
/**
 * Page errors of bugs written up in tests/e2e/FOUND.md. They become an annotation on the test
 * instead of failing it, so a known bug fails its own fixme test and not every test that happens
 * to trip over it.
 */
const KNOWN_PAGE_ERRORS: ReadonlyArray<{ id: string; match: RegExp }> = [];

let ipSerial = 0;
/** A fresh client address per context, unique across workers and projects. */
const nextIp = (): string => {
  ipSerial++;
  const w = Number(process.env.TEST_PARALLEL_INDEX ?? 0);
  return `10.${(process.pid % 200) + 1}.${w}.${ipSerial % 250}`;
};

/** A 1x1 transparent PNG; Leaflet stretches it over the tile. */
const BLANK_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");

export const overflow = (page: Page): Promise<number> => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

export const expectNoOverflow = async (page: Page, where = ""): Promise<void> => {
  expect(await overflow(page), `horizontal overflow ${where || page.url()}`).toBe(0);
};

/** Opens a route, waits for the screen, checks overflow. */
export const visit = async (page: Page, path: string): Promise<void> => {
  await page.goto(path, { waitUntil: "load" });
  // Every screen, the sign-in page included, has a <main>; a form counts too.
  await page.locator("main, form").first().waitFor();
  await page.waitForTimeout(400);
  await expectNoOverflow(page, path);
};

/** A nav link, through the hamburger on a phone. */
export const navTo = async (page: Page, name: string): Promise<void> => {
  const burger = page.getByRole("button", { name: "Menu" });
  if (await burger.isVisible()) {
    await burger.click();
    await page.locator("[data-menu]").getByRole("link", { name, exact: true }).click();
  } else {
    await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name, exact: true }).click();
  }
  await page.locator("main").first().waitFor();
};

/** Polls until fn returns something truthy. */
export const until = async <T>(fn: () => Promise<T>, what: string, timeoutMs = 15_000): Promise<NonNullable<T>> => {
  const end = Date.now() + timeoutMs;
  let last: T | undefined;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last as NonNullable<T>;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`timed out waiting for ${what} (last: ${JSON.stringify(last)?.slice(0, 300)})`);
};
// #endregion

// #region fixtures
export interface Role {
  ctx: BrowserContext;
  page: Page;
  api: Api;
  /** Uncaught page errors the test means to cause (the crash test route) go here instead. */
  allowPageErrors: boolean;
}

export interface AsOptions {
  /** Server; the main one unless the test needs Firebase on. */
  base?: string;
  name?: string;
  geo?: { latitude: number; longitude: number; accuracy?: number };
  camera?: boolean;
  /** Skip the login, for signed-out screens. */
  anon?: boolean;
  colorScheme?: "light" | "dark";
}

export interface LaneOptions {
  lane: LaneId;
}

interface Fixtures {
  /** The lane on the main server. */
  L: Lane;
  /** The same lane on the signin server, which has its own generated codes. */
  LS: Lane;
  base: string;
  /** The second server, with Firebase sign-in on (global-setup.ts). */
  signin: string;
  admin: string;
  as: (who: string, opts?: AsOptions) => Promise<Role>;
}

let userSerial = 0;

export const test = base.extend<Fixtures & LaneOptions>({
  lane: ["a", { option: true }],
  L: async ({ lane }, use) => use(laneFrom(lane, seedCodes("E2E_CODES"))),
  LS: async ({ lane }, use) => use(laneFrom(lane, seedCodes("E2E_SIGNIN_CODES"))),
  base: async ({}, use) => {
    const url = process.env.E2E_BASE_URL;
    if (!url) throw new Error("E2E_BASE_URL unset: run the suite with `bun run e2e`");
    await use(url);
  },
  signin: async ({}, use) => use(process.env.E2E_SIGNIN_URL ?? ""),
  admin: async ({}, use) => use(ADMIN),
  as: async ({ browser, base: mainUrl, viewport, isMobile, hasTouch }, use, testInfo) => {
    const opened: Array<{ role: Role; external: string[]; errors: string[]; base: string }> = [];
    const open = async (code: string, opts: AsOptions = {}): Promise<Role> => {
      const url = opts.base ?? mainUrl;
      const ctxOpts: BrowserContextOptions = {
        baseURL: url,
        viewport,
        isMobile,
        hasTouch,
        deviceScaleFactor: 1,
        colorScheme: opts.colorScheme ?? "light",
        timezoneId: "America/Detroit",
        locale: "en-US",
        extraHTTPHeaders: { "x-forwarded-for": nextIp() },
        permissions: [...(opts.geo ? ["geolocation"] : []), ...(opts.camera ? ["camera"] : [])],
        geolocation: opts.geo,
      };
      const ctx = await (browser as Browser).newContext(ctxOpts);
      const external: string[] = [];
      const errors: string[] = [];
      await ctx.route(
        (u) => u.origin !== new URL(url).origin,
        (route) => {
          const u = new URL(route.request().url());
          if (u.hostname === "server.arcgisonline.com") return route.fulfill({ status: 200, contentType: "image/png", body: BLANK_PNG });
          external.push(`${route.request().method()} ${u.origin}${u.pathname}`);
          return route.abort("internetdisconnected");
        },
      );
      if (!opts.anon) {
        const name = opts.name ?? "E2E";
        if (code === ADMIN) {
          const codes = seedCodes(url === process.env.E2E_SIGNIN_URL ? "E2E_SIGNIN_CODES" : "E2E_CODES");
          expect(await firebaseSignIn(ctx, url, adminUid(codes), "", ""), "the seed's admin user signs in as admin").toBe("entered");
        } else if (code.startsWith("/")) {
          userSerial++;
          const uid = `e2e-link-${process.pid}-${process.env.TEST_PARALLEL_INDEX ?? 0}-${userSerial}-${Date.now()}`;
          await firebaseSignIn(ctx, url, uid, name, "");
          const res = await ctx.request.get(`${url}${code}`, { maxRedirects: 0 });
          expect(res.status(), `link ${code}`).toBe(302);
          expect(res.headers()["location"], `link ${code}`).toBe("/");
        } else {
          throw new Error(`as(): not a link path or the admin fixture: ${code}`);
        }
      }
      const page = await ctx.newPage();
      const role: Role = { ctx, page, api: new Api(ctx, url), allowPageErrors: false };
      ctx.on("page", (p) => p.on("pageerror", (e) => errors.push(`${p.url()}: ${e.message}`)));
      page.on("pageerror", (e) => errors.push(`${page.url()}: ${e.message}`));
      page.on("console", (m) => {
        const who = opts.anon ? "signed out" : code;
        if (m.type() === "error") testInfo.annotations.push({ type: "console", description: `${who}: ${m.text().slice(0, 200)}` });
      });
      opened.push({ role, external, errors, base: url });
      return role;
    };
    await use(open);
    const problems: string[] = [];
    for (const { role, external, errors, base: url } of opened) {
      for (const p of role.ctx.pages()) {
        if (p.isClosed() || !p.url().startsWith(url)) continue;
        const over = await overflow(p).catch(() => 0);
        if (over !== 0) problems.push(`horizontal overflow ${over}px at ${p.url()}`);
      }
      problems.push(...external.map((e) => `outside request: ${e}`));
      for (const e of errors) {
        const known = KNOWN_PAGE_ERRORS.find((k) => k.match.test(e));
        if (known) testInfo.annotations.push({ type: "known-bug", description: `${known.id}: ${e.slice(0, 200)}` });
        else if (!role.allowPageErrors) problems.push(`page error: ${e}`);
      }
      await role.ctx.close();
    }
    expect(problems, "page checks at the end of the test").toEqual([]);
  },
});

export { expect };
// #endregion
