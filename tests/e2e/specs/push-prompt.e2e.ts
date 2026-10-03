/**
 * The Notifications prompt bar (crew and truck screens). The e2e server has no VAPID key and headless
 * Chromium reports notifications denied, so both are faked here.
 */
import { expect, test, visit } from "../support/fixtures.ts";
test("crew: Notifications bar while push is off; Close hides it for the day", async ({ as, L }) => {
  const crew = await as(L.crews[0]!.link);
  const page = crew.page;
  await page.addInitScript(() => Object.defineProperty(Notification, "permission", { get: () => "default" }));
  await page.route(/\/trpc\/[^?]*shared\.push\.key/, async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    const paths = new URL(route.request().url()).pathname.replace("/trpc/", "").split(",");
    const fix = (x: any, i: number) => (paths[i] === "shared.push.key" ? { ...x, result: { data: { json: { publicKey: "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U" } } } } : x);
    await route.fulfill({ response: res, json: Array.isArray(body) ? body.map(fix) : fix(body, 0) });
  });
  await visit(page, "/");
  await expect(page.locator("[data-push-prompt]")).toBeVisible();
  await expect(page.locator("[data-push-prompt]").getByRole("button", { name: "Turn on" })).toBeVisible();
  await page.locator("[data-push-prompt]").getByRole("button", { name: "Close" }).click();
  await expect(page.locator("[data-push-prompt]")).toHaveCount(0);
  await page.reload();
  await page.waitForTimeout(1500);
  await expect(page.locator("[data-push-prompt]")).toHaveCount(0);
});
