/**
 * Wrap up (/wrap): the After photo round. A Before taken from the lot sheet puts the lot under
 * Needs After with the camera badge at the lot on the strip and the green map; the After takes it
 * off. Works on one crewless Todo lot of the lane CC with no photos, and deletes what it took.
 */
import { expect, expectNoOverflow, navTo, test, until, visit } from "../support/fixtures.ts";
import { jpegFile, type LotPhotos } from "../support/photo.ts";

interface WrapLot {
  id: number;
  address: string | null;
  status: string;
  crewId: number | null;
  hasBefore: boolean;
  hasAfter: boolean;
}

test("a Before puts the lot under Needs After with the camera badge; the After takes it off", async ({ as, L }) => {
  const green = await as(L.green, { camera: true });
  const page = green.page;
  const lots = await green.api.query<WrapLot[]>("green.wrap");
  const lot = lots.filter((l) => l.status === "open" && l.crewId === null && !l.hasBefore && !l.hasAfter && l.address).at(-1);
  expect(lot, "a crewless Todo lot with no photos at the lane CC").toBeTruthy();
  const made: number[] = [];
  const photosOf = async () => (await green.api.query<LotPhotos>("shared.lotPhotos", { lotId: lot!.id })).photos;
  try {
    await visit(page, "/");
    await navTo(page, "Wrap up");
    await expect(page.getByRole("region", { name: "Wrap up map" })).toBeVisible();
    await expectNoOverflow(page, "/wrap");
    const tab = (name: string) => page.getByRole("tab", { name: new RegExp(`^${name}`) });
    await expect(tab("Needs After")).toHaveAttribute("aria-selected", "true");
    const row = page.locator(`[data-wrap-lot="${lot!.id}"]`);
    await expect(row).toHaveCount(0);
    await expect(page.locator(`[data-cam-lot="${lot!.id}"]`)).toHaveCount(0);

    // Before from the lot sheet, opened from the All list.
    await tab("All").click();
    await row.click();
    const sheet = page.getByRole("dialog");
    await expect(sheet.getByRole("heading", { name: lot!.address! })).toBeVisible();
    await sheet.locator('[data-camera-input="before"]').setInputFiles(jpegFile("before.jpg", 3));
    made.push((await until(async () => (await photosOf()).find((p) => p.kind === "before"), "before photo on the server", 20_000)).id);
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();

    await tab("Needs After").click();
    await expect(row).toBeVisible({ timeout: 20_000 });
    await expect(row.locator('[data-photo="before"]')).toHaveAttribute("data-taken", "true");
    await expect(row.locator('[data-photo="after"]')).toHaveAttribute("data-taken", "false");
    await expect(page.locator(`[data-cam-lot="${lot!.id}"]`)).toBeAttached();
    await expectNoOverflow(page, "/wrap with a lot under Needs After");
    // The same badge on the green map.
    await navTo(page, "Map");
    await expect(page.locator(`[data-cam-lot="${lot!.id}"]`)).toBeAttached();
    await navTo(page, "Wrap up");

    // After from the same sheet: the lot leaves Needs After and loses its badge.
    await row.click();
    await expect(sheet.getByRole("heading", { name: lot!.address! })).toBeVisible();
    await sheet.locator('[data-camera-input="after"]').setInputFiles(jpegFile("after.jpg", 4));
    made.push((await until(async () => (await photosOf()).find((p) => p.kind === "after"), "after photo on the server", 20_000)).id);
    await page.keyboard.press("Escape");
    await expect(row).toHaveCount(0, { timeout: 20_000 });
    await expect(page.locator(`[data-cam-lot="${lot!.id}"]`)).toHaveCount(0);
    await tab("All").click();
    await expect(row.locator('[data-photo="after"]')).toHaveAttribute("data-taken", "true");
  } finally {
    for (const id of made) await green.api.mutate("shared.deletePhoto", { id }).catch(() => undefined);
  }
});
