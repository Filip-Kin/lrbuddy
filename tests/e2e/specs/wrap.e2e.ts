/**
 * Wrap up (/wrap): the After photo round. A Todo lot with no Before carries the camera badge on
 * the Flag strip; a Before taken from the lot sheet moves the badge to the Wrap up strip and puts
 * the lot under Needs After. A tap is Done or Not done: Not done goes straight back to the list
 * and takes the lot off Needs After; Done opens the in-app camera, whose one shutter press
 * uploads the After and returns. Paint works on the Wrap up map with all six statuses. The green map never shows the badge. Works on one crewless Todo lot of the lane CC with no photos, and deletes what it took.
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

test("camera badge: Flag until the Before, Wrap up until the After, never the green map", async ({ as, L }) => {
  const green = await as(L.green, { camera: true });
  const page = green.page;
  const lots = await green.api.query<WrapLot[]>("green.wrap");
  const lot = lots.filter((l) => l.status === "open" && l.crewId === null && !l.hasBefore && !l.hasAfter && l.address).at(-1);
  expect(lot, "a crewless Todo lot with no photos at the lane CC").toBeTruthy();
  const made: number[] = [];
  const photosOf = async () => (await green.api.query<LotPhotos>("shared.lotPhotos", { lotId: lot!.id })).photos;
  const statusOf = async () => (await green.api.query<WrapLot[]>("green.wrap")).find((l) => l.id === lot!.id)?.status ?? null;
  try {
    // No Before yet: the badge is on the Flag strip.
    await page.goto("/flag");
    await expect(page.locator("[data-flag-strip]")).toBeVisible();
    await expect(page.locator(`[data-flag-strip] [data-cam-lot="${lot!.id}"]`)).toBeAttached();

    await visit(page, "/");
    await navTo(page, "Wrap up");
    await expect(page.getByRole("region", { name: "Wrap up map" })).toBeVisible();
    await expectNoOverflow(page, "/wrap");
    const tab = (name: string) => page.getByRole("tab", { name: new RegExp(`^${name}`) });
    await expect(tab("Needs After")).toHaveAttribute("aria-selected", "true");
    const row = page.locator(`[data-wrap-lot="${lot!.id}"]`);
    await expect(row).toHaveCount(0);
    await expect(page.locator(`[data-cam-lot="${lot!.id}"]`)).toHaveCount(0);

    // A tap is Done or Not done; Details opens the lot sheet. The Before goes in from the sheet.
    await tab("All").click();
    await row.click();
    const chooser = page.locator("[data-wrap-chooser]");
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: lot!.address! })).toBeVisible();
    await expect(chooser.getByRole("button")).toHaveText(["Done", "Not done", "Details"]);
    await expectNoOverflow(page, "/wrap chooser");
    await chooser.locator("[data-wrap-details]").click();
    await expect(chooser).toHaveCount(0);
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
    // No badge on the green map; the Flag strip drops it once the Before is in.
    await navTo(page, "Map");
    await expect(page.getByRole("region", { name: /map/i }).first()).toBeVisible();
    await expect(page.locator("[data-cam-lot]")).toHaveCount(0);
    await page.goto("/flag");
    await expect(page.locator("[data-flag-strip]")).toBeVisible();
    await expect(page.locator(`[data-flag-strip] [data-cam-lot="${lot!.id}"]`)).toHaveCount(0);
    await visit(page, "/");
    await navTo(page, "Wrap up");

    // Escape closes the chooser and writes nothing.
    await row.click();
    await expect(chooser).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(chooser).toHaveCount(0);
    expect((await statusOf()) ?? "").toBe("open");

    // Not done: the status at once, no camera, straight back to the list. A lot nobody finished
    // needs no After, so it leaves Needs After and loses its badge, and sits under Not done.
    await row.click();
    await chooser.locator('[data-choose="not_done"]').click();
    await expect(chooser).toHaveCount(0);
    await expect(page.locator("[data-after-camera]")).toHaveCount(0);
    await expect(row).toHaveCount(0);
    await until(async () => (await statusOf()) === "not_done", "the lot Not done on the server");
    await expect(page.locator(`[data-cam-lot="${lot!.id}"]`)).toHaveCount(0);
    await tab("Not done").click();
    await expect(row).toBeVisible();
    await expect(row).toContainText("Not done");
    await expect(page.locator(`[data-lot-id="${lot!.id}"]`).first()).toHaveClass(/lrb-lot(-shape)?-not_done/);

    // Done on a lot with a Before and no After: the in-app camera full screen. Close returns with no photo.
    await row.click();
    await chooser.locator('[data-choose="done"]').click();
    const camera = page.locator("[data-after-camera]");
    await expect(camera).toBeVisible();
    await expect(camera.locator("[data-after-title]")).toHaveText(lot!.address!);
    await until(async () => (await statusOf()) === "done", "the lot Done on the server");
    await expectNoOverflow(page, "/wrap After camera");
    await camera.locator("[data-after-close]").click();
    await expect(camera).toHaveCount(0);
    await expect(chooser).toHaveCount(0);
    expect((await photosOf()).some((p) => p.kind === "after")).toBe(false);

    // Done again: still no After, so the camera again; one shutter press is back on the list at once
    // and the After uploads behind it. The lot leaves Needs After and its badge goes.
    await tab("Needs After").click();
    await expect(row).toBeVisible();
    await row.click();
    await chooser.locator('[data-choose="done"]').click();
    await expect(camera).toBeVisible();
    const shutter = camera.locator("[data-after-shutter]");
    await expect(shutter).toBeEnabled({ timeout: 20_000 });
    await shutter.click();
    await expect(camera).toHaveCount(0);
    await expect(row).toHaveCount(0);
    made.push((await until(async () => (await photosOf()).find((p) => p.kind === "after"), "after photo on the server", 20_000)).id);
    await expect(page.locator(`[data-cam-lot="${lot!.id}"]`)).toHaveCount(0);
    await tab("All").click();
    await expect(row.locator('[data-photo="after"]')).toHaveAttribute("data-taken", "true");

    // With the After in, Done is the status alone: no camera.
    await row.click();
    await chooser.locator('[data-choose="done"]').click();
    await expect(chooser).toHaveCount(0);
    await expect(camera).toHaveCount(0);
  } finally {
    for (const id of made) await green.api.mutate("shared.deletePhoto", { id }).catch(() => undefined);
    await green.api.mutate("green.setLotStatus", { lotId: lot!.id, status: "open" }).catch(() => undefined);
  }
});

test("Paint on the Wrap up map: the green map's bar with all six statuses and Crew", async ({ as, L }) => {
  const green = await as(L.green);
  const page = green.page;
  await visit(page, "/");
  await navTo(page, "Wrap up");
  await expect(page.getByRole("region", { name: "Wrap up map" })).toBeVisible();
  await page.locator("[data-paint]").click();
  await expect(page.locator("[data-paint-bar]")).toBeVisible();
  for (const b of ["not_todo", "open", "in_progress", "done", "not_done", "do_not_touch", "crew"]) await expect(page.locator(`[data-brush="${b}"]`)).toBeVisible();
  for (const h of await page.locator("[data-brush]").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height))) expect(h).toBeGreaterThanOrEqual(44);
  await expect(page.locator("[data-paint-frame]")).toBeAttached();
  await expectNoOverflow(page, "/wrap paint bar");
  await page.locator("[data-paint-exit]").click();
  await expect(page.locator("[data-paint-bar]")).toHaveCount(0);
  await expect(page.locator("[data-paint]")).toBeVisible();
});
