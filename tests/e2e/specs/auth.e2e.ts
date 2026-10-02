/**
 * Sign-in on the main server (Firebase on through the fake Auth emulator): no staff password and
 * no /auth/login (SPEC 26), the seed's admin user, QR links after sign-in, links of the wrong kind
 * and unknown links refused, revoked codes and tokens, sign out, the sign-in limit. Requests and
 * approvals are access.e2e.ts; invites are invite.e2e.ts.
 */
import { expect, expectNoOverflow, test, visit } from "../support/fixtures.ts";
import { firebaseSignIn } from "../support/firebase.ts";

interface Me {
  role: string;
  crew?: { name: string } | null;
  truck?: { name: string } | null;
}
interface Overview {
  cc: { id: number; name: string };
}

test("no staff password: no password field, and /auth/login is 404 for a password and every code", async ({ as, L, base }) => {
  const { page, ctx, api } = await as("", { anon: true });
  await visit(page, "/login");
  await expect(page.locator("input[type=password]")).toHaveCount(0);
  await expect(page.getByText("Staff password")).toHaveCount(0);
  const labels = await page.locator("label:visible").allInnerTexts();
  expect(labels.filter((l) => /\bcode\b/i.test(l)), "a field labelled Code").toEqual([]);
  const codeOf = (path: string): string => path.split("/")[2]!;
  for (const code of ["e2e-admin-password", "change-me", L.crews[4]!.token, codeOf(L.truck), codeOf(L.green)]) {
    const res = await ctx.request.post(`${base}/auth/login`, { data: { code } });
    expect(res.status(), code).toBe(404);
  }
  expect((await api.query<Me>("shared.me")).role).toBe("anon");
});

test("the seed's admin user signs in as admin, Sign out ends the session", async ({ as, admin }) => {
  const { page, api } = await as(admin);
  await visit(page, "/admin");
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
});

test("crew QR /j/<token> after sign-in puts the phone in the crew", async ({ as, L }) => {
  const crew = L.crews[4]!;
  const { page, api } = await as(crew.link);
  await visit(page, "/");
  await expect(page.locator("header")).toContainText(crew.name);
  await expect(page.getByRole("region", { name: "Crew map" })).toBeVisible();
  const me = await api.query<Me>("shared.me");
  expect(me.role).toBe("crew");
  expect(me.crew?.name).toBe(crew.name);
});

test("truck QR /t/<code> and CC QR /g/<code> after sign-in: driver and green", async ({ as, L }) => {
  const driver = await as(L.truck);
  await visit(driver.page, "/");
  await expect(driver.page.locator("header")).toContainText(L.truckName);
  await expect(driver.page.getByRole("region", { name: "Route map" })).toBeVisible();
  expect((await driver.api.query<Me>("shared.me")).role).toBe("driver");

  const green = await as(L.green);
  await visit(green.page, "/");
  await expect(green.page.locator("header")).toContainText(`CC ${L.cc}`);
  await expect(green.page.getByRole("region", { name: "Command center map" })).toBeVisible();
  expect((await green.api.query<Me>("shared.me")).role).toBe("green");
});

test("a QR link signs in only as its own kind", async ({ as, L, base }) => {
  const codeOf = (path: string): string => path.split("/")[2]!;
  const { ctx, api } = await as("", { anon: true });
  for (const path of [`/j/${codeOf(L.truck)}`, `/g/${codeOf(L.truck)}`, `/t/${codeOf(L.green)}`, `/t/${L.crews[4]!.token}`]) {
    const res = await ctx.request.get(`${base}${path}`, { maxRedirects: 0 });
    expect(res.status(), path).toBe(302);
    expect(res.headers()["location"], path).toBe("/login?link=unknown");
  }
  expect((await api.query<Me>("shared.me")).role).toBe("anon");
});

test("an unknown QR lands on the sign-in page with the reason", async ({ as }) => {
  const { page } = await as("", { anon: true });
  await page.goto("/j/no-such-crew-token");
  await page.waitForURL("**/login?link=unknown");
  await expect(page.getByText("Unknown QR code")).toBeVisible();
  await expectNoOverflow(page);
});

test("a new truck code locks out the old code and every phone that used it", async ({ as, admin, L, base }) => {
  const adm = await as(admin);
  const green = await as(L.green);
  const ccId = (await green.api.query<Overview>("green.overview")).cc.id;
  const truck = await adm.api.mutate<{ id: number; code: string }>("admin.trucks.create", { ccId, name: `E2E auth ${L.id}` });
  try {
    const driver = await as(`/t/${truck.code}`);
    await visit(driver.page, "/stock");
    await expect(driver.page.getByRole("heading", { name: "Stock" })).toBeVisible();
    const fresh = await adm.api.mutate<{ code: string }>("admin.trucks.regenerateCode", { id: truck.id });
    expect(fresh.code).not.toBe(truck.code);
    expect((await driver.api.query<Me>("shared.me")).role).toBe("anon");
    await driver.page.reload();
    await driver.page.waitForURL("**/login**");
    const old = await driver.ctx.request.get(`/t/${truck.code}`, { maxRedirects: 0 });
    expect(old.headers()["location"]).toBe("/login?link=unknown");
    // Signed in again, the new code works.
    await firebaseSignIn(driver.ctx, base, `e2e-regen-${L.id}-${Date.now()}`, "E2E", "");
    const now = await driver.ctx.request.get(`/t/${fresh.code}`, { maxRedirects: 0 });
    expect(now.headers()["location"]).toBe("/");
    expect((await driver.api.query<Me>("shared.me")).role).toBe("driver");
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
    const phone = await as(`/j/${crew.token}`);
    await visit(phone.page, "/");
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

test("the sign-in limit stops the 21st try in a minute from one address", async ({ as, base }) => {
  const { ctx } = await as("", { anon: true });
  const statuses: number[] = [];
  for (let i = 0; i < 21; i++) {
    const r = await ctx.request.post(`${base}/auth/firebase`, { data: { idToken: `WRONG${i}` } });
    statuses.push(r.status());
  }
  expect(statuses.slice(0, 20).every((s) => s === 401)).toBe(true);
  expect(statuses[20]).toBe(429);
  // Another phone (another address) is not affected.
  const other = await as("", { anon: true });
  expect((await other.ctx.request.post(`${base}/auth/firebase`, { data: { idToken: "WRONG" } })).status()).toBe(401);
});
