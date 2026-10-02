/**
 * Green shirt on the CC map (SPEC 21 to 24) at CC Webb (DURFB1), as the gate does it: tap a bare
 * parcel to Todo, a paint stroke and Undo, Draw lot and Delete lot, Draw area for crews and the
 * rectangle's sheet, the Flag screen with a fake camera. Each lane works only on parcels inside
 * its own rectangles (lanes.ts webbAreas); each test puts its parcels back to Not todo and deletes
 * what it drew and the crews it made.
 */
import { expect, expectNoOverflow, test, until, visit, type Role } from "../support/fixtures.ts";
import { centreOf, centreOn, drag, expectRedTodo, laneParcels, lotFill, pickBareParcel, pickTriple, zoomButtonTo, zoomOf, zoomOn, RED } from "../support/map.ts";
import type { LotPhotos } from "../support/photo.ts";

interface Bare {
  parcelId: string;
  lat: number;
  lng: number;
}
interface Lot {
  id: number;
  parcelId: string | null;
  status: string;
  crewId: number | null;
  source: string;
  address: string | null;
}
interface Area {
  id: number;
  label: string;
  ring: Array<[number, number]>;
  crewIds: number[];
  doNotTouch: boolean;
}
interface Overview {
  cc: { id: number; name: string };
  lots: Lot[];
  companies: Array<{ id: number; name: string }>;
}

const WEBB = "DURFB1";
const WEBB_TRUCK = "TRUCKB1";

const allowed = async (green: Role, labels: readonly string[]): Promise<string[]> => {
  const [bare, plan] = await Promise.all([green.api.query<Bare[]>("green.parcels"), green.api.query<{ areas: Area[] }>("green.plan")]);
  const ok = laneParcels(bare, plan.areas, labels);
  expect(ok.length, `bare parcels inside ${labels.join(", ")}`).toBeGreaterThan(20);
  return ok;
};

const lotsOf = async (green: Role): Promise<Lot[]> => (await green.api.query<Overview>("green.overview")).lots;

/** Puts parcels back to Not todo: deletes a lot nobody worked on, keeps one with history as not_todo. */
const restore = async (green: Role, parcelIds: readonly string[]): Promise<void> => {
  for (const parcelId of parcelIds) await green.api.mutate("green.setLotStatus", { parcelId, status: "not_todo" }).catch(() => undefined);
};

/**
 * Opens the map at zoom 16, pans to the middle of the lane's parcels, zooms on one to 17 (and
 * opens Paint first when asked) and returns that parcel.
 */
const mapAt17 = async (green: Role, ok: string[], paint = false): Promise<string> => {
  const page = green.page;
  await visit(page, "/");
  await expect(page.getByRole("region", { name: "Command center map" })).toBeVisible();
  await zoomButtonTo(page, 16);
  const bare = await green.api.query<Bare[]>("green.parcels");
  const mine = bare.filter((p) => ok.includes(p.parcelId));
  const mid = { lat: mine.reduce((t, p) => t + p.lat, 0) / mine.length, lng: mine.reduce((t, p) => t + p.lng, 0) / mine.length };
  const anchor = mine.reduce((a, p) => (Math.hypot(p.lat - mid.lat, p.lng - mid.lng) < Math.hypot(a.lat - mid.lat, a.lng - mid.lng) ? p : a));
  await expect(page.locator(`[data-parcel="${anchor.parcelId}"]`)).toBeAttached();
  await centreOn(page, `[data-parcel="${anchor.parcelId}"]`);
  if (paint) {
    await page.locator("[data-paint]").first().click();
    await expect(page.locator("[data-paint-bar]")).toBeVisible();
  }
  const first = await until(() => pickBareParcel(page, ok), "an allowed bare parcel on screen");
  await zoomOn(page, `[data-parcel="${first}"]`, 17);
  expect(await zoomOf(page)).toBeGreaterThanOrEqual(17);
  await page.waitForTimeout(500);
  return first;
};

test("the CC map draws lots, crew rectangles, the CC and the legend", async ({ as }) => {
  const green = await as(WEBB);
  const page = green.page;
  await visit(page, "/");
  const map = page.getByRole("region", { name: "Command center map" });
  await expect(map.getByRole("button", { name: "B CC Webb" }).first()).toBeVisible();
  await expect(page.locator("[data-legend]")).toBeVisible();
  for (const word of ["Not todo", "Todo", "In progress", "Done", "Do not touch"]) await expect(page.locator("[data-legend]")).toContainText(word);
  await expect(page.locator("[data-lot-id]").first()).toBeAttached();
  // Rectangle name pills declutter by zoom (SPEC 20): every one shows from 16 up.
  await zoomButtonTo(page, 16);
  const plan = await green.api.query<{ areas: Area[] }>("green.plan");
  const pills = await map.getByRole("button").allInnerTexts();
  expect(plan.areas.some((a) => pills.includes(a.label)), `a rectangle pill among ${pills.join(", ")}`).toBe(true);
  for (const b of ["Paint", "Draw area", "Draw lot", "Add stop"]) await expect(page.getByRole("button", { name: b, exact: true })).toBeVisible();
});

test("tap a bare parcel: Todo turns it red and it stays red after a reload", async ({ as, L }) => {
  const green = await as(WEBB);
  const page = green.page;
  const ok = await allowed(green, L.webbAreas);
  const pid = await mapAt17(green, ok);
  try {
    const at = await centreOf(page, `[data-parcel="${pid}"]`);
    await page.mouse.click(at!.x, at!.y);
    const sheet = page.getByRole("dialog");
    await expect(sheet.locator('[data-status="open"]')).toBeVisible();
    await expectNoOverflow(page, "parcel sheet");
    await sheet.locator('[data-status="open"]').click();
    await expectRedTodo(page, [pid]);
    const lot = await until(async () => (await lotsOf(green)).find((l) => l.parcelId === pid), "the new lot");
    expect(lot.status).toBe("open");
    // SPEC 21: Todo on a bare parcel gives the lot the crew whose rectangle holds it.
    const areas = (await green.api.query<{ areas: Area[] }>("green.plan")).areas.filter((a) => L.webbAreas.includes(a.label));
    expect(areas.flatMap((a) => a.crewIds)).toContain(lot.crewId);
    await page.reload();
    await page.locator("main").waitFor();
    await expect.poll(async () => (await lotFill(page, pid))?.fill).toBe(RED);
  } finally {
    await restore(green, [pid]);
  }
  await until(async () => (await green.api.query<Bare[]>("green.parcels")).some((p) => p.parcelId === pid), "the parcel bare again");
});

test("Paint: a stroke across three parcels makes them Todo, Undo takes them back", async ({ as, L }) => {
  const green = await as(WEBB);
  const page = green.page;
  const ok = await allowed(green, L.webbAreas);
  await mapAt17(green, ok, true);
  const chips = page.locator("[data-brush]");
  expect(await chips.count()).toBeGreaterThanOrEqual(5);
  for (const h of await chips.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height))) expect(h).toBeGreaterThanOrEqual(44);
  await expect(page.locator("[data-paint-zoom]")).toHaveCount(0);
  const tri = await until(() => pickTriple(page, "", ok), "three neighbouring bare parcels in a row");
  const painted = tri.map((t) => t.pid);
  try {
    await page.locator('[data-brush="open"]').click();
    await drag(page, tri);
    await expectRedTodo(page, painted);
    await expect(page.locator("[data-paint-count]")).toHaveText("3 lots");
    const lots = await lotsOf(green);
    expect(lots.filter((l) => painted.includes(l.parcelId ?? "") && l.status === "open")).toHaveLength(3);
    await expectNoOverflow(page, "paint bar");
    await page.locator("[data-paint-undo]").click();
    for (const pid of painted) await expect(page.locator(`[data-parcel="${pid}"]`)).toBeAttached();
    await until(async () => !(await lotsOf(green)).some((l) => painted.includes(l.parcelId ?? "") && l.status === "open"), "the lots gone after Undo");
    await page.locator("[data-paint-exit]").click();
    await expect(page.locator("[data-paint-bar]")).toHaveCount(0);
  } finally {
    await restore(green, painted);
  }
});

test("Draw lot: four taps round a strip, Save; red, on the driver's list, Delete lot", async ({ as, L }) => {
  const green = await as(WEBB);
  const page = green.page;
  const ok = await allowed(green, L.webbAreas);
  await mapAt17(green, ok);
  const tri = await until(() => pickTriple(page, "", ok), "three neighbouring parcels for the strip");
  const [a, , b] = tri;
  const len = Math.max(Math.hypot(b.x - a.x, b.y - a.y), 1);
  // 28 px wide: the fourth tap must clear the first point's 44 px hit box, or it closes the shape.
  const nx = (-(b.y - a.y) / len) * 14;
  const ny = ((b.x - a.x) / len) * 14;
  const corners = [
    { x: a.x + nx, y: a.y + ny },
    { x: b.x + nx, y: b.y + ny },
    { x: b.x - nx, y: b.y - ny },
    { x: a.x - nx, y: a.y - ny },
  ];
  const before = new Set((await lotsOf(green)).map((l) => l.id));
  let made: Lot | null = null;
  try {
    await page.locator("[data-draw-lot]").click();
    await expect(page.locator("[data-draw-lot-bar]")).toBeVisible();
    for (const c of corners) {
      await page.mouse.click(c.x, c.y);
      await page.waitForTimeout(350);
    }
    await expect(page.locator("[data-draw-vertex]")).toHaveCount(4);
    await page.locator("[data-draw-close]").click();
    const save = page.locator("[data-draw-lot-save]");
    await expect(save).toBeEnabled({ timeout: 8000 });
    await expectNoOverflow(page, "draw lot sheet");
    const name = await page.getByRole("dialog").locator("input").first().inputValue();
    expect(name.trim().length).toBeGreaterThan(0);
    await save.click();
    made = await until(async () => (await lotsOf(green)).find((l) => !before.has(l.id)) ?? null, "the drawn lot");
    expect(made).toMatchObject({ source: "drawn", parcelId: null, status: "open" });
    const shape = page.locator(`[data-lot-id="${made.id}"]`).first();
    await expect(shape).toHaveClass(/lrb-lot-shape-open/);
    expect(await shape.evaluate((e) => getComputedStyle(e).fill)).toBe(RED);

    const driver = await as(WEBB_TRUCK);
    expect((await driver.api.query<{ lots: Lot[] }>("driver.lots")).lots.some((l) => l.id === made!.id), "drawn lot on the driver's list").toBe(true);

    const at = await centreOf(page, `[data-lot-id="${made.id}"]`);
    await page.mouse.click(at!.x, at!.y);
    const sheet = page.getByRole("dialog");
    await expect(sheet.getByRole("heading").first()).toHaveText(name.trim());
    await sheet.locator("[data-delete-lot]").click();
    await page.getByRole("dialog").getByRole("button", { name: "Delete lot" }).last().click();
    await until(async () => !(await lotsOf(green)).some((l) => l.id === made!.id), "the drawn lot deleted");
    made = null;
  } finally {
    if (made) await green.api.mutate("green.deleteLot", { lotId: made.id }).catch(() => undefined);
  }
});

test("Draw area over three Todo lots for a crew; Reassign, Done, Do not touch, Delete area", async ({ as, L, admin }) => {
  const green = await as(WEBB);
  const adm = await as(admin);
  const page = green.page;
  const ov = await green.api.query<Overview>("green.overview");
  const company = ov.companies[0]!;
  // Two crews of one company made for this test, so no seeded crew loses its rectangle.
  const crewA = await adm.api.mutate<{ id: number; name: string }>("admin.crews.create", { ccId: ov.cc.id, companyId: company.id, leadName: `E2E area A ${L.id}` });
  const crewB = await adm.api.mutate<{ id: number; name: string }>("admin.crews.create", { ccId: ov.cc.id, companyId: company.id, leadName: `E2E area B ${L.id}` });
  const ok = await allowed(green, L.webbAreas);
  let parcels: string[] = [];
  let areaId: number | null = null;
  try {
    await mapAt17(green, ok);
    const tri = await until(() => pickTriple(page, "", ok), "three neighbouring parcels");
    parcels = tri.map((t) => t.pid);
    for (const parcelId of parcels) await green.api.mutate("green.setLotStatus", { parcelId, status: "open" });
    await expectRedTodo(page, parcels);

    const [a, , c] = tri;
    const ux = (c.x - a.x) / Math.hypot(c.x - a.x, c.y - a.y);
    const uy = (c.y - a.y) / Math.hypot(c.x - a.x, c.y - a.y);
    await page.locator("[data-draw-area]").click();
    await expect(page.locator("[data-draw-bar]")).toBeVisible();
    // Oriented rectangle: two clicks along the row, a third for the width. The long side runs
    // 8 px to one side of the parcel centres and the third click 8 px to the other, so the centres
    // are inside whether the width counts from the first side or both ways.
    const px = -uy;
    const py = ux;
    await page.mouse.click(a.x - ux * 5 - px * 8, a.y - uy * 5 - py * 8);
    await page.mouse.click(c.x + ux * 5 - px * 8, c.y + uy * 5 - py * 8);
    await page.mouse.click((a.x + c.x) / 2 + px * 8, (a.y + c.y) / 2 + py * 8);
    const sheet = page.getByRole("dialog", { name: "New area" });
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText("Todo inside");
    await expectNoOverflow(page, "new area sheet");
    await sheet.getByRole("button", { name: crewA.name, exact: true }).click();
    await sheet.getByRole("button", { name: `Assign to ${crewA.name}` }).click();
    const area = await until(async () => (await green.api.query<{ areas: Area[] }>("green.plan")).areas.find((x) => x.crewIds.includes(crewA.id)), "the new area");
    areaId = area.id;
    await until(async () => (await lotsOf(green)).filter((l) => parcels.includes(l.parcelId ?? "") && l.crewId === crewA.id).length === 3, "the three lots on the crew");

    const pill = page.getByRole("region", { name: "Command center map" }).getByRole("button", { name: crewA.name, exact: true }).first();
    await pill.click();
    let card = page.getByRole("dialog", { name: area.label });
    await expect(card).toBeVisible();
    await card.getByRole("button", { name: "Reassign", exact: true }).click();
    await card.getByLabel("Company").selectOption(String(company.id));
    await card.getByRole("group", { name: "Crews" }).getByRole("button", { name: crewB.name, exact: true }).click();
    await card.getByRole("button", { name: `Reassign to ${crewB.name}` }).click();
    await until(async () => (await lotsOf(green)).filter((l) => parcels.includes(l.parcelId ?? "") && l.crewId === crewB.id).length === 3, "the lots moved to the second crew");

    await page.getByRole("region", { name: "Command center map" }).getByRole("button", { name: crewB.name, exact: true }).first().click();
    card = page.getByRole("dialog", { name: crewB.name });
    await card.getByRole("button", { name: "Done", exact: true }).click();
    const confirmDone = page.getByRole("dialog", { name: "Mark 3 lots done" });
    await confirmDone.getByRole("button", { name: "Done", exact: true }).click();
    await until(async () => (await lotsOf(green)).filter((l) => parcels.includes(l.parcelId ?? "") && l.status === "done").length === 3, "three lots done");

    await page.getByRole("region", { name: "Command center map" }).getByRole("button", { name: crewB.name, exact: true }).first().click();
    card = page.getByRole("dialog", { name: crewB.name });
    await card.getByRole("button", { name: "Do not touch", exact: true }).click();
    await page.getByRole("dialog", { name: /^Do not touch/ }).getByRole("button", { name: "Do not touch", exact: true }).click();
    await until(async () => (await green.api.query<{ areas: Area[] }>("green.plan")).areas.find((x) => x.id === areaId && x.doNotTouch), "the area flagged Do not touch");

    await page.getByRole("region", { name: "Command center map" }).getByRole("button", { name: crewB.name, exact: true }).first().click();
    card = page.getByRole("dialog", { name: crewB.name });
    await card.getByRole("button", { name: "Delete area" }).click();
    await page.getByRole("dialog", { name: "Delete area" }).getByRole("button", { name: "Delete area" }).click();
    await until(async () => !(await green.api.query<{ areas: Area[] }>("green.plan")).areas.some((x) => x.id === areaId), "the area deleted");
    areaId = null;
  } finally {
    if (areaId !== null) await green.api.mutate("green.deleteArea", { areaId }).catch(() => undefined);
    await restore(green, parcels);
    await adm.api.mutate("admin.crews.delete", { id: crewA.id });
    await adm.api.mutate("admin.crews.delete", { id: crewB.id });
  }
});

test("Flag: fake camera and GPS on a bare parcel, Todo makes it a Todo lot with a Before photo, Undo", async ({ as, L }) => {
  const probe = await as(WEBB);
  const ok = new Set(await allowed(probe, L.webbAreas));
  const bare = (await probe.api.query<Bare[]>("green.parcels")).filter((p) => ok.has(p.parcelId));
  const target = bare[Math.floor(bare.length / 2)]!;
  const green = await as(WEBB, { camera: true, geo: { latitude: target.lat, longitude: target.lng, accuracy: 5 } });
  const page = green.page;
  let lotId: number | null = null;
  try {
    await page.goto("/flag");
    await expect(page.locator("[data-flag-shutter]")).toBeVisible();
    await expect(page.locator("[data-flag-target]")).not.toContainText("No parcel", { timeout: 15_000 });
    const shutter = await page.locator("[data-flag-shutter]").boundingBox();
    expect(Math.min(shutter!.width, shutter!.height)).toBeGreaterThanOrEqual(84);
    for (const side of await page.locator("[data-flag-side]").all()) expect((await side.boundingBox())!.height).toBeGreaterThanOrEqual(56);
    await expect(page.locator(`[data-flag-strip] [data-flag-pick="p:${target.parcelId}"]`)).toBeAttached();
    await expectNoOverflow(page, "/flag");
    await page.locator("[data-flag-shutter]").click();
    const lot = await until(async () => (await lotsOf(green)).find((l) => l.parcelId === target.parcelId), "the flagged lot", 20_000);
    lotId = lot.id;
    expect(lot.status).toBe("open");
    await until(async () => (await green.api.query<LotPhotos>("shared.lotPhotos", { lotId: lot.id })).photos.some((p) => p.kind === "before"), "a Before photo", 20_000);
    await expect(page.locator("[data-flag-last]")).toBeVisible();
    await page.locator("[data-flag-undo]").click();
    await until(async () => (await green.api.query<Bare[]>("green.parcels")).some((p) => p.parcelId === target.parcelId), "the parcel bare again after Undo");
    lotId = null;
  } finally {
    if (lotId !== null) await restore(green, [target.parcelId]);
  }
});
