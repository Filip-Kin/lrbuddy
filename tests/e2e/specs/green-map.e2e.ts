/**
 * Green shirt on the CC map (SPEC 21 to 24) at CC Webb (L.webbGreen), as the gate does it: tap a bare
 * parcel to Todo, a paint stroke and Undo, Draw lot and Delete lot, Draw area for crews and the
 * rectangle's sheet, the Flag screen with a fake camera and a fake compass, and its Paint map. Each lane works only on parcels inside
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

test("the CC map draws lots, crew rectangles, the CC and the legend", async ({ as, L }) => {
  const green = await as(L.webbGreen);
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
  // The declutter classes follow the zoom's end, which can come after the last button press returns.
  // The tap target at the start of a rectangle's name carries the full name.
  await expect
    .poll(async () => {
      for (const a of plan.areas) if (await map.getByRole("button", { name: a.label, exact: true }).first().isVisible()) return true;
      return false;
    }, { message: "a rectangle name's tap target on the map at zoom 16" })
    .toBe(true);
  for (const b of ["Paint", "Draw area", "Draw lot", "Add stop"]) await expect(page.getByRole("button", { name: b, exact: true })).toBeVisible();
});

test("a basemap at every zoom, 16.5 included (field report 2026-10-02: only the data layers)", async ({ as, L }) => {
  const green = await as(L.webbGreen);
  const page = green.page;
  await visit(page, "/");
  await expect(page.getByRole("region", { name: "Command center map" })).toBeVisible();
  // Loaded tiles on screen, by layer: canvas base, canvas labels, streets.
  const tiles = () =>
    page.evaluate(() => {
      const box = document.querySelector(".leaflet-container")!.getBoundingClientRect();
      const n = { base: 0, labels: 0, streets: 0 };
      for (const img of document.querySelectorAll<HTMLImageElement>("img.leaflet-tile-loaded")) {
        const r = img.getBoundingClientRect();
        if (r.right <= box.left || r.left >= box.right || r.bottom <= box.top || r.top >= box.bottom) continue;
        if (img.src.includes("World_Street_Map")) n.streets++;
        else if (img.src.includes("Reference")) n.labels++;
        else n.base++;
      }
      return n;
    });
  await zoomButtonTo(page, 16);
  // Half a zoom step with the wheel: zoomSnap is 0.5, so a small wheel turn lands on 16.5.
  const box = (await page.locator(".leaflet-container").first().boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 6 && (await zoomOf(page)) <= 16; i++) {
    await page.mouse.wheel(0, -40);
    await page.waitForTimeout(450);
  }
  expect(await zoomOf(page)).toBe(16.5);
  // The canvas runs under everything at every zoom; the streets take over from 16.5.
  await expect.poll(async () => (await tiles()).base, { message: "canvas tiles at 16.5" }).toBeGreaterThan(0);
  await expect.poll(async () => (await tiles()).streets, { message: "street tiles at 16.5" }).toBeGreaterThan(0);
  await zoomButtonTo(page, 18);
  await expect.poll(async () => (await tiles()).base, { message: "canvas tiles at 18" }).toBeGreaterThan(0);
  await expect.poll(async () => (await tiles()).streets, { message: "street tiles at 18" }).toBeGreaterThan(0);
  await zoomButtonTo(page, 15);
  await expect.poll(async () => (await tiles()).base, { message: "canvas tiles at 15" }).toBeGreaterThan(0);
  expect((await tiles()).streets, "no street tiles under 16.5").toBe(0);
});

test("rectangle names: small, along the top edge inside the rectangle, taking no taps but their dot", async ({ as, L }) => {
  const green = await as(L.webbGreen);
  const page = green.page;
  await visit(page, "/");
  await zoomButtonTo(page, 17);
  const plan = await green.api.query<{ areas: Area[] }>("green.plan");
  const mine = plan.areas.filter((a) => L.webbAreas.includes(a.label));
  expect(mine.length).toBeGreaterThan(0);
  // Bring one of the lane's rectangles to the middle, then measure every name on screen.
  await centreOn(page, `.lrb-area-name[data-area-id="${mine[0]!.id}"]`);
  await page.waitForTimeout(400);
  const measured = await page.evaluate(() => {
    const out: Array<{ id: string; gap: number; along: number; font: number; pe: string; text: string }> = [];
    for (const name of document.querySelectorAll<HTMLElement>(".lrb-area-name[data-area-id]")) {
      const r = name.getBoundingClientRect();
      if (r.width === 0 || r.right < 0 || r.left > innerWidth || r.bottom < 0 || r.top > innerHeight) continue;
      const id = name.dataset.areaId!;
      const path = document.querySelector<SVGPathElement>(`path[data-area-id="${id}"]`);
      const ctm = path?.getScreenCTM();
      if (!path || !ctm) continue;
      const nums = (path.getAttribute("d") ?? "").match(/-?\d+(\.\d+)?/g)?.map(Number) ?? [];
      const pts: Array<{ x: number; y: number }> = [];
      for (let i = 0; i + 1 < nums.length; i += 2) {
        const q = new DOMPoint(nums[i], nums[i + 1]).matrixTransform(ctm);
        pts.push({ x: q.x, y: q.y });
      }
      // Leaflet clips an outline at the edge of the view; only whole outlines say where the top edge is.
      const box = document.querySelector(".leaflet-container")!.getBoundingClientRect();
      if (pts.length < 3 || pts.some((q) => q.x < box.left || q.x > box.right || q.y < box.top || q.y > box.bottom)) continue;
      let top = 0;
      for (let i = 1; i < pts.length; i++) {
        const mid = (j: number) => (pts[j]!.y + pts[(j + 1) % pts.length]!.y) / 2;
        if (mid(i) < mid(top)) top = i;
      }
      const a = pts[top]!;
      const b = pts[(top + 1) % pts.length]!;
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      const c = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      const dist = Math.abs((b.x - a.x) * (a.y - c.y) - (a.x - c.x) * (b.y - a.y)) / len;
      const along = ((c.x - a.x) * (b.x - a.x) + (c.y - a.y) * (b.y - a.y)) / (len * len);
      const text = name.querySelector<HTMLElement>(".lrb-area-text")!;
      out.push({ id, gap: dist - name.offsetHeight / 2, along, font: parseFloat(getComputedStyle(text).fontSize), pe: getComputedStyle(name).pointerEvents, text: text.textContent ?? "" });
    }
    return out;
  });
  expect(measured.length, "rectangle names on screen").toBeGreaterThan(0);
  for (const m of measured) {
    expect(m.gap, `name of area ${m.id} within 4 px of its top edge`).toBeGreaterThanOrEqual(-0.5);
    expect(m.gap, `name of area ${m.id} within 4 px of its top edge`).toBeLessThanOrEqual(4);
    expect(m.along, `name of area ${m.id} along its top edge`).toBeGreaterThan(0);
    expect(m.along).toBeLessThan(1);
    expect(m.font).toBeLessThanOrEqual(12);
    expect(m.pe).toBe("none");
  }
  // The dot at the start of a name opens the rectangle's sheet.
  const area = mine[0]!;
  await page.getByRole("region", { name: "Command center map" }).getByRole("button", { name: area.label, exact: true }).first().click();
  await expect(page.getByRole("dialog", { name: area.label })).toBeVisible();
});

test("tap a bare parcel: Todo turns it red and it stays red after a reload", async ({ as, L }) => {
  const green = await as(L.webbGreen);
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
  const green = await as(L.webbGreen);
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
    // Two fingers move the map and paint nothing (field report 2026-10-02: "needs multi touch").
    await until(async () => !(await lotsOf(green)).some((l) => painted.includes(l.parcelId ?? "") && l.status === "open"), "the lots gone after Undo");
    const before = await page.evaluate(() => {
      const r = document.querySelector(".leaflet-container")!.getBoundingClientRect();
      const p = document.querySelector("[data-parcel]")!.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, parcel: [p.left, p.top, p.width].map(Math.round).join(",") };
    });
    const cdp = await page.context().newCDPSession(page);
    const pts = (dx: number, spread: number) => [
      { x: before.x - spread + dx, y: before.y, id: 1 },
      { x: before.x + spread + dx, y: before.y, id: 2 },
    ];
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: pts(0, 40) });
    for (let i = 1; i <= 8; i++) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: pts(i * 15, 40 + i * 8) });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    // Leaflet's pinch moves the layers, not the map pane: a parcel's place on screen says the map moved.
    const parcelBox = () =>
      page.evaluate(() => {
        const p = document.querySelector("[data-parcel]")!.getBoundingClientRect();
        return [p.left, p.top, p.width].map(Math.round).join(",");
      });
    await expect.poll(parcelBox, { message: "two fingers moved the map" }).not.toBe(before.parcel);
    await expect(page.locator("[data-paint-count]")).not.toHaveText(/[1-9] lots?$/);
    await until(async () => !(await lotsOf(green)).some((l) => painted.includes(l.parcelId ?? "") && l.status === "open"), "the lots gone after Undo");
    await page.locator("[data-paint-exit]").click();
    await expect(page.locator("[data-paint-bar]")).toHaveCount(0);
  } finally {
    await restore(green, painted);
  }
});

test("Draw lot: four taps round a strip, Save; red, on the driver's list, Delete lot", async ({ as, L }) => {
  const green = await as(L.webbGreen);
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
    made = await until(async () => (await lotsOf(green)).find((l) => !before.has(l.id) && l.source === "drawn") ?? null, "the drawn lot");
    expect(made).toMatchObject({ source: "drawn", parcelId: null, status: "open" });
    const shape = page.locator(`[data-lot-id="${made.id}"]`).first();
    await expect(shape).toHaveClass(/lrb-lot-shape-open/);
    expect(await shape.evaluate((e) => getComputedStyle(e).fill)).toBe(RED);

    const driver = await as(L.webbTruck);
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
  const green = await as(L.webbGreen);
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

/** Fires `deviceorientationabsolute` a few times, as a phone's compass does, with these W3C angles. */
const face = async (page: Role["page"], alpha: number, beta: number, gamma: number): Promise<void> => {
  await page.evaluate(([a, b, g]) => {
    for (let i = 0; i < 6; i++) {
      window.setTimeout(() => window.dispatchEvent(new DeviceOrientationEvent("deviceorientationabsolute", { alpha: a, beta: b, gamma: g, absolute: true })), i * 50);
    }
  }, [alpha, beta, gamma] as const);
};

/** A bare parcel in the Flag strip a tap would hit, clear of the strip's corner buttons. */
const stripParcel = (page: Role["page"], allow: readonly string[], skip: string): Promise<{ pid: string; x: number; y: number } | null> =>
  page.evaluate(
    ([ids, not]) => {
      const ok = new Set(ids);
      const s = document.querySelector("[data-flag-strip]")!.getBoundingClientRect();
      let best: { pid: string; x: number; y: number; d: number } | null = null;
      for (const el of document.querySelectorAll("[data-flag-strip] [data-parcel]")) {
        const pid = el.getAttribute("data-parcel")!;
        if (pid === not || !ok.has(pid)) continue;
        const r = el.getBoundingClientRect();
        const x = r.left + r.width / 2;
        const y = r.top + r.height / 2;
        if (r.width < 10 || r.height < 10 || x < s.left + 30 || x > s.right - 30 || y < s.top + 60 || y > s.bottom - 20) continue;
        if (document.elementFromPoint(x, y) !== el) continue;
        const d = Math.hypot(x - (s.left + s.width / 2), y - (s.top + s.height / 2));
        if (!best || d < best.d) best = { pid, x, y, d };
      }
      return best ? { pid: best.pid, x: best.x, y: best.y } : null;
    },
    [allow as string[], skip] as const,
  );

const pickedKey = (page: Role["page"]): Promise<string | null> =>
  page.evaluate(() => document.querySelector("[data-flag-strip] [data-flag-pick]")?.getAttribute("data-flag-pick") ?? null);

test("Flag: on a phone that asks before reading the compass (iOS), a big Turn on compass button over the camera", async ({ as, L }) => {
  const green = await as(L.webbGreen, { camera: true });
  const page = green.page;
  await page.addInitScript(() => {
    (DeviceOrientationEvent as unknown as { requestPermission: () => Promise<string> }).requestPermission = async () => "granted";
  });
  await page.goto("/flag");
  const ask = page.locator("[data-flag-compass-ask]");
  await expect(ask).toBeVisible();
  expect((await ask.boundingBox())!.height).toBeGreaterThanOrEqual(56);
  await expect(page.locator("[data-flag-heading]")).toHaveCount(0);
  await expectNoOverflow(page, "/flag with the compass button");
  await ask.click();
  await expect(ask).toHaveCount(0);
  await expect(page.locator("[data-flag-heading]")).toHaveText("No compass");
  await face(page, 270, 90, 0);
  await expect(page.locator("[data-flag-heading]")).toHaveText("Facing E");
});

test("Flag: the camera's bearing from the compass picks the parcel it faces; a tap on the strip picks another; Todo, Undo", async ({ as, L }) => {
  const probe = await as(L.webbGreen);
  const okList = await allowed(probe, L.webbAreas);
  const ok = new Set(okList);
  const bare = (await probe.api.query<Bare[]>("green.parcels")).filter((p) => ok.has(p.parcelId));
  const target = bare[Math.floor(bare.length / 2)]!;
  // Stand 5 m west of the parcel's centre: facing east, the ray enters it at 4 m.
  const west = { latitude: target.lat, longitude: target.lng - 5 / (111_320 * Math.cos((target.lat * Math.PI) / 180)), accuracy: 5 };
  const green = await as(L.webbGreen, { camera: true, geo: west });
  const page = green.page;
  let flagged: string | null = null;
  try {
    await page.goto("/flag");
    await expect(page.locator("[data-flag-shutter]")).toBeVisible();
    await expect(page.locator("[data-flag-heading]")).toHaveText("No compass");
    // Upright portrait facing east: alpha 270, beta 90.
    await face(page, 270, 90, 0);
    await expect(page.locator("[data-flag-heading]")).toHaveText("Facing E");
    await expect.poll(() => pickedKey(page), { message: "the parcel to the east picked" }).toBe(`p:${target.parcelId}`);
    // Landscape, screen turned left, facing west: alpha 180, beta 0, gamma -90 (alpha alone would say S).
    await face(page, 180, 0, -90);
    await expect(page.locator("[data-flag-heading]")).toHaveText("Facing W");
    // Landscape facing east again: alpha 0, beta 0, gamma -90 (alpha alone would say N).
    await face(page, 0, 0, -90);
    await expect(page.locator("[data-flag-heading]")).toHaveText("Facing E");
    await expect.poll(() => pickedKey(page)).toBe(`p:${target.parcelId}`);

    const shutter = await page.locator("[data-flag-shutter]").boundingBox();
    expect(Math.min(shutter!.width, shutter!.height)).toBeGreaterThanOrEqual(84);
    await expect(page.locator("[data-flag-side]")).toHaveCount(1);
    expect((await page.locator("[data-flag-side]").boundingBox())!.height).toBeGreaterThanOrEqual(56);
    await expect(page.getByRole("button", { name: "Wrong lot" })).toHaveCount(0);
    await expectNoOverflow(page, "/flag");

    // A tap on another parcel in the strip picks it; a second tap on it, or Clear, goes back to the ray.
    const other = await until(() => stripParcel(page, okList, target.parcelId), "a bare parcel to tap in the strip");
    const before = await page.locator("[data-flag-target] p").textContent();
    await page.mouse.click(other.x, other.y);
    await expect.poll(() => pickedKey(page)).toBe(`p:${other.pid}`);
    await expect(page.locator("[data-flag-clear]")).toBeVisible();
    await page.mouse.click(other.x, other.y);
    await expect.poll(() => pickedKey(page)).toBe(`p:${target.parcelId}`);
    await expect(page.locator("[data-flag-clear]")).toHaveCount(0);
    await page.mouse.click(other.x, other.y);
    await expect.poll(() => pickedKey(page)).toBe(`p:${other.pid}`);
    await page.locator("[data-flag-clear]").click();
    await expect.poll(() => pickedKey(page)).toBe(`p:${target.parcelId}`);
    await expect(page.locator("[data-flag-target] p")).toHaveText(before ?? "");

    // Tapped, then the shutter: that parcel becomes Todo with the photo, and the ray takes over again.
    await page.mouse.click(other.x, other.y);
    await expect.poll(() => pickedKey(page)).toBe(`p:${other.pid}`);
    await page.locator("[data-flag-shutter]").click();
    flagged = other.pid;
    const lot = await until(async () => (await lotsOf(green)).find((l) => l.parcelId === other.pid), "the flagged lot", 20_000);
    expect(lot.status).toBe("open");
    await until(async () => (await green.api.query<LotPhotos>("shared.lotPhotos", { lotId: lot.id })).photos.some((p) => p.kind === "before"), "a Before photo", 20_000);
    await expect(page.locator("[data-flag-clear]")).toHaveCount(0);
    await expect.poll(() => pickedKey(page)).toBe(`p:${target.parcelId}`);
    await expect(page.locator("[data-flag-last]")).toBeVisible();
    await page.locator("[data-flag-undo]").click();
    await until(async () => (await green.api.query<Bare[]>("green.parcels")).some((p) => p.parcelId === other.pid), "the parcel bare again after Undo");
    flagged = null;
  } finally {
    if (flagged !== null) await restore(green, [flagged]);
  }
});

test("Flag: Expand is Paint; the toggle brush swaps Todo and Not todo, Do not touch on its switch, Undo, Collapse", async ({ as, L }) => {
  const probe = await as(L.webbGreen);
  const ok = await allowed(probe, L.webbAreas);
  const bare = (await probe.api.query<Bare[]>("green.parcels")).filter((p) => ok.includes(p.parcelId));
  // Stand in the middle of the lane's bare parcels, as mapAt17 centres the green map.
  const mid = { lat: bare.reduce((t, p) => t + p.lat, 0) / bare.length, lng: bare.reduce((t, p) => t + p.lng, 0) / bare.length };
  const at = bare.reduce((a, p) => (Math.hypot(p.lat - mid.lat, p.lng - mid.lng) < Math.hypot(a.lat - mid.lat, a.lng - mid.lng) ? p : a));
  const green = await as(L.webbGreen, { camera: true, geo: { latitude: at.lat, longitude: at.lng, accuracy: 5 } });
  const page = green.page;
  let painted: string[] = [];
  try {
    await page.goto("/flag");
    await expect(page.locator("[data-flag-shutter]")).toBeVisible();
    await expect(page.locator("[data-paint-bar]")).toHaveCount(0);
    await expect(page.locator("[data-flag-target]")).not.toContainText("No parcel");
    await page.locator("[data-flag-expand]").click();
    await expect(page.locator("[data-paint-bar]")).toBeVisible();
    await expect(page.locator("[data-flag-shutter]")).toBeHidden();
    await expect(page.locator("[data-brush]")).toHaveCount(0);
    const dnt = page.locator("[data-flag-dnt-brush]");
    await expect(dnt).toHaveAttribute("aria-pressed", "false");
    expect((await dnt.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect(await zoomOf(page, "[data-flag-strip]")).toBe(18);
    await expectNoOverflow(page, "/flag paint");

    const tri = await until(() => pickTriple(page, "[data-flag-strip]", ok), "three neighbouring bare parcels in the expanded map");
    painted = tri.map((t) => t.pid);
    const statuses = async (): Promise<string[]> => {
      const lots = await lotsOf(green);
      return painted.map((pid) => lots.find((l) => l.parcelId === pid)?.status ?? "bare");
    };
    await drag(page, tri);
    await expectRedTodo(page, painted);
    await expect(page.locator("[data-paint-count]")).toHaveText("3 lots");
    expect(await statuses()).toEqual(["open", "open", "open"]);
    // The same stroke again: Todo turns back to Not todo.
    await drag(page, tri);
    await until(async () => (await statuses()).every((x) => x === "bare"), "the three back to Not todo");
    await expect(page.locator("[data-paint-count]")).toHaveText("3 lots");
    await expect(page.locator("[data-paint-total]")).toHaveText("6 total");
    // Do not touch on its switch, one tap.
    await dnt.click();
    await expect(dnt).toHaveAttribute("aria-pressed", "true");
    await page.mouse.click(tri[0].x, tri[0].y);
    await until(async () => (await statuses())[0] === "do_not_touch", "the first parcel Do not touch");
    await dnt.click();
    await expect(dnt).toHaveAttribute("aria-pressed", "false");

    // Undo walks back all three strokes.
    const undo = page.locator("[data-paint-undo]");
    await undo.click();
    await until(async () => (await statuses()).join() === "bare,bare,bare", "Undo of Do not touch");
    await expect(undo).toBeEnabled();
    await undo.click();
    await until(async () => (await statuses()).join() === "open,open,open", "Undo of the second stroke");
    await expect(undo).toBeEnabled();
    await undo.click();
    await until(async () => (await statuses()).join() === "bare,bare,bare", "Undo of the first stroke");
    painted = [];

    await page.locator("[data-flag-expand]").click();
    await expect(page.locator("[data-paint-bar]")).toHaveCount(0);
    await expect(page.locator("[data-flag-shutter]")).toBeVisible();
    await expect(page.locator('[data-flag-map="strip"]')).toBeAttached();
  } finally {
    if (painted.length > 0) await restore(green, painted);
  }
});
