/**
 * Sign-in on the main server, where Firebase is off (SPEC 4, and SPEC 18's fallback): the staff
 * password field, the QR links that sign in on the spot, codes typed into the password field,
 * revoked codes and tokens, sign out, the login limit. Firebase on is access.e2e.ts.
 */
import { expect, expectNoOverflow, test, visit } from "../support/fixtures.ts";

interface Me {
  role: string;
  crew?: { name: string } | null;
  truck?: { name: string } | null;
}
interface Overview {
  cc: { id: number; name: string };
}

test("Firebase off: the sign-in page is the staff password and nothing else", async ({ as, base }) => {
  const { page, api, ctx } = await as("", { anon: true });
  await visit(page, "/login");
  await expect(page.getByLabel("Staff password")).toBeVisible();
  await expect(page.locator("[data-phone-signin]")).toHaveCount(0);
  const labels = await page.locator("label:visible").allInnerTexts();
  expect(labels.filter((l) => /\bcode\b/i.test(l)), "a field labelled Code").toEqual([]);
  expect(await api.query<{ firebase: boolean }>("shared.authConfig")).toEqual({ firebase: false });
  const fb = await ctx.request.post(`${base}/auth/firebase`, { data: { idToken: "x" } });
  expect(fb.status()).toBe(503);
  expect((await api.query<Me>("shared.me")).role).toBe("anon");
});

test("staff password signs in as admin, Sign out ends the session", async ({ as, admin }) => {
  const { page, api } = await as("", { anon: true });
  await visit(page, "/login");
  await page.getByLabel("Staff password").fill("not the password");
  await page.getByRole("button", { name: "Sign in" }).last().click();
  await expect(page.getByRole("alert")).toHaveText("Wrong password");
  await page.getByLabel("Staff password").fill(admin);
  await page.getByRole("button", { name: "Sign in" }).last().click();
  await page.waitForURL("**/admin");
  await expect(page.getByRole("heading", { level: 1, name: "Demo 2026" })).toBeVisible();
  await expectNoOverflow(page);
  expect((await api.query<Me>("shared.me")).role).toBe("admin");

  const burger = page.getByRole("button", { name: "Menu" });
  if (await burger.isVisible()) {
    await burger.click();
    await page.locator("[data-menu]").getByRole("button", { name: "Sign out" }).click();
  } else {
    await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Sign out" }).click();
  }
  await page.waitForURL("**/login");
  expect((await api.query<Me>("shared.me")).role).toBe("anon");
  await page.goto("/admin");
  await page.waitForURL("**/login**");
  await expect(page.getByLabel("Staff password")).toBeVisible();
});

test("crew QR /j/<token> signs the phone into the crew", async ({ as, L }) => {
  const crew = L.crews[4]!;
  const { page, api } = await as("", { anon: true });
  await page.goto(`/j/${crew.token}`);
  await page.waitForURL((u) => u.pathname === "/");
  await expect(page.locator("header")).toContainText(crew.name);
  await expect(page.getByRole("region", { name: "Crew map" })).toBeVisible();
  await expectNoOverflow(page);
  const me = await api.query<Me>("shared.me");
  expect(me.role).toBe("crew");
  expect(me.crew?.name).toBe(crew.name);
});

test("truck QR /t/<code> and CC QR /g/<code> sign in as driver and green", async ({ as, L }) => {
  const driver = await as("", { anon: true });
  await driver.page.goto(`/t/${L.truck}`);
  await driver.page.waitForURL((u) => u.pathname === "/");
  await expect(driver.page.locator("header")).toContainText(L.truckName);
  await expect(driver.page.getByRole("region", { name: "Route map" })).toBeVisible();
  expect((await driver.api.query<Me>("shared.me")).role).toBe("driver");

  const green = await as("", { anon: true });
  await green.page.goto(`/g/${L.green}`);
  await green.page.waitForURL((u) => u.pathname === "/");
  await expect(green.page.locator("header")).toContainText(`CC ${L.cc}`);
  await expect(green.page.getByRole("region", { name: "Command center map" })).toBeVisible();
  expect((await green.api.query<Me>("shared.me")).role).toBe("green");
  await expectNoOverflow(green.page);
});

test("codes typed into the staff password field: crew token, truck code, green code", async ({ as, L }) => {
  for (const [code, role, scope] of [
    [L.crews[4]!.token, "crew", L.crews[4]!.name],
    [L.truck, "driver", L.truckName],
    [L.green, "green", `CC ${L.cc}`],
  ] as const) {
    const { page, api } = await as("", { anon: true });
    await visit(page, "/login");
    await page.getByLabel("Staff password").fill(code);
    await page.getByRole("button", { name: "Sign in" }).last().click();
    await page.waitForURL((u) => u.pathname === "/");
    await expect(page.locator("header")).toContainText(scope);
    expect((await api.query<Me>("shared.me")).role).toBe(role);
  }
});

test("an unknown QR lands on the sign-in page with the reason", async ({ as }) => {
  const { page } = await as("", { anon: true });
  await page.goto("/j/no-such-crew-token");
  await page.waitForURL("**/login?link=unknown");
  await expect(page.getByText("Unknown QR code")).toBeVisible();
  await expectNoOverflow(page);
});

test("a new truck code locks out the old code and every phone that used it", async ({ as, admin, L }) => {
  const adm = await as(admin);
  const green = await as(L.green);
  const ccId = (await green.api.query<Overview>("green.overview")).cc.id;
  const truck = await adm.api.mutate<{ id: number; code: string }>("admin.trucks.create", { ccId, name: `E2E auth ${L.id}` });
  try {
    const driver = await as(truck.code);
    await visit(driver.page, "/stock");
    await expect(driver.page.getByRole("heading", { name: "Stock" })).toBeVisible();
    const fresh = await adm.api.mutate<{ code: string }>("admin.trucks.regenerateCode", { id: truck.id });
    expect(fresh.code).not.toBe(truck.code);
    expect((await driver.api.query<Me>("shared.me")).role).toBe("anon");
    await driver.page.reload();
    await driver.page.waitForURL("**/login**");
    const old = await driver.ctx.request.post("/auth/login", { data: { code: truck.code } });
    expect(old.status()).toBe(401);
    const now = await driver.ctx.request.post("/auth/login", { data: { code: fresh.code } });
    expect(now.status()).toBe(200);
  } finally {
    await adm.api.mutate("admin.trucks.delete", { id: truck.id });
  }
});

test("a new crew link locks out the old link and its phones", async ({ as, admin, L }) => {
  const adm = await as(admin);
  const green = await as(L.green);
  const ccId = (await green.api.query<Overview>("green.overview")).cc.id;
  const crew = await adm.api.mutate<{ id: number; token: string; name: string }>("admin.crews.create", { ccId, companyId: null, leadName: "E2E Lead" });
  try {
    const phone = await as("", { anon: true });
    await phone.page.goto(`/j/${crew.token}`);
    await phone.page.waitForURL((u) => u.pathname === "/");
    await expect(phone.page.locator("header")).toContainText(crew.name);
    await adm.api.mutate("admin.crews.regenerateToken", { id: crew.id });
    expect((await phone.api.query<Me>("shared.me")).role).toBe("anon");
    const again = await as("", { anon: true });
    await again.page.goto(`/j/${crew.token}`);
    await again.page.waitForURL("**/login?link=unknown");
    await expect(again.page.getByText("Unknown QR code")).toBeVisible();
  } finally {
    await adm.api.mutate("admin.crews.delete", { id: crew.id });
  }
});

test("Leave crew on the settings page signs a code session out", async ({ as, L }) => {
  const crew = L.crews[4]!;
  const { page, api } = await as(crew.token);
  await visit(page, "/settings");
  await page.getByRole("button", { name: "Leave crew" }).first().click();
  const dialog = page.getByRole("dialog");
  if (await dialog.isVisible().catch(() => false)) await dialog.getByRole("button", { name: "Leave crew" }).click();
  await page.waitForURL("**/login");
  expect((await api.query<Me>("shared.me")).role).toBe("anon");
});

test("the login limit stops the 21st try in a minute from one address", async ({ as, base }) => {
  const { ctx } = await as("", { anon: true });
  const statuses: number[] = [];
  for (let i = 0; i < 21; i++) {
    const r = await ctx.request.post(`${base}/auth/login`, { data: { code: `WRONG${i}` } });
    statuses.push(r.status());
  }
  expect(statuses.slice(0, 20).every((s) => s === 401)).toBe(true);
  expect(statuses[20]).toBe(429);
  // Another phone (another address) is not affected.
  const other = await as("", { anon: true });
  expect((await other.ctx.request.post(`${base}/auth/login`, { data: { code: "WRONG" } })).status()).toBe(401);
});
