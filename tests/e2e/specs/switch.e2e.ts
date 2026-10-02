/**
 * Switch day, CC and role from the header (SPEC 27): CC Webb's green shirt (Day 4) takes Driver for
 * Truck B1 from the scope chip and comes back, with no reload; the same person paints on the driver
 * map (toggle brush, Do not touch, the five-status parcel sheet) while a driver-only phone gets none
 * of that; Sign out lands on /login and stays there; the admin switches to any day, CC and role and
 * back to Admin. The Switch is a bottom sheet on the phone and a popover under the chip on the laptop.
 * Painting works only on the lane's own parcels at CC Webb (lanes.ts driverAreas) and is undone.
 */
import type { Page } from "@playwright/test";
import { expect, expectNoOverflow, test, until, visit, type Role } from "../support/fixtures.ts";
import { drag, expectRedTodo, laneParcels, pickTriple, zoomOf } from "../support/map.ts";

interface Me {
  role: string;
  scope?: string;
}
interface Truck {
  id: number;
  name: string;
}
interface Bare {
  parcelId: string;
  lat: number;
  lng: number;
}
interface Area {
  label: string;
  ring: Array<[number, number]>;
}
interface DriverLot {
  id: number;
  parcelId: string | null;
  status: string;
}

/** The Switch panel: sheet on a phone (bottom of the screen), popover under the chip on a laptop. */
const openSwitch = async (page: Page): Promise<void> => {
  await page.locator("[data-scope-chip]").click();
  const panel = page.getByRole("dialog", { name: "Switch" });
  await expect(panel).toBeVisible();
  await expect(panel.locator("[data-switch]")).toBeVisible();
  const box = (await panel.boundingBox())!;
  const vp = page.viewportSize()!;
  const chip = (await page.locator("[data-scope-chip]").boundingBox())!;
  if (vp.width < 860) {
    expect(Math.round(box.y + box.height), "sheet sits on the bottom edge").toBe(vp.height);
  } else {
    await expect(page.locator("[data-switch-popover]")).toBeVisible();
    expect(box.y, "popover under the chip").toBeGreaterThanOrEqual(chip.y + chip.height);
    expect(box.y).toBeLessThan(chip.y + chip.height + 24);
    expect(box.width).toBeLessThan(500);
  }
  await expectNoOverflow(page, "switch panel");
};

/** Picks a role row in the open panel, after the day and CC chips. */
const pick = async (page: Page, day: string | null, cc: string | null, row: string): Promise<void> => {
  const panel = page.getByRole("dialog", { name: "Switch" });
  if (day) await panel.getByRole("radiogroup", { name: "Day" }).getByRole("radio", { name: new RegExp(`^${day}\\b`) }).click();
  if (cc) await panel.getByRole("radiogroup", { name: "Command center" }).getByRole("radio", { name: cc, exact: true }).click();
  await panel.locator("[data-switch-role]").filter({ hasText: new RegExp(`^${row}`) }).first().click();
  await expect(panel).toHaveCount(0);
};

const markPage = (page: Page): Promise<void> =>
  page.evaluate(() => {
    (window as unknown as { lrbNoReload?: number }).lrbNoReload = 1;
  });
const notReloaded = (page: Page): Promise<boolean> => page.evaluate(() => (window as unknown as { lrbNoReload?: number }).lrbNoReload === 1);

test("green Day 4 takes Driver for Truck B1 from the chip and comes back, no reload", async ({ as, L }) => {
  const green = await as(L.webbGreen);
  const page = green.page;
  await visit(page, "/");
  await expect(page.getByRole("region", { name: "Command center map" })).toBeVisible();
  await expect(page.locator("[data-scope-chip]")).toContainText("CC Webb");
  await markPage(page);

  await openSwitch(page);
  const panel = page.getByRole("dialog", { name: "Switch" });
  await expect(panel.getByRole("radiogroup", { name: "Day" }).getByRole("radio", { name: /^Day 4\b/ })).toHaveAttribute("aria-checked", "true");
  await expect(panel.getByRole("radio", { name: "CC Webb", exact: true })).toHaveAttribute("aria-checked", "true");
  await expect(panel.locator("[data-switch-role^='green:']")).toHaveAttribute("aria-current", "true");
  await expect(panel.locator("[data-switch-role^='driver:']").filter({ hasText: "Truck B1" })).toHaveAttribute("data-action", /^(take|enter)$/);
  await expect(panel.locator("[data-switch-admin]")).toHaveCount(0);
  await pick(page, null, null, "Truck B1");

  await expect(page.locator("[data-scope-chip]")).toContainText("Truck B1");
  await expect(page.getByRole("region", { name: "Route map" })).toBeVisible();
  expect(await notReloaded(page), "no reload of the app shell").toBe(true);
  expect((await green.api.query<Me>("shared.me")).role).toBe("driver");
  // An approved driver membership was made on the spot: Truck B1 is now a plain enter.
  const opts = await green.api.query<{ days: Array<{ ccs: Array<{ roles: Array<{ name: string; action: string; current: boolean }> }> }> }>("access.switchOptions");
  const b1 = opts.days.flatMap((d) => d.ccs).flatMap((c) => c.roles).find((r) => r.name === "Truck B1");
  expect(b1).toMatchObject({ action: "enter", current: true });

  await openSwitch(page);
  await pick(page, null, null, "Green shirt");
  await expect(page.locator("[data-scope-chip]")).toContainText("CC Webb, Day 4");
  await expect(page.getByRole("region", { name: "Command center map" })).toBeVisible();
  expect(await notReloaded(page)).toBe(true);
  expect((await green.api.query<Me>("shared.me")).role).toBe("green");
});

test("a green-and-driver user paints on the driver map; a driver-only user gets no paint and no bare parcels", async ({ as, L }) => {
  const probe = await as(L.webbGreen);
  const [bare, plan, trucks] = await Promise.all([
    probe.api.query<Bare[]>("green.parcels"),
    probe.api.query<{ areas: Area[] }>("green.plan"),
    probe.api.query<Truck[]>("green.trucks"),
  ]);
  const ok = laneParcels(bare, plan.areas, L.driverAreas);
  expect(ok.length).toBeGreaterThan(20);
  const mine = bare.filter((p) => ok.includes(p.parcelId));
  const mid = { lat: mine.reduce((t, p) => t + p.lat, 0) / mine.length, lng: mine.reduce((t, p) => t + p.lng, 0) / mine.length };
  const at = mine.reduce((a, p) => (Math.hypot(p.lat - mid.lat, p.lng - mid.lng) < Math.hypot(a.lat - mid.lat, a.lng - mid.lng) ? p : a));
  const truck = trucks.find((t) => t.name === "Truck B1")!;

  // The driver-only phone first: no Paint, no bare parcels, Do not touch off limits.
  const plain = await as(L.webbTruck, { geo: { latitude: at.lat, longitude: at.lng, accuracy: 5 } });
  await visit(plain.page, "/");
  await expect(plain.page.getByRole("region", { name: "Route map" })).toBeVisible();
  await expect(plain.page.locator("[data-lots-toggle]")).toBeVisible();
  await expect(plain.page.locator("[data-paint]")).toHaveCount(0);
  await expect(plain.page.locator("[data-parcel]")).toHaveCount(0);
  expect(await plain.api.refusal("query", "green.parcels")).toBe("FORBIDDEN");

  const user: Role = await as(L.webbGreen, { geo: { latitude: at.lat, longitude: at.lng, accuracy: 5 } });
  await user.api.mutate("access.switchTo", { role: "driver", truckId: truck.id });
  const page = user.page;
  let painted: string[] = [];
  const statuses = async (): Promise<string[]> => {
    const { lots } = await user.api.query<{ lots: DriverLot[] }>("driver.lots");
    return painted.map((pid) => lots.find((l) => l.parcelId === pid)?.status ?? "bare");
  };
  try {
    await visit(page, "/");
    await expect(page.getByRole("region", { name: "Route map" })).toBeVisible();
    await expect(page.locator(`[data-parcel="${at.parcelId}"]`)).toBeAttached();
    await page.locator("[data-paint]").click();
    await expect(page.locator("[data-paint-bar]")).toBeVisible();
    await expect(page.locator("[data-brush]")).toHaveCount(0);
    const dnt = page.locator("[data-flag-dnt-brush]");
    await expect(dnt).toHaveAttribute("aria-pressed", "false");
    expect((await dnt.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await expect(page.locator("[data-queue-button]")).toHaveCount(0);
    expect(await zoomOf(page)).toBeGreaterThanOrEqual(16);
    await expect(page.locator("[data-paint-zoom]")).toHaveCount(0);
    await expectNoOverflow(page, "driver paint");

    const tri = await until(() => pickTriple(page, "", ok), "three neighbouring bare parcels on the driver map");
    painted = tri.map((t) => t.pid);
    await drag(page, tri);
    await expectRedTodo(page, painted);
    await expect(page.locator("[data-paint-count]")).toHaveText("3 lots");
    expect(await statuses()).toEqual(["open", "open", "open"]);
    // Do not touch on its switch.
    await dnt.click();
    await page.mouse.click(tri[0].x, tri[0].y);
    await until(async () => (await statuses())[0] === "do_not_touch", "the first parcel Do not touch");
    await dnt.click();
    // Undo twice: back to bare.
    await page.locator("[data-paint-undo]").click();
    await until(async () => (await statuses())[0] === "open", "Undo of Do not touch");
    await page.locator("[data-paint-undo]").click();
    await until(async () => (await statuses()).every((x) => x === "bare"), "Undo of the stroke");
    await page.locator("[data-paint-exit]").click();
    await expect(page.locator("[data-paint-bar]")).toHaveCount(0);
    await expect(page.locator("[data-queue-button]")).toBeVisible();

    // A bare parcel opens the sheet with all five statuses, Do not touch included.
    const pid = painted[1]!;
    const box = await page.locator(`[data-parcel="${pid}"]`).boundingBox();
    await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
    const sheet = page.getByRole("dialog");
    await expect(sheet.getByRole("radiogroup", { name: "Status" })).toBeVisible();
    await expect(sheet.locator('[data-status="do_not_touch"]')).toBeEnabled();
    await expectNoOverflow(page, "driver parcel sheet");
    painted = [];
  } finally {
    for (const parcelId of painted) await probe.api.mutate("green.setLotStatus", { parcelId, status: "not_todo" }).catch(() => undefined);
  }
});

test("Sign out from the Switch lands on /login and stays there", async ({ as, L }) => {
  const green = await as(L.webbGreen);
  const page = green.page;
  await visit(page, "/");
  await openSwitch(page);
  await page.locator("[data-switch-sign-out]").click();
  await page.waitForURL("**/login");
  await page.waitForTimeout(2500);
  expect(new URL(page.url()).pathname).toBe("/login");
  await expect(page.locator("[data-phone-signin]")).toBeVisible();
  expect((await green.api.query<Me>("shared.me")).role).toBe("anon");
});

test("the admin switches to any day, CC and role, and back to Admin", async ({ as, admin, L }) => {
  const adm = await as(admin);
  const page = adm.page;
  await visit(page, "/admin");
  await expect(page.locator("[data-scope-chip]")).toContainText("Admin");
  await markPage(page);

  await openSwitch(page);
  const panel = page.getByRole("dialog", { name: "Switch" });
  await expect(panel.locator("[data-switch-admin]")).toHaveAttribute("aria-current", "true");
  for (const d of ["Day 1", "Day 4"]) await expect(panel.getByRole("radiogroup", { name: "Day" }).getByRole("radio", { name: new RegExp(`^${d}\\b`) })).toBeVisible();
  await expect(panel.locator("[data-switch-new-request]")).toHaveCount(0);
  await pick(page, "Day 1", `CC ${L.cc}`, "Green shirt");
  await expect(page.locator("[data-scope-chip]")).toContainText(`CC ${L.cc}, Day 1`);
  await expect(page.getByRole("region", { name: "Command center map" })).toBeVisible();
  expect((await adm.api.query<Me>("shared.me")).role).toBe("green");

  await openSwitch(page);
  await pick(page, "Day 4", "CC Webb", "Truck B1");
  await expect(page.locator("[data-scope-chip]")).toContainText("Truck B1");
  await expect(page.getByRole("region", { name: "Route map" })).toBeVisible();

  await openSwitch(page);
  await page.getByRole("dialog", { name: "Switch" }).locator("[data-switch-admin]").click();
  await page.waitForURL("**/admin");
  await expect(page.getByRole("heading", { level: 1, name: "Demo 2026" })).toBeVisible();
  expect(await notReloaded(page)).toBe(true);
  expect((await adm.api.query<Me>("shared.me")).role).toBe("admin");
});
