/** Inventory count sheet (SPEC 30): add an item, count it twice, see the change, CSV, remove. */
import { expect, expectNoOverflow, test, visit } from "../support/fixtures.ts";

test("inventory: add an item, save two counts, the change shows, CSV has both, remove", async ({ as, admin, L }) => {
  const adm = await as(admin);
  const page = adm.page;
  const name = `E2E rake ${L.id}`;
  await visit(page, "/plan/inventory");
  await expect(page.getByRole("heading", { level: 1, name: "Inventory" })).toBeVisible();
  await page.locator("[data-inventory-name]").fill(name);
  await page.locator("[data-inventory-add]").click();
  const row = page.locator(`[data-inventory-item="${name}"]`);
  await expect(row).toContainText("Not counted");
  await row.locator("[data-inventory-count]").fill("5");
  await page.locator("[data-inventory-save]").click();
  await expect(row).toContainText("5 ·");
  await row.locator("[data-inventory-count]").fill("4");
  await page.locator("[data-inventory-save]").click();
  await expect(row).toContainText("4 ·");
  await expect(row).toContainText("-1");
  await expectNoOverflow(page, "/plan/inventory");
  const csv = await adm.api.query<string>("plan.inventory.csv");
  expect(csv.split("\n").filter((l) => l.startsWith(name)).map((l) => l.split(",")[1])).toEqual(["5", "4"]);
  await row.getByRole("button", { name: `Remove ${name}` }).click();
  await expect(row).toHaveCount(0);
});
