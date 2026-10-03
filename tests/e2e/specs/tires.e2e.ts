/**
 * Tire piles (SPEC 29) at Day 4's CC Webb. A red shirt drops a pile at its blue dot and another
 * crew of the CC sees it appear live; the green map shows it and the green shirt adds one at a
 * tapped spot; the truck's map shows both, and the driver drops one at the truck that the crew and
 * the green shirt then see. The pile's photo is taken in Wrap up: the
 * pile carries the camera badge on the strip, a tap picks it, the shutter (Photo) sends the frame,
 * the badge goes, and the green map's pile sheet shows the photo full screen. The crew deletes its
 * own pile and cannot delete another's.
 *
 * Each lane works in crew rectangles no other spec touches (lane a: GM 6 and GM 8, lane b: GM 15
 * and GM 9) and with its own truck (lane a: Truck B2, lane b: Truck B1), and deletes every pile it made.
 */
import { expect, test, until, type Role } from "../support/fixtures.ts";
import { seedCodes } from "../support/lanes.ts";

interface Pile {
  id: number;
  lat: number;
  lng: number;
  madeBy: string;
  crewId: number | null;
  photoAt: number | null;
  mine: boolean;
  canMove: boolean;
  canDelete: boolean;
}

const CREWS = { a: ["GM 6", "GM 8"], b: ["GM 15", "GM 9"] } as const;
const TRUCK = { a: "Truck B2", b: "Truck B1" } as const;

const webb = (role: "crew" | "driver" | "green", name: string): string => {
  const row = seedCodes("E2E_CODES").find((c) => c.role === role && c.day === 4 && c.cc === "Webb" && c.name === name);
  if (!row) throw new Error(`no ${role} ${name} at CC Webb`);
  return row.path;
};

/** Middle of a crew's rectangle, from crew.map's [lng, lat] ring. */
const areaCentre = async (crew: Role): Promise<{ latitude: number; longitude: number }> => {
  const map = await crew.api.query<{ area: Array<[number, number]> | null }>("crew.map");
  expect(map.area, "the crew has a rectangle").toBeTruthy();
  const ring = map.area!.slice(0, -1);
  return { latitude: ring.reduce((n, p) => n + p[1], 0) / ring.length, longitude: ring.reduce((n, p) => n + p[0], 0) / ring.length };
};

const pilesOf = (role: Role): Promise<Pile[]> => role.api.query<Pile[]>("tires.list");

test("Tire piles: crew drops, other crew sees it live, green adds, driver adds, photo in Wrap up", async ({ as, lane }) => {
  const [nameA, nameB] = CREWS[lane];
  const crewA = await as(webb("crew", nameA), { name: "Sam" });
  const at = await areaCentre(crewA);
  await crewA.ctx.grantPermissions(["geolocation"]);
  await crewA.ctx.setGeolocation({ ...at, accuracy: 5 });
  const crewB = await as(webb("crew", nameB), { name: "Robin" });
  const greenName = `Green ${lane}`;
  // The green shirt stands 20 m south of crew A's pile.
  const stand = { latitude: at.latitude - 20 / 111_320, longitude: at.longitude, accuracy: 5 };
  const green = await as(webb("green", "CC Webb"), { name: greenName, camera: true, geo: stand });
  const made: number[] = [];
  try {
    // Crew B has its map open before the pile exists.
    await crewB.page.goto("/");
    await expect(crewB.page.getByRole("region", { name: "Crew map" })).toBeVisible();
    // The live stream opens once the page has settled.
    await crewB.page.waitForTimeout(4000);

    // Crew A: Tire pile drops a pin at the blue dot; Save makes the pile.
    const pa = crewA.page;
    await pa.goto("/");
    await expect(pa.getByRole("region", { name: "Crew map" })).toBeVisible();
    await expect(pa.locator(".lrb-me")).toBeAttached();
    await pa.locator("[data-tire-add]").click();
    await expect(pa.locator("[data-tire-place]")).toContainText("Tire pile");
    await expect(pa.locator("[data-tire-pin]")).toBeVisible();
    await pa.locator("[data-tire-save]").click();
    await expect(pa.locator("[data-tire-place]")).toHaveCount(0);
    const mine = await until(async () => (await pilesOf(crewA)).find((p) => p.mine && !made.includes(p.id)), "crew A's pile");
    made.push(mine.id);
    expect(mine.madeBy).toBe(nameA);
    expect(mine.lat).toBeCloseTo(at.latitude, 5);
    expect(mine.photoAt).toBeNull();
    await expect(pa.locator(`[data-tire-pile="${mine.id}"]`)).toBeVisible();

    // Crew B sees it without a reload (the map refetches on its own only every 60 s), and may not delete it.
    await expect(crewB.page.locator(`[data-tire-pile="${mine.id}"]`)).toBeAttached({ timeout: 12_000 });
    const seenByB = (await pilesOf(crewB)).find((p) => p.id === mine.id);
    expect(seenByB).toMatchObject({ mine: false, canDelete: false, canMove: false });
    expect(await crewB.api.refusal("mutate", "tires.remove", { id: mine.id })).toBe("FORBIDDEN");

    // Crew A's sheet: who, when, no photo, Delete; no Move and no camera.
    await pa.locator(`[data-tire-pile="${mine.id}"]`).click();
    const sheetA = pa.locator(`[data-tire-sheet="${mine.id}"]`);
    await expect(sheetA).toBeVisible();
    await expect(sheetA.locator("[data-tire-by]")).toHaveText(nameA);
    await expect(sheetA.locator("[data-tire-no-photo]")).toBeVisible();
    await expect(sheetA.locator("[data-tire-delete]")).toBeVisible();
    await expect(sheetA.locator("[data-tire-move]")).toHaveCount(0);
    await expect(sheetA.locator("input[type=file]")).toHaveCount(0);
    await pa.keyboard.press("Escape");

    // Green: the pile is on the map; Tire pile, a tap moves the pin, Save.
    const pg = green.page;
    await pg.goto("/");
    await expect(pg.getByRole("region", { name: "Command center map" })).toBeVisible();
    await expect(pg.locator(`[data-tire-pile="${mine.id}"]`)).toBeAttached();
    await expect(pg.locator("[data-legend]")).toContainText("Tire pile");
    await pg.locator("[data-recenter]").click();
    await pg.waitForTimeout(800);
    await pg.locator("[data-tire-add]").click();
    await expect(pg.locator("[data-tire-pin]")).toBeVisible();
    const box = (await pg.getByRole("region", { name: "Command center map" }).boundingBox())!;
    await pg.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.45);
    await pg.locator("[data-tire-save]").click();
    const greens = await until(async () => (await pilesOf(green)).find((p) => p.madeBy === greenName && !made.includes(p.id)), "the green shirt's pile");
    made.push(greens.id);
    expect(greens).toMatchObject({ crewId: null, canMove: true, canDelete: true });
    expect(Math.abs(greens.lat - stand.latitude) + Math.abs(greens.lng - stand.longitude)).toBeGreaterThan(1e-5);
    await expect(pg.locator(`[data-tire-pile="${greens.id}"]`)).toBeVisible();

    // The truck sees both and drops its own at the truck; the crew and the green shirt see it.
    const truckName = TRUCK[lane];
    const driver = await as(webb("driver", truckName), { name: "Pat" });
    const pd = driver.page;
    await pd.goto("/");
    await expect(pd.locator("[data-queue-button]")).toBeVisible();
    await expect(pd.locator(`[data-tire-pile="${mine.id}"]`)).toBeAttached();
    await expect(pd.locator(`[data-tire-pile="${greens.id}"]`)).toBeAttached();
    expect(await driver.api.refusal("mutate", "tires.remove", { id: mine.id })).toBe("FORBIDDEN");
    await pd.locator("[data-tire-add]").click();
    await expect(pd.locator("[data-tire-place]")).toContainText("Tire pile");
    await expect(pd.locator("[data-tire-pin]")).toBeVisible();
    await pd.locator("[data-tire-save]").click();
    await expect(pd.locator("[data-tire-place]")).toHaveCount(0);
    const trucks = await until(async () => (await pilesOf(driver)).find((p) => p.mine && !made.includes(p.id)), "the truck's pile");
    made.push(trucks.id);
    expect(trucks).toMatchObject({ madeBy: truckName, canDelete: true, canMove: false });
    await expect(pd.locator(`[data-tire-pile="${trucks.id}"]`)).toBeVisible();
    await pd.locator(`[data-tire-pile="${trucks.id}"]`).click();
    const sheetD = pd.locator(`[data-tire-sheet="${trucks.id}"]`);
    await expect(sheetD.locator("[data-tire-by]")).toHaveText(truckName);
    await expect(sheetD.locator("[data-tire-delete]")).toBeVisible();
    await expect(sheetD.locator("[data-tire-move]")).toHaveCount(0);
    await pd.keyboard.press("Escape");
    await expect(pa.locator(`[data-tire-pile="${trucks.id}"]`)).toBeAttached({ timeout: 12_000 });
    expect((await pilesOf(crewA)).find((p) => p.id === trucks.id)).toMatchObject({ madeBy: truckName, canDelete: false });
    expect((await pilesOf(green)).find((p) => p.id === trucks.id)).toMatchObject({ canDelete: true });

    // Wrap up: crew A's pile has the camera badge on the strip; a tap picks it; the shutter is Photo.
    await pg.goto("/wrap");
    const strip = pg.locator("[data-wrap-strip]");
    await expect(strip.getByRole("region", { name: "Wrap up map" })).toBeVisible();
    const marker = strip.locator(`[data-tire-pile="${mine.id}"]`);
    await expect(marker).toBeVisible();
    await expect(marker).toHaveAttribute("data-tire-badge", "");
    await marker.click();
    await expect(pg.locator("[data-wrap-tire-target]")).toHaveAttribute("data-wrap-tire-target", String(mine.id));
    await expect(pg.locator("[data-wrap-tire-target]")).toContainText("Tire pile");
    await expect(pg.locator("[data-wrap-tire-target]")).toContainText(nameA);
    const shutter = pg.locator("[data-wrap-shutter]");
    await expect(shutter).toHaveText("Photo");
    await expect(shutter).toBeEnabled();
    await shutter.click();
    const shot = await until(async () => (await pilesOf(green)).find((p) => p.id === mine.id && p.photoAt !== null), "the pile's photo");
    expect(shot.photoAt).not.toBeNull();
    await expect(strip.locator(`[data-tire-pile="${mine.id}"][data-tire-badge]`)).toHaveCount(0);
    // The List has the green shirt's pile still waiting for its photo.
    await pg.locator("[data-wrap-list-open]").click();
    await expect(pg.locator(`[data-wrap-tire="${greens.id}"]`)).toBeVisible();
    await expect(pg.locator(`[data-wrap-tire="${mine.id}"]`)).toHaveCount(0);
    await pg.keyboard.press("Escape");

    // Green map: the pile sheet shows the photo, full screen on a tap.
    await pg.goto("/");
    await pg.locator("[data-recenter]").click();
    await pg.waitForTimeout(800);
    await pg.locator(`[data-tire-pile="${mine.id}"]`).click();
    const sheetG = pg.locator(`[data-tire-sheet="${mine.id}"]`);
    await expect(sheetG.locator("[data-tire-move]")).toBeVisible();
    await expect(sheetG.locator("[data-tire-delete]")).toBeVisible();
    await sheetG.locator("[data-tire-photo]").click();
    const viewer = pg.locator("[data-viewer]");
    await expect(viewer).toBeVisible();
    await expect(viewer.getByRole("img", { name: "Tire pile photo" })).toBeVisible();
    expect(await viewer.getByRole("img", { name: "Tire pile photo" }).evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    await viewer.getByRole("button", { name: "Close" }).click();
    await pg.keyboard.press("Escape");

    // Crew A deletes its own pile from the sheet.
    await pa.locator(`[data-tire-pile="${mine.id}"]`).click();
    await pa.locator(`[data-tire-sheet="${mine.id}"] [data-tire-delete]`).click();
    await pa.getByRole("button", { name: "Delete", exact: true }).last().click();
    await until(async () => !(await pilesOf(crewA)).some((p) => p.id === mine.id), "crew A's pile gone");
    await expect(pa.locator(`[data-tire-pile="${mine.id}"]`)).toHaveCount(0);
  } finally {
    for (const id of made) await green.api.mutate("tires.remove", { id }).catch(() => undefined);
  }
});
