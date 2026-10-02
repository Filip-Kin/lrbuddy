/**
 * Driver (SPEC 5, 7, 17, 20, 21) on the lane's truck: a crew request shows in the queue with its
 * route, Next pins it, En route and Delivered reach the crew, delivering takes the water off the
 * truck; Stock above capacity and the Expected control; the map's lots without bare parcels, and a
 * lot set Done from its sheet. Stock, lot status and requests are put back after each test.
 */
import { expect, expectNoOverflow, test, until, visit, type Role } from "../support/fixtures.ts";

interface Stop {
  key: string;
  name: string;
  items: Array<{ id: number; status: string }>;
}
interface Queue {
  truck: { id: number; name: string };
  stops: Stop[];
  pinnedKey: string | null;
  route: { engine: string } | null;
}
interface StockRow {
  typeId: number;
  key: string;
  label: string;
  qty: number;
  capacity: number;
}
interface CatalogItem {
  id: number;
  key: string;
}
interface CrewRequest {
  id: number;
  status: string;
}
interface DriverLot {
  id: number;
  status: string;
  parcelId: string | null;
}

/** The driver's phone, standing at its CC: the map follows it there, among the CC's lots. */
const driverAtCc = async (as: (who: string, o?: object) => Promise<Role>, link: string): Promise<Role> => {
  const driver = await as(link, { geo: { latitude: 42.37, longitude: -83.0, accuracy: 8 } });
  const { cc } = await driver.api.query<{ cc: { lat: number; lng: number } }>("driver.queue");
  await driver.ctx.setGeolocation({ latitude: cc.lat, longitude: cc.lng, accuracy: 8 });
  return driver;
};

const water = async (driver: Role): Promise<StockRow> => (await driver.api.query<StockRow[]>("driver.stock")).find((s) => s.key === "water")!;

/** A water request from the crew, moved onto this lane's truck by the green shirt. */
const waterRequest = async (crew: Role, green: Role, truckId: number, qty: number): Promise<number> => {
  const catalog = await crew.api.query<CatalogItem[]>("shared.catalog");
  const typeId = catalog.find((c) => c.key === "water")!.id;
  const lots = await crew.api.query<Array<{ lat: number; lng: number }>>("crew.lots");
  const req = await crew.api.mutate<{ id: number; truckId: number | null }>("crew.createRequest", { typeId, qty, lat: lots[0]!.lat, lng: lots[0]!.lng });
  if (req.truckId !== truckId) await green.api.mutate("green.assign", { requestId: req.id, truckId });
  return req.id;
};

test("a crew's request in the queue with its route: Next, En route, Delivered, stock down", async ({ as, L }) => {
  const crewInfo = L.crews[1]!;
  const crew = await as(crewInfo.link);
  const green = await as(L.green);
  const driver = await driverAtCc(as, L.truck);
  const truckId = (await driver.api.query<Queue>("driver.queue")).truck.id;
  const waterBefore = (await water(driver)).qty;
  const requestId = await waterRequest(crew, green, truckId, 2);
  let delivered = false;
  try {
    const stopKey = await until(async () => (await driver.api.query<Queue>("driver.queue")).stops.find((s) => s.items.some((i) => i.id === requestId))?.key, "the stop in the queue");
    const page = driver.page;
    await visit(page, "/");
    await expect(page.locator("path.lrb-route").first()).toBeAttached();
    await page.locator("[data-queue-button]").click();
    const queue = page.getByRole("dialog");
    const row = queue.getByRole("list", { name: "Stops in order" }).getByRole("listitem").filter({ hasText: crewInfo.name });
    await expect(row).toBeVisible();
    await expectNoOverflow(page, "queue sheet");
    const card = page.getByRole("region", { name: "Next stop" });
    if (!(await card.innerText()).includes(crewInfo.name)) {
      await row.getByRole("button").first().click();
      await until(async () => (await driver.api.query<Queue>("driver.queue")).pinnedKey === stopKey, "the stop pinned next");
    } else {
      await page.keyboard.press("Escape");
    }
    await expect(card).toContainText(crewInfo.name);
    await expect(card).toContainText("Water");
    const q = await driver.api.query<Queue>("driver.queue");
    expect(q.stops[0]!.key, "the pinned stop is first").toBe(stopKey);

    await card.getByRole("button", { name: "En route" }).click();
    await until(async () => (await crew.api.query<CrewRequest[]>("crew.myRequests")).find((r) => r.id === requestId && r.status === "en_route"), "en route on the crew's phone");
    await card.getByRole("button", { name: "Delivered" }).click();
    await until(async () => (await crew.api.query<CrewRequest[]>("crew.myRequests")).find((r) => r.id === requestId && r.status === "delivered"), "delivered on the crew's phone");
    delivered = true;
    expect((await water(driver)).qty).toBe(Math.max(0, waterBefore - 2));
    await visit(page, "/stock");
    await expect(page.getByRole("group", { name: "Water on the truck" }).getByRole("status")).toHaveText(String(Math.max(0, waterBefore - 2)));
  } finally {
    if (!delivered) await green.api.mutate("green.cancel", { requestId }).catch(() => undefined);
    const now = (await water(driver)).qty;
    if (now !== waterBefore) await driver.api.mutate("driver.adjustStock", { typeId: (await water(driver)).typeId, delta: waterBefore - now });
  }
});

test("stock goes above capacity with plus, Expected sets the capacity", async ({ as, L }) => {
  const driver = await as(L.truck);
  const start = await water(driver);
  const page = driver.page;
  try {
    await visit(page, "/stock");
    const group = page.getByRole("group", { name: "Water on the truck" });
    const plus = group.getByRole("button", { name: "Water plus one" });
    for (let i = start.qty; i <= start.capacity; i++) await plus.click();
    await expect(group.getByRole("status")).toHaveText(String(Math.max(start.qty, start.capacity) + 1));
    const now = await until(async () => {
      const w = await water(driver);
      return w.qty > w.capacity ? w : null;
    }, "water above capacity on the server");
    expect(now.capacity).toBe(start.capacity);

    await page.getByRole("button", { name: `Water expected, ${start.capacity}` }).click();
    const sheet = page.getByRole("dialog");
    await sheet.locator("[data-expected-input]").fill(String(start.capacity + 4));
    await sheet.locator("[data-expected-save]").click();
    await expect(page.getByRole("button", { name: `Water expected, ${start.capacity + 4}` })).toBeVisible();
    expect((await water(driver)).capacity).toBe(start.capacity + 4);
    await expectNoOverflow(page);
  } finally {
    const w = await water(driver);
    await driver.api.mutate("driver.setExpected", { typeId: w.typeId, capacity: start.capacity });
    if (w.qty !== start.qty) await driver.api.mutate("driver.adjustStock", { typeId: w.typeId, delta: start.qty - w.qty });
  }
  expect(await water(driver)).toMatchObject({ qty: start.qty, capacity: start.capacity });
});

/**
 * Centre of a Todo lot outline that a tap there would hit, clear of the card, banner and buttons.
 * The driver map draws lots on their own SVG pane without ids; the sheet title names the lot.
 */
const LOT_PICK = `() => {
  const map = document.querySelector('.leaflet-container').getBoundingClientRect();
  const block = [...document.querySelectorAll('[data-next-card], [data-guidance], [data-queue-button], [data-lots-toggle], header, [role=status]')].map((e) => e.getBoundingClientRect());
  const vw = window.innerWidth, vh = window.innerHeight;
  for (const el of document.querySelectorAll('path.lrb-lot-shape-open')) {
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    if (r.width < 6 || r.height < 6) continue;
    if (x < 30 || x > vw - 30 || y < 70 || y > vh - 30) continue;
    if (block.some((b) => x > b.left - 8 && x < b.right + 8 && y > b.top - 8 && y < b.bottom + 8)) continue;
    if (document.elementFromPoint(x, y) !== el) continue;
    return { x, y };
  }
  return null;
}`;

test("map: lots at the CC without bare parcels, a lot set Done from its sheet", async ({ as, L }) => {
  const driver = await driverAtCc(as, L.truck);
  const page = driver.page;
  const lots = (await driver.api.query<{ lots: Array<DriverLot & { address: string | null }> }>("driver.lots")).lots;
  expect(lots.length).toBeGreaterThan(20);
  await visit(page, "/");
  const map = page.getByRole("region", { name: "Route map" });
  await expect(map.locator("path.lrb-lot-shape").first()).toBeAttached();
  await expect(map.locator("path.lrb-parcel-shape"), "bare parcels on the driver map (SPEC 21: drivers see lots only)").toHaveCount(0);
  await expect(page.locator("[data-lots-toggle]")).toHaveAttribute("aria-pressed", "true");

  const sheet = page.getByRole("dialog");
  // While the map follows the truck the first tap takes the map (SPEC 17); the next opens the lot.
  for (let i = 0; i < 4 && !(await sheet.isVisible()); i++) {
    const at = await until(async () => (await page.evaluate(`(${LOT_PICK})()`)) as { x: number; y: number } | null, "a Todo lot on screen to tap");
    await page.mouse.click(at.x, at.y);
    await page.waitForTimeout(600);
  }
  await expect(sheet).toBeVisible();
  const title = (await sheet.getByRole("heading").first().innerText()).trim();
  const lot = lots.find((l) => l.address === title && l.status === "open");
  expect(lot, `the tapped lot "${title}" in driver.lots`).toBeTruthy();
  try {
    await expectNoOverflow(page, "driver lot sheet");
    await sheet.locator('[data-status="done"]').click();
    await until(async () => (await driver.api.query<{ lots: DriverLot[] }>("driver.lots")).lots.find((l) => l.id === lot!.id && l.status === "done"), "lot done");
  } finally {
    await driver.api.mutate("driver.setLotStatus", { lotId: lot!.id, status: "open" });
  }
});

test("Lots toggle hides the lots and brings them back", async ({ as, L }) => {
  const driver = await driverAtCc(as, L.truck);
  const page = driver.page;
  await visit(page, "/");
  const toggle = page.locator("[data-lots-toggle]");
  const shapes = page.getByRole("region", { name: "Route map" }).locator("path.lrb-lot-shape");
  await expect(shapes.first()).toBeAttached();
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(shapes).toHaveCount(0);
  await toggle.click();
  await expect(shapes.first()).toBeAttached();
});
