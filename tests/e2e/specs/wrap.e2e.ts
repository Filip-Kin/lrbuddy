/**
 * Wrap up (/wrap): the After photo round, laid out as the Flag screen (SPEC 28). The camera on top
 * with the picked lot, its Before spot distance and the Before in a corner (hold it to see the
 * Before full size); Not done, the Done shutter and Expand along the bottom; the strip map below.
 * A tap on the strip picks a lot; the shutter makes it Done with an After and moves on; Not done
 * sets the status with no photo; List opens the lots as a sheet and a row picks its lot. The
 * camera badge is on the Flag strip until the Before, on the Wrap up strip until the After, never
 * on the green map. Works on one crewless Todo lot of the lane CC with no photos, and deletes what
 * it took.
 */
import { expect, expectNoOverflow, navTo, test, until, visit, type Role } from "../support/fixtures.ts";
import { testJpeg, type LotPhotos } from "../support/photo.ts";

interface WrapLot {
  id: number;
  address: string | null;
  lat: number;
  lng: number;
  status: string;
  crewId: number | null;
  hasBefore: boolean;
  hasAfter: boolean;
  beforeSpot: { lat: number; lng: number; heading: number | null } | null;
}

const M_LAT = 111_320;
/** `m` metres north (negative: south) of a point. */
const north = (p: { lat: number; lng: number }, m: number) => ({ lat: p.lat + m / M_LAT, lng: p.lng });

/** A Before through POST /photos, as the in-app camera sends it: where the phone stood and which way it faced. */
const postBefore = async (role: Role, lotId: number, at: { lat: number; lng: number }, heading: number): Promise<number> => {
  const res = await role.ctx.request.post(`${role.api.base}/photos`, {
    multipart: {
      lotId: String(lotId),
      kind: "before",
      lat: String(at.lat),
      lng: String(at.lng),
      heading: String(heading),
      photo: { name: "photo.jpg", mimeType: "image/jpeg", buffer: testJpeg(4) },
      thumb: { name: "thumb.jpg", mimeType: "image/jpeg", buffer: testJpeg(4, 160, 120) },
    },
  });
  const body = (await res.json()) as { ok: boolean; photo?: { id: number }; error?: string };
  expect(body.ok, `Before upload: ${body.error ?? ""}`).toBe(true);
  return body.photo!.id;
};

/** Clicks a lot's outline in the Wrap up strip, at a point where the outline is on top. */
const tapLot = async (page: Role["page"], lotId: number): Promise<void> => {
  const pt = await until(
    () =>
      page.evaluate((id) => {
        const s = document.querySelector("[data-wrap-strip]")!.getBoundingClientRect();
        for (const el of document.querySelectorAll(`[data-wrap-strip] [data-lot-id="${id}"], [data-wrap-strip] [data-cam-lot="${id}"]`)) {
          const r = el.getBoundingClientRect();
          const x = r.left + r.width / 2;
          const y = r.top + r.height / 2;
          if (x < s.left + 10 || x > s.right - 10 || y < s.top + 56 || y > s.bottom - 10) continue;
          const hit = document.elementFromPoint(x, y);
          if (hit && (hit === el || el.contains(hit))) return { x, y };
        }
        return null;
      }, lotId),
    `lot ${lotId} on the strip`,
  );
  await page.mouse.click(pt.x, pt.y);
};

test("Wrap up: strip pick, Before spot, Peek, Done shutter with an After, Not done, List", async ({ as, L }) => {
  const probe = await as(L.green);
  const lots = await probe.api.query<WrapLot[]>("green.wrap");
  const lot = lots.filter((l) => l.status === "open" && l.crewId === null && !l.hasBefore && !l.hasAfter && l.address).at(-1);
  expect(lot, "a crewless Todo lot with no photos at the lane CC").toBeTruthy();
  // Stand 12 m south of the lot; the Before was taken 1 m east of here, facing north.
  const stand = north(lot!, -12);
  const spot = { lat: stand.lat, lng: stand.lng + 1 / (M_LAT * Math.cos((stand.lat * Math.PI) / 180)) };
  const green = await as(L.green, { camera: true, geo: { latitude: stand.lat, longitude: stand.lng, accuracy: 5 } });
  const page = green.page;
  const made: number[] = [];
  const photosOf = async () => (await green.api.query<LotPhotos>("shared.lotPhotos", { lotId: lot!.id })).photos;
  const rowOf = async () => (await green.api.query<WrapLot[]>("green.wrap")).find((l) => l.id === lot!.id) ?? null;
  try {
    // No Before yet: the badge is on the Flag strip.
    await page.goto("/flag");
    await expect(page.locator("[data-flag-strip]")).toBeVisible();
    await expect(page.locator(`[data-flag-strip] [data-cam-lot="${lot!.id}"]`)).toBeAttached();

    made.push(await postBefore(green, lot!.id, spot, 0));
    expect((await rowOf())?.beforeSpot).toMatchObject({ heading: 0 });

    // No badge on the green map.
    await visit(page, "/");
    await expect(page.getByRole("region", { name: /map/i }).first()).toBeVisible();
    await expect(page.locator("[data-cam-lot]")).toHaveCount(0);

    await navTo(page, "Wrap up");
    const strip = page.locator("[data-wrap-strip]");
    await expect(strip.getByRole("region", { name: "Wrap up map" })).toBeVisible();
    await expect(page.locator("[data-wrap-shutter]")).toBeVisible();
    await expect(strip.locator(`[data-cam-lot="${lot!.id}"]`)).toBeAttached();
    const sb = (await page.locator("[data-wrap-shutter]").boundingBox())!;
    expect(Math.min(sb.width, sb.height)).toBeGreaterThanOrEqual(84);
    await expectNoOverflow(page, "/wrap");

    // A tap on the lot in the strip picks it: yellow outline, the top card, Clear, the Before spot.
    const target = page.locator("[data-wrap-target]");
    await tapLot(page, lot!.id);
    await expect(target).toHaveAttribute("data-wrap-target", String(lot!.id));
    await expect(target).toContainText(lot!.address!);
    await expect(target).toContainText("Todo");
    await expect(strip.locator(`[data-flag-pick="l:${lot!.id}"]`)).toBeAttached();
    await expect(page.locator("[data-wrap-clear]")).toBeVisible();
    const chip = page.locator("[data-wrap-spot]");
    await expect(chip).toHaveText("Before spot 1 m");
    await expect(chip).toHaveAttribute("data-near", "true");
    await expect(strip.locator("[data-spot-pin]")).toBeAttached();
    await expect(strip.locator("[data-spot-cone]")).toBeAttached();

    // Peek: holding the corner shows the Before over the whole camera; letting go shows the camera again.
    const peek = page.locator("[data-wrap-peek]");
    await expect(peek).toBeVisible();
    await expect(peek).toContainText("Hold");
    const pb = (await peek.boundingBox())!;
    expect(pb.width).toBeGreaterThanOrEqual(100);
    const view = page.locator("[data-wrap-peek-view]");
    await expect(view).toHaveAttribute("data-wrap-peek-view", "off");
    await expect(view).toBeHidden();
    await page.mouse.move(pb.x + pb.width / 2, pb.y + pb.height / 2);
    await page.mouse.down();
    await expect(view).toHaveAttribute("data-wrap-peek-view", "on");
    await expect(view).toBeVisible();
    const cam = (await page.locator("[data-wrap-camera]").boundingBox())!;
    const vb = (await view.boundingBox())!;
    expect(Math.round(vb.width)).toBe(Math.round(cam.width));
    expect(Math.round(vb.height)).toBe(Math.round(cam.height));
    await page.mouse.up();
    await expect(view).toHaveAttribute("data-wrap-peek-view", "off");
    await expect(view).toBeHidden();

    // Details from the top card opens the lot sheet.
    await page.locator("[data-wrap-details]").click();
    const sheet = page.getByRole("dialog");
    await expect(sheet.getByRole("heading", { name: lot!.address! })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    await expect(target).toHaveAttribute("data-wrap-target", String(lot!.id));

    // Clear lets go of the pick; a second tap picks it again.
    await page.locator("[data-wrap-clear]").click();
    await expect(page.locator("[data-wrap-clear]")).toHaveCount(0);
    await tapLot(page, lot!.id);
    await expect(target).toHaveAttribute("data-wrap-target", String(lot!.id));

    // The shutter: Done with the frame as the After, then on to another lot.
    const shutter = page.locator("[data-wrap-shutter]");
    await expect(shutter).toBeEnabled({ timeout: 20_000 });
    await shutter.click();
    await expect(target).not.toHaveAttribute("data-wrap-target", String(lot!.id));
    made.push((await until(async () => (await photosOf()).find((p) => p.kind === "after"), "after photo on the server", 20_000)).id);
    await until(async () => (await rowOf())?.status === "done", "the lot Done on the server");
    await expect(strip.locator(`[data-cam-lot="${lot!.id}"]`)).toHaveCount(0);

    // List: the lots as a sheet; a row picks its lot, closes the sheet, and the strip centres on it.
    const listOpen = page.locator("[data-wrap-list-open]");
    await listOpen.click();
    const list = page.locator("[data-wrap-sheet]");
    await expect(list).toBeVisible();
    const tab = (name: string) => list.getByRole("tab", { name: new RegExp(`^${name}`) });
    await expect(tab("Needs After")).toHaveAttribute("aria-selected", "true");
    const row = list.locator(`[data-wrap-lot="${lot!.id}"]`);
    await expect(row).toHaveCount(0);
    await tab("All").click();
    await expect(row).toBeVisible();
    await expect(row.locator('[data-photo="before"]')).toHaveAttribute("data-taken", "true");
    await expect(row.locator('[data-photo="after"]')).toHaveAttribute("data-taken", "true");
    await expectNoOverflow(page, "/wrap list");
    await row.click();
    await expect(list).toHaveCount(0);
    await expect(target).toHaveAttribute("data-wrap-target", String(lot!.id));
    await expect(target).toContainText("Done");
    await expect(page.locator("[data-recenter]")).toBeVisible();
    await page.locator("[data-recenter]").click();
    await expect(page.locator("[data-recenter]")).toHaveCount(0);
    await expect(target).toHaveAttribute("data-wrap-target", String(lot!.id));

    // Not done: the status, no photo, then on to another lot. The lot is under Not done in the list.
    const afters = (await photosOf()).filter((p) => p.kind === "after").length;
    await page.locator("[data-wrap-not-done]").click();
    await expect(target).not.toHaveAttribute("data-wrap-target", String(lot!.id));
    await until(async () => (await rowOf())?.status === "not_done", "the lot Not done on the server");
    expect((await photosOf()).filter((p) => p.kind === "after").length).toBe(afters);
    await listOpen.click();
    await tab("Not done").click();
    await expect(row).toBeVisible();
    await expect(row).toContainText("Not done");
    await page.keyboard.press("Escape");
    await expect(list).toHaveCount(0);
    await expect(page.locator(`[data-lot-id="${lot!.id}"]`).first()).toHaveClass(/lrb-lot(-shape)?-not_done/);
  } finally {
    for (const id of made) await green.api.mutate("shared.deletePhoto", { id }).catch(() => undefined);
    await green.api.mutate("green.setLotStatus", { lotId: lot!.id, status: "open" }).catch(() => undefined);
  }
});

test("Wrap up: Expand is the full-screen Paint map with all six statuses and Crew; Done collapses", async ({ as, L }) => {
  const green = await as(L.green, { camera: true });
  const page = green.page;
  await visit(page, "/");
  await navTo(page, "Wrap up");
  await expect(page.locator("[data-wrap-shutter]")).toBeVisible();
  await expect(page.locator("[data-paint-bar]")).toHaveCount(0);
  await page.locator("[data-wrap-expand]").click();
  await expect(page.locator("[data-wrap]")).toHaveAttribute("data-wrap-expanded", "true");
  await expect(page.locator("[data-paint-bar]")).toBeVisible();
  await expect(page.locator("[data-wrap-shutter]")).toBeHidden();
  await expect(page.locator("[data-wrap-list-open]")).toHaveCount(0);
  for (const b of ["not_todo", "open", "in_progress", "done", "not_done", "do_not_touch", "crew"]) await expect(page.locator(`[data-brush="${b}"]`)).toBeVisible();
  for (const h of await page.locator("[data-brush]").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height))) expect(h).toBeGreaterThanOrEqual(44);
  await expect(page.locator("[data-paint-frame]")).toBeAttached();
  await expectNoOverflow(page, "/wrap paint bar");
  await page.locator("[data-paint-exit]").click();
  await expect(page.locator("[data-wrap]")).toHaveAttribute("data-wrap-expanded", "false");
  await expect(page.locator("[data-paint-bar]")).toHaveCount(0);
  await expect(page.locator("[data-wrap-shutter]")).toBeVisible();
  await expect(page.locator("[data-wrap-list-open]")).toBeVisible();
});
