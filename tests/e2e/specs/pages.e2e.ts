/**
 * Every screen of every role (the route list of scripts/gate.py) opens, fits the viewport, shows
 * no raw undefined or NaN, and on a phone has the hamburger at the left that opens the menu from
 * the left and closes on Escape and on the scrim. Read only.
 */
import { expect, expectNoOverflow, test, visit, type Role } from "../support/fixtures.ts";

const ROUTES: Record<string, string[]> = {
  crew: ["/", "/request", "/requests", "/lots", "/cc", "/settings"],
  driver: ["/", "/stock", "/settings"],
  green: ["/", "/flag", "/requests", "/photos", "/crews", "/trucks", "/broadcast", "/stats", "/access"],
  admin: ["/admin", "/admin/companies", "/admin/crews", "/admin/lots", "/admin/photos", "/admin/catalog", "/admin/export", "/admin/access", "/admin/client-errors", "/admin/green"],
};
/** The planning portal is a laptop surface with one phone screen, drive mode (gate ROUTE_SIZES). */
const PLAN_LAPTOP = ["/plan/survey", "/plan/blocks", "/plan/assignments"];
const PLAN_PHONE = ["/plan/survey/drive"];

const checkScreen = async (role: Role, path: string, phone: boolean): Promise<void> => {
  const page = role.page;
  await visit(page, path);
  await page.waitForTimeout(400);
  await expectNoOverflow(page, path);
  // The client error list shows browser error messages as they came, "undefined" and all.
  const text = path === "/admin/client-errors" ? await page.locator("header").innerText() : await page.locator("body").innerText();
  expect(text, `${path}: raw values on screen`).not.toMatch(/\b(undefined|NaN|\[object Object\])\b/);
  expect(text, `${path}: em dash on screen`).not.toContain("\u2014");
  const burger = page.getByRole("button", { name: "Menu" });
  if (!phone) {
    await expect(burger, `${path}: hamburger at 1440 px`).toBeHidden();
    return;
  }
  await expect(burger, `${path}: hamburger at 390 px`).toBeVisible();
  const b = (await burger.boundingBox())!;
  expect(b.x + b.width / 2, `${path}: hamburger on the left`).toBeLessThan(195);
  await burger.click();
  await expect(burger).toHaveAttribute("aria-expanded", "true");
  const menu = page.locator("[data-menu]");
  expect((await menu.boundingBox())!.x, `${path}: menu slides in from the left`).toBeLessThanOrEqual(1);
  await page.keyboard.press("Escape");
  await expect(burger).toHaveAttribute("aria-expanded", "false");
  await burger.click();
  await page.locator("[data-scrim]").click({ position: { x: 5, y: 5 }, force: true });
  await expect(burger).toHaveAttribute("aria-expanded", "false");
};

for (const [role, routes] of Object.entries(ROUTES)) {
  test(`${role}: every screen opens and fits`, async ({ as, admin, L, isMobile }) => {
    const code = role === "crew" ? L.crews[4]!.token : role === "driver" ? L.truck : role === "green" ? L.green : admin;
    // No location permission: a position would move the crew or truck on everyone else's map.
    const r = await as(code, { camera: role === "green" });
    for (const path of routes) await checkScreen(r, path, isMobile);
  });
}

test("planning portal screens open and fit", async ({ as, admin, isMobile }) => {
  const r = await as(admin);
  for (const path of isMobile ? PLAN_PHONE : PLAN_LAPTOP) {
    await visit(r.page, path);
    await r.page.waitForTimeout(500);
    await expectNoOverflow(r.page, path);
    expect(await r.page.locator("body").innerText()).not.toMatch(/\b(undefined|NaN)\b/);
  }
});

test("old paths land where they moved", async ({ as, admin, L }) => {
  const adm = await as(admin);
  await adm.page.goto("/admin/print");
  await adm.page.waitForURL("**/plan/print");
  const driver = await as(L.truck);
  await driver.page.goto("/map");
  await driver.page.waitForURL((u) => u.pathname === "/");
  await expect(driver.page.getByRole("region", { name: "Route map" })).toBeVisible();
});

test("signed out, a role's screen sends the phone to the sign-in page", async ({ as }) => {
  const anon = await as("", { anon: true });
  for (const path of ["/", "/admin", "/plan/survey"]) {
    await anon.page.goto(path);
    await anon.page.waitForURL("**/login**");
    await expect(anon.page.getByLabel("Staff password")).toBeVisible();
  }
  const health = await anon.ctx.request.get("/health");
  expect(await health.json()).toMatchObject({ ok: true, db: "ok" });
});
