/**
 * Admins and invites (SPEC 26): an admin makes a single-use invite on the Invite screen and the
 * link signs a new person into the role, a second person is refused; a signed-out phone keeps the
 * invite through sign-in; a green shirt invites at its own CC only and revokes; /admin/people
 * makes and removes an admin; an Admin access request is decided on /admin/access.
 */
import { expect, expectNoOverflow, test, visit, type Role } from "../support/fixtures.ts";
import { firebaseSignIn } from "../support/firebase.ts";

interface Me {
  role: string;
}
interface Options {
  days: Array<{ id: number; label: string; ccs: Array<{ id: number; name: string; crews: Array<{ id: number; name: string }>; trucks: Array<{ id: number; name: string }> }> }>;
}
interface Created {
  id: number;
  link: string;
}

const day1Cc = async (r: Role, name: string): Promise<Options["days"][number]["ccs"][number]> => {
  const o = await r.api.query<Options>("invites.options");
  const cc = o.days.find((d) => d.label === "Day 1")?.ccs.find((c) => c.name === name);
  if (!cc) throw new Error(`no Day 1 CC ${name}`);
  return cc;
};

const pathOf = (link: string): string => new URL(link).pathname;

test("admin: a single-use green shirt invite signs one new person in, the next is refused", async ({ as, admin, L, base }) => {
  const adm = await as(admin);
  const page = adm.page;
  await visit(page, "/admin/invite");
  await page.getByRole("radio", { name: "Green shirt" }).click();
  const day = page.getByLabel("Day");
  await day.selectOption({ label: (await day.locator("option").allInnerTexts()).find((t) => t.startsWith("Day 1"))! });
  await page.getByRole("radiogroup", { name: "Command center" }).getByRole("radio", { name: `CC ${L.cc}` }).click();
  const who = `Invitee ${L.id.toUpperCase()} ${Date.now()}`;
  await page.getByLabel("Name").fill(who);
  await page.getByRole("switch", { name: "Single use" }).click();
  await page.getByRole("button", { name: "Create", exact: true }).click();

  const result = page.locator("[data-invite-result]");
  await expect(result).toBeVisible();
  await expect(result.getByRole("img", { name: /QR code/ })).toBeVisible();
  const link = (await result.locator("[data-invite-link]").innerText()).trim();
  expect(link).toMatch(/\/i\/[A-Za-z0-9_-]{16}$/);
  await result.getByRole("button", { name: "Copy" }).click();
  await expect(result.getByRole("button", { name: "Copied" })).toBeVisible();
  await expectNoOverflow(page, "invite result");
  await expect(page.locator("[data-invite-row]").filter({ hasText: who })).toContainText("Active");

  const first = await as(pathOf(link), { name: `First ${L.id}` });
  expect((await first.api.query<Me>("shared.me")).role).toBe("green");

  const second = await as("", { anon: true });
  await firebaseSignIn(second.ctx, base, `e2e-inv-second-${L.id}-${Date.now()}`, "Second", "");
  const res = await second.ctx.request.get(`${base}${pathOf(link)}`, { maxRedirects: 0 });
  expect(res.headers()["location"]).toBe("/link?state=used");
  await second.page.goto(pathOf(link));
  await expect(second.page.getByRole("alert")).toHaveText("Invite used");
  await expectNoOverflow(second.page, "invite used");
  expect((await second.api.query<Me>("shared.me")).role).toBe("none");

  await page.reload();
  await expect(page.locator("[data-invite-row]").filter({ hasText: who })).toContainText("Used");
});

test("signed out, an invite is kept through sign-in and lands the phone in the truck", async ({ as, admin, L, base }) => {
  const adm = await as(admin);
  const cc = await day1Cc(adm, L.cc);
  const truck = cc.trucks.find((t) => t.name === L.truckName)!;
  const inv = await adm.api.mutate<Created>("invites.create", { role: "driver", ccId: cc.id, truckId: truck.id, expiry: "7d" });
  const phone = await as("", { anon: true });
  await phone.page.goto(pathOf(inv.link));
  await phone.page.waitForURL("**/login");
  await expect(phone.page.getByText(`Driver, ${L.truckName}, CC ${L.cc}`)).toBeVisible();
  await expectNoOverflow(phone.page, "login with a waiting invite");
  expect(await firebaseSignIn(phone.ctx, base, `e2e-inv-truck-${L.id}-${Date.now()}`, "Drew Driver", "")).toBe("entered");
  await visit(phone.page, "/");
  await expect(phone.page.locator("header")).toContainText(L.truckName);
});

test("green shirt: invites at its own CC only, no Admin role, and Revoke shuts the link", async ({ as, admin, L, base }) => {
  const green = await as(L.green);
  const page = green.page;
  await visit(page, "/invite");
  await expect(page.getByRole("radio", { name: "Admin" })).toHaveCount(0);
  await page.getByRole("radio", { name: "Red shirt" }).click();
  await page.getByRole("radiogroup", { name: "Crew" }).getByRole("radio", { name: L.crews[5]!.name }).click();
  await page.getByRole("button", { name: "Create", exact: true }).click();
  const result = page.locator("[data-invite-result]");
  await expect(result).toBeVisible();
  const link = (await result.locator("[data-invite-link]").innerText()).trim();
  await expectNoOverflow(page, "green invite");

  // Another CC and an Admin invite are refused on the server too.
  const adm = await as(admin);
  const other = await day1Cc(adm, L.cc === "East" ? "West" : "East");
  expect(await green.api.refusal("mutate", "invites.create", { role: "green", ccId: other.id, expiry: "7d" })).toBe("FORBIDDEN");
  expect(await green.api.refusal("mutate", "invites.create", { role: "admin", expiry: "7d" })).toBe("FORBIDDEN");

  const row = page.locator("[data-invite-row]").filter({ hasText: L.crews[5]!.name }).first();
  await row.getByRole("button", { name: "Revoke" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Revoke" }).click();
  await expect(row).toContainText("Revoked");

  const late = await as("", { anon: true });
  await firebaseSignIn(late.ctx, base, `e2e-inv-late-${L.id}-${Date.now()}`, "Late", "");
  await late.page.goto(pathOf(link));
  await expect(late.page.getByRole("alert")).toHaveText("Invite revoked");
});

test("people: Make admin and Remove admin; an Admin request is approved on Access", async ({ as, admin, L, base }) => {
  const stamp = Date.now();
  const name = `People ${L.id.toUpperCase()} ${stamp}`;
  const person = await as("", { anon: true });
  expect(await firebaseSignIn(person.ctx, base, `e2e-people-${L.id}-${stamp}`, name, "")).toBe("request");

  const adm = await as(admin);
  const page = adm.page;
  await visit(page, "/admin/people");
  await page.getByLabel("Search").fill(name);
  const row = page.locator("[data-person]").filter({ hasText: name });
  await expect(row).toHaveCount(1);
  await row.getByRole("button", { name: "Make admin" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Make admin" }).click();
  await expect(row.getByText("Admin", { exact: true })).toBeVisible();
  await expectNoOverflow(page, "people");
  await row.getByRole("button", { name: "Remove admin" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Remove admin" }).click();
  await expect(row.getByRole("button", { name: "Make admin" })).toBeVisible();

  // The same person asks for Admin from the access screen; an admin approves it.
  await visit(person.page, "/");
  await person.page.getByRole("radio", { name: "Admin" }).click();
  await person.page.getByRole("button", { name: "Request", exact: true }).click();
  await expect(person.page.getByText("Pending", { exact: true })).toBeVisible();
  await expectNoOverflow(person.page, "admin request pending");
  await visit(page, "/admin/access");
  const req = page.locator("[data-access-request]").filter({ hasText: name });
  await expect(req).toContainText("Admin");
  await req.getByRole("button", { name: "Approve" }).click();
  await expect(person.page.getByRole("heading", { level: 1, name: "Demo 2026" }), "the waiting phone opens as admin").toBeVisible({ timeout: 20_000 });
  expect((await person.api.query<Me>("shared.me")).role).toBe("admin");
  // Back to no admin, so other specs see the seed's admin list as it was.
  await adm.api.mutate("people.removeAdmin", { userId: (await adm.api.query<{ people: Array<{ id: number }> }>("people.list", { q: name })).people[0]!.id });
});
