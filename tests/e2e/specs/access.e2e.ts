/**
 * Sign-in and access requests with Firebase on (SPEC 18), against the signin server. A person
 * signs in (an unsigned emulator token, support/firebase.ts), asks for a red shirt role, the
 * green shirt approves it on the Access page and the person's phone moves into the crew live;
 * Leave crew keeps the sign-in; a crew QR scanned before sign-in completes after it; a truck QR
 * on a signed-in phone makes it a driver; admin sees the decision.
 */
import { expect, expectNoOverflow, test, visit } from "../support/fixtures.ts";
import { firebaseSignIn } from "../support/firebase.ts";

test("sign in, request a red shirt role, the green shirt approves, the phone moves into the crew", async ({ as, L, LS, signin, admin }) => {
  const uid = `e2e-red-${L.id}-${Date.now()}`;
  const name = `Jordan Reed ${L.id.toUpperCase()}`;
  const red = await as("", { anon: true, base: signin });
  const page = red.page;
  await visit(page, "/login");
  await expect(page.locator("input[type=password]")).toHaveCount(0);
  expect(await firebaseSignIn(red.ctx, signin, uid, name, `${L.phone}1`)).toBe("request");

  await visit(page, "/");
  await expect(page.getByRole("radiogroup", { name: "Role" })).toBeVisible();
  await page.getByRole("radio", { name: "Red shirt" }).click();
  // Day defaults to today in Detroit (SPEC 18). Keep it when it has command centers, so the
  // membership counts as today's; on a date with none, Day 1. The two lanes take different picks.
  const ccs = page.getByRole("radiogroup", { name: "Command center" }).getByRole("radio");
  if ((await ccs.count()) === 0) {
    const day = page.getByLabel("Day");
    await day.selectOption({ label: (await day.locator("option").allInnerTexts()).find((t) => t.startsWith("Day 1"))! });
  }
  await expect(ccs.first()).toBeVisible();
  const ccPick = L.id === "a" ? ccs.first() : ccs.last();
  const ccName = (await ccPick.innerText()).trim();
  await ccPick.click();
  const companies = page.getByRole("radiogroup", { name: "Company" }).getByRole("radio");
  await (L.id === "a" ? companies.first() : companies.last()).click();
  const crewPick = page.getByRole("radiogroup", { name: "Crew" }).getByRole("radio").first();
  const crewName = (await crewPick.innerText()).trim();
  await crewPick.click();
  await expectNoOverflow(page, "access request form");
  await page.getByRole("button", { name: "Request", exact: true }).click();
  await expect(page.getByText("Pending", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Call" }).first()).toHaveAttribute("href", /^tel:/);
  await expectNoOverflow(page, "pending");

  // The green shirt signs in and scans the CC's QR.
  const green = await as(LS.greens[ccName]!, { base: signin });
  const gp = green.page;
  await visit(gp, "/access");
  const req = gp.locator("[data-access-request]").filter({ hasText: name });
  await expect(req).toHaveCount(1);
  await expect(req).toContainText(crewName);
  const burger = gp.getByRole("button", { name: "Menu" });
  if (await burger.isVisible()) {
    await burger.click();
    await expect(gp.locator("[data-menu]").getByRole("link", { name: /Access/ })).toContainText(/\d/);
    await gp.keyboard.press("Escape");
  } else {
    await expect(gp.getByRole("navigation", { name: "Main" }).getByRole("link", { name: /Access/ })).toContainText(/\d/);
  }
  await req.getByRole("button", { name: "Approve" }).click();
  // Seeded crews have a red shirt already: Replace lead or Add.
  await expect(gp.getByRole("button", { name: "Replace lead" })).toBeVisible();
  await gp.getByRole("button", { name: "Add", exact: true }).click();
  await expect(gp.locator("[data-access-request]").filter({ hasText: name })).toHaveCount(0);

  await expect(page.getByRole("region", { name: "Crew map" }), "the red shirt's phone moves into the crew without a reload").toBeVisible({ timeout: 20_000 });
  await expect(page.locator("header")).toContainText(crewName);

  // Leave crew keeps the sign-in: the access screen offers the approved crew again.
  await visit(page, "/settings");
  await page.getByRole("button", { name: "Leave crew" }).first().click();
  await page.getByRole("dialog").getByRole("button", { name: "Leave crew" }).click();
  await expect(page.getByText("Sign in as")).toBeVisible();
  await page.getByRole("button", { name: crewName }).click();
  await expect(page.getByRole("region", { name: "Crew map" })).toBeVisible();

  const adm = await as(admin, { base: signin });
  await visit(adm.page, "/admin/access");
  await expect(adm.page.getByRole("main")).toContainText(name);
});

test("a crew QR scanned before sign-in completes after it; a truck QR then makes the phone a driver", async ({ as, LS: L, signin }) => {
  const crew = L.crews[2]!;
  const qr = await as("", { anon: true, base: signin });
  const page = qr.page;
  await page.goto(crew.link);
  await page.waitForURL("**/login");
  await expect(page.getByText(new RegExp(`${crew.name}, .*CC ${L.cc}`))).toBeVisible();
  await expectNoOverflow(page);
  expect(await firebaseSignIn(qr.ctx, signin, `e2e-qr-${L.id}-${Date.now()}`, `Sam Ortiz ${L.id.toUpperCase()}`, `${L.phone}2`)).toBe("entered");
  await visit(page, "/");
  await expect(page.getByRole("region", { name: "Crew map" })).toBeVisible();
  await expect(page.locator("header")).toContainText(crew.name);

  await page.goto(L.truck);
  await page.waitForURL((u) => u.pathname === "/");
  await expect(page.locator("header")).toContainText(L.truckName);
  await expect(page.getByRole("region", { name: "Route map" })).toBeVisible();
});

test("with Firebase on, /j before sign-in remembers the link instead of signing in", async ({ as, LS, signin }) => {
  const anon = await as("", { anon: true, base: signin });
  const res = await anon.ctx.request.get(`${signin}${LS.crews[2]!.link}`, { maxRedirects: 0 });
  expect(res.status()).toBe(302);
  expect(res.headers()["location"]).toBe("/login");
  expect(res.headers()["set-cookie"] ?? "").toContain("lrb_join=");
  expect((await anon.api.query<{ firebase: boolean }>("shared.authConfig")).firebase).toBe(true);
  expect((await anon.api.query<{ role: string }>("shared.me")).role).toBe("anon");
});
