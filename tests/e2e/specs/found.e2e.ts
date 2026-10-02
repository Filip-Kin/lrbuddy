/**
 * Repros for the bugs in tests/e2e/FOUND.md. Each states the behaviour the app should have; a bug
 * still open is marked test.fixme until its fix lands.
 */
import { expect, test, visit } from "../support/fixtures.ts";

interface CrewLot {
  address: string | null;
}

// FOUND-1 (tests/e2e/FOUND.md#found-1-leaving-a-map-while-it-zooms-throws-_leaflet_pos)
test("FOUND-1: leaving the green map while it zooms throws no error and reports nothing", async ({ as, L, admin }) => {
  const green = await as(L.green);
  const page = green.page;
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const adm = await as(admin);
  // Only green reports: the admin crash test files its own report on the same server at the same time.
  const greenReports = async (): Promise<number> =>
    (await adm.api.query<Array<{ role: string | null }>>("admin.clientErrors")).filter((r) => r.role === "green").length;
  const reportsBefore = await greenReports();
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
  // The taps above go through Playwright's round trips, which can land after the zoom has ended.
  // These land inside the zoom for certain: the zoom and the route change from one script in the
  // page, the route change the same pushState a nav Link makes.
  for (const ms of [0, 50, 150]) {
    await visit(page, "/");
    await page.waitForTimeout(1200);
    await page.evaluate(
      (delay) =>
        new Promise<void>((done) => {
          document.querySelector<HTMLElement>(".leaflet-control-zoom-in")?.click();
          setTimeout(() => {
            history.pushState(null, "", "/crews");
            done();
          }, delay);
        }),
      ms,
    );
    await page.waitForTimeout(600);
  }
  expect(errors).toEqual([]);
  expect(await greenReports()).toBe(reportsBefore);
});

// FOUND-2 (tests/e2e/FOUND.md#found-2-land-bank-addresses-keep-the-land-banks-capitals)
test("FOUND-2: a crew's lots list writes every address the same way", async ({ as, L }) => {
  const crew = await as(L.crews[0]!.token);
  const shouting = (await crew.api.query<CrewLot[]>("crew.lots")).map((l) => l.address ?? "").filter((a) => /[A-Z]{3,}/.test(a) && !/[a-z]/.test(a));
  expect(shouting, "addresses in capitals next to title case ones").toEqual([]);
});
