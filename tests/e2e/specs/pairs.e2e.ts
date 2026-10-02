/**
 * Pairs zip (SPEC 15): a lot with a Before and an After shows up in the zip from the green Photos
 * page as one side by side (photos 1400 px tall, 12 px gap, 170 px header, 96 px footer, teal
 * bars) and its raw photos. Works on one crewless Todo lot of the lane CC with no photos and
 * deletes what it took. Admin's Photos page has the same button and gets the same files.
 */
import { readFile } from "node:fs/promises";
import { unzipSync } from "fflate";
import jpeg from "jpeg-js";
import { expect, test, visit } from "../support/fixtures.ts";
import { testJpeg } from "../support/photo.ts";

interface WrapLot {
  id: number;
  address: string | null;
  status: string;
  crewId: number | null;
  hasBefore: boolean;
  hasAfter: boolean;
}

test("Pairs zip: the side by side and the raw photos of every lot with both", async ({ as, L, admin }) => {
  const green = await as(L.green);
  const page = green.page;
  const lots = await green.api.query<WrapLot[]>("green.wrap");
  const lot = lots.find((l) => l.status === "open" && l.crewId === null && !l.hasBefore && !l.hasAfter && l.address);
  expect(lot, "a crewless Todo lot with no photos at the lane CC").toBeTruthy();
  const made: number[] = [];
  const upload = async (kind: "before" | "after", seed: number): Promise<void> => {
    const img = testJpeg(seed, 640, 480);
    const r = await page.request.post("/photos", {
      multipart: { lotId: String(lot!.id), kind, photo: { name: "p.jpg", mimeType: "image/jpeg", buffer: img }, thumb: { name: "t.jpg", mimeType: "image/jpeg", buffer: img } },
    });
    expect(r.status(), `${kind} upload`).toBe(200);
    made.push(((await r.json()) as { photo: { id: number } }).photo.id);
  };
  const base = lot!.address!.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const check = async (bytes: Buffer): Promise<void> => {
    const files = unzipSync(new Uint8Array(bytes));
    const names = Object.keys(files);
    expect(names).toContain(`pairs/${base}.jpg`);
    expect(names).toContain(`raw/${base}_before_1.jpg`);
    expect(names).toContain(`raw/${base}_before_2.jpg`);
    expect(names).toContain(`raw/${base}_after.jpg`);
    const img = jpeg.decode(files[`pairs/${base}.jpg`]!, { useTArray: true });
    // Two 640x480 photos at 1400 tall (1867 wide each) and the 12 px gap; header, photos, footer.
    expect(img.height).toBe(170 + 1400 + 96);
    expect(img.width).toBe(1867 * 2 + 12);
    const px = (x: number, y: number) => Array.from(img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 3));
    for (const [x, y] of [[4, 4], [img.width - 4, img.height - 4], [1867 + 6, 800]] as const) {
      const [r, g, b] = px(x, y);
      expect(Math.abs(r! - 0x0e) + Math.abs(g! - 0x30) + Math.abs(b! - 0x38), `teal at ${x},${y}`).toBeLessThan(30);
    }
  };
  try {
    await upload("before", 2);
    await upload("before", 3);
    await upload("after", 4);
    await visit(page, "/photos");
    const button = page.locator("[data-pairs-zip]");
    await expect(button).toHaveText("Pairs zip");
    const [download] = await Promise.all([page.waitForEvent("download", { timeout: 60_000 }), button.click()]);
    expect(download.suggestedFilename()).toMatch(/^lrbuddy-pairs-.*\.zip$/);
    await check(await readFile((await download.path())!));
    await expect(button).toHaveText("Pairs zip");

    const adm = await as(admin);
    await visit(adm.page, "/admin/photos");
    const [zip] = await Promise.all([adm.page.waitForEvent("download", { timeout: 60_000 }), adm.page.locator("[data-pairs-zip]").click()]);
    await check(await readFile((await zip.path())!));
  } finally {
    for (const id of made) await green.api.mutate("shared.deletePhoto", { id }).catch(() => undefined);
  }
});
