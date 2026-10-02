/**
 * Repros for the bugs in tests/e2e/FOUND.md, marked fixme until the fix lands. Each states the
 * behaviour the app should have; flip test.fixme to test to check a fix.
 */
import { expect, test, visit } from "../support/fixtures.ts";

interface CrewLot {
  address: string | null;
}

// FOUND-1 (tests/e2e/FOUND.md#found-1-leaving-a-map-while-it-zooms-throws-_leaflet_pos)
test.fixme("FOUND-1: leaving the green map while it zooms throws no error and reports nothing", async ({ as, L, admin }) => {
  const green = await as(L.green);
  const page = green.page;
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const adm = await as(admin);
  const reportsBefore = (await adm.api.query<Array<{ id: number }>>("admin.clientErrors")).length;
  for (const wait of [0, 100, 200]) {
    await visit(page, "/");
    await page.waitForTimeout(1200);
    await page.locator(".leaflet-control-zoom-in").click();
    await page.waitForTimeout(wait);
    const burger = page.getByRole("button", { name: "Menu" });
    if (await burger.isVisible()) {
      await burger.click();
      await page.locator("[data-menu]").getByRole("link", { name: "Crews", exact: true }).click();
    } else {
      await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Crews", exact: true }).click();
    }
    await page.waitForTimeout(600);
  }
  expect(errors).toEqual([]);
  expect((await adm.api.query<Array<{ id: number }>>("admin.clientErrors")).length).toBe(reportsBefore);
});

// FOUND-2 (tests/e2e/FOUND.md#found-2-land-bank-addresses-keep-the-land-banks-capitals)
test.fixme("FOUND-2: a crew's lots list writes every address the same way", async ({ as, L }) => {
  const crew = await as(L.crews[0]!.token);
  const shouting = (await crew.api.query<CrewLot[]>("crew.lots")).map((l) => l.address ?? "").filter((a) => /[A-Z]{3,}/.test(a) && !/[a-z]/.test(a));
  expect(shouting, "addresses in capitals next to title case ones").toEqual([]);
});
