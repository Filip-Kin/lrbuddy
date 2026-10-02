/**
 * Green shirt at the lane's CC (SPEC 5 green, 7): the requests board sees a crew's request arrive
 * live, Assign and Cancel from its card, Add stop on the map dispatched to a truck, Broadcast
 * reaching a crew and a driver live, and the Crews, Trucks, Stats and Photos screens. Requests are
 * cancelled at the end; broadcasts stay in the CC's history (there is no delete).
 */
import { expect, expectNoOverflow, navTo, test, until, visit, type Role } from "../support/fixtures.ts";

interface GreenRequest {
  id: number;
  crewId: number | null;
  status: string;
  truckId: number | null;
  truckName: string | null;
}
interface Queue {
  stops: Array<{ key: string; items: Array<{ id: number }> }>;
}

const waterFrom = async (crew: Role, qty = 1): Promise<number> => {
  const typeId = (await crew.api.query<Array<{ id: number; key: string }>>("shared.catalog")).find((c) => c.key === "water")!.id;
  const lots = await crew.api.query<Array<{ lat: number; lng: number }>>("crew.lots");
  return (await crew.api.mutate<{ id: number }>("crew.createRequest", { typeId, qty, lat: lots[0]!.lat, lng: lots[0]!.lng })).id;
};

test("requests board: a crew's request arrives live, Assign and Cancel from its card", async ({ as, L }) => {
  const crewInfo = L.crews[2]!;
  const green = await as(L.green);
  const crew = await as(crewInfo.link);
  const page = green.page;
  await visit(page, "/requests");
  await expect(page.getByRole("heading", { level: 1, name: "Requests" })).toBeVisible();
  const requestId = await waterFrom(crew, 3);
  try {
    // Below xl the board is one column behind tabs; at xl the columns sit side by side and the tab
    // copy is hidden, so look only at what is on screen.
    const card = page.locator("article:visible", { hasText: crewInfo.name }).filter({ hasText: "Water x3" }).first();
    await expect(card, "the new request on the board without a reload").toBeVisible();
    await expectNoOverflow(page);
    const req = await until(async () => (await green.api.query<GreenRequest[]>("green.requests")).find((r) => r.id === requestId && r.truckId !== null), "the request on a truck");

    await card.getByRole("button", { name: "Assign" }).click();
    const sheet = page.getByRole("dialog", { name: "Assign Water x3" });
    await expect(sheet).toBeVisible();
    await expectNoOverflow(page, "assign sheet");
    const current = sheet.getByRole("button", { name: new RegExp(req.truckName!) });
    await expect(current).toBeDisabled();
    await expect(current).toContainText("Current");
    const others = sheet.getByRole("button").filter({ hasNotText: req.truckName! }).filter({ hasText: /Truck/ });
    if ((await others.count()) > 0) {
      const name = (await others.first().locator("span.font-bold").innerText()).trim();
      await others.first().click();
      await until(async () => (await green.api.query<GreenRequest[]>("green.requests")).find((r) => r.id === requestId && r.truckName === name), `the request moved to ${name}`);
      await expect(card).toContainText(name);
    } else {
      await page.keyboard.press("Escape");
    }

    await card.getByRole("button", { name: "Cancel" }).click();
    const confirm = page.getByRole("dialog", { name: "Cancel request" });
    await confirm.getByRole("button", { name: "Cancel request" }).click();
    await until(async () => (await crew.api.query<GreenRequest[]>("crew.myRequests")).find((r) => r.id === requestId && r.status === "cancelled"), "cancelled on the crew's phone");
    const closedTab = page.getByRole("tab", { name: /Closed/ });
    if (await closedTab.isVisible()) await closedTab.click();
    await expect(page.locator("article:visible", { hasText: crewInfo.name }).filter({ hasText: "Water x3" }).filter({ hasText: "Cancelled" }).first()).toBeVisible();
  } finally {
    await green.api.mutate("green.cancel", { requestId }).catch(() => undefined);
  }
});

test("Add stop: a pin on the map becomes a crewless stop in a truck's queue", async ({ as, L }) => {
  const green = await as(L.green);
  const page = green.page;
  const before = new Set((await green.api.query<GreenRequest[]>("green.requests")).map((r) => r.id));
  await visit(page, "/");
  await page.getByRole("button", { name: "Add stop", exact: true }).click();
  await expect(page.getByText("Drop pin")).toBeVisible();
  const box = (await page.locator(".leaflet-container").first().boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.55, box.y + box.height * 0.45);
  const sheet = page.getByRole("dialog", { name: "Add stop" });
  await expect(sheet).toBeVisible();
  await expectNoOverflow(page, "add stop sheet");
  await sheet.getByLabel("Label").fill(`E2E stop ${L.id}`);
  await sheet.getByRole("button", { name: "Send" }).click();
  const toast = page.getByText(/^Stop (sent|open)/).first();
  await expect(toast).toBeVisible();
  const text = (await toast.innerText()).trim();
  const made = await until(async () => (await green.api.query<GreenRequest[]>("green.requests")).find((r) => !before.has(r.id) && r.crewId === null), "the new crewless request");
  try {
    expect(text, "dispatched to a truck").toMatch(/^Stop sent, Truck \d/);
    const truckName = text.replace(/^Stop sent, /, "");
    const driver = await as(L.trucks[truckName]!);
    await until(async () => (await driver.api.query<Queue>("driver.queue")).stops.some((s) => s.items.some((i) => i.id === made.id)), `the stop in ${truckName}'s queue`);
    await visit(driver.page, "/");
    await driver.page.locator("[data-queue-button]").click();
    await expect(driver.page.getByRole("dialog").getByText(`E2E stop ${L.id}`).first()).toBeVisible();
  } finally {
    await green.api.mutate("green.cancel", { requestId: made.id });
  }
});

test("Broadcast reaches a crew and a driver at the CC without a reload", async ({ as, L }) => {
  const green = await as(L.green);
  const crew = await as(L.crews[2]!.link);
  const driver = await as(L.truck);
  await visit(crew.page, "/lots");
  await visit(driver.page, "/stock");
  const body = `E2E water at the CC ${L.id} ${Date.now() % 100000}`;
  await visit(green.page, "/broadcast");
  await green.page.getByLabel("Message").fill(body);
  await green.page.getByRole("button", { name: "Send" }).click();
  await expect(green.page.getByRole("region", { name: "History" })).toContainText(body);
  await expectNoOverflow(green.page);
  await expect(crew.page.getByRole("status").filter({ hasText: body }), "banner on the crew's phone").toBeVisible();
  await expect(driver.page.getByRole("status").filter({ hasText: body }), "banner on the driver's phone").toBeVisible();
  await expectNoOverflow(crew.page, "crew with banner");
  await expectNoOverflow(driver.page, "driver with banner");
  await crew.page.goto("/cc");
  await expect(crew.page.getByRole("main")).toContainText(body);
});

test("Crews, Trucks, Stats and Photos screens", async ({ as, L }) => {
  const green = await as(L.green);
  const page = green.page;
  await visit(page, "/");
  await navTo(page, "Crews");
  await expect(page.getByRole("heading", { level: 2, name: L.crews[0]!.name })).toBeVisible();
  await expect(page.getByRole("link", { name: /^Call / }).first()).toHaveAttribute("href", /^tel:/);
  await expectNoOverflow(page);
  await navTo(page, "Trucks");
  await expect(page.getByRole("heading", { level: 2, name: L.truckName })).toBeVisible();
  await expect(page.getByRole("region", { name: `${L.truckName} stock` })).toBeVisible();
  await expectNoOverflow(page);
  await navTo(page, "Stats");
  for (const h of ["Requests by type", "Lots done by company", "Lots"]) await expect(page.getByRole("heading", { level: 2, name: h, exact: true })).toBeVisible();
  await expect(page.getByRole("main")).not.toContainText(/\b(undefined|null|NaN)\b/);
  await expectNoOverflow(page);
  await navTo(page, "Photos");
  const pair = page.getByRole("main").getByRole("listitem").getByRole("button").first();
  await expect(pair, "the seeded before and after pairs").toBeVisible();
  await pair.click();
  const viewer = page.locator("[data-viewer]");
  await expect(viewer).toBeVisible();
  await expectNoOverflow(page, "photo viewer");
  await page.keyboard.press("Escape");
  await expect(viewer).toHaveCount(0);
});

test("a screen chunk gone after a deploy reloads the page, again on the next deploy", async ({ as, L }) => {
  const green = await as(L.green);
  green.allowPageErrors = true;
  const page = green.page;
  await visit(page, "/");
  // The tab already reloaded for an earlier deploy, long ago.
  await page.evaluate(() => sessionStorage.setItem("lrb.chunkReload", String(Date.now() - 3_600_000)));
  // This deploy: the Wrap up chunk the old page knows is gone, once.
  let failed = 0;
  await page.route(/\/assets\/WrapPage-[^/]+\.js$/, async (route) => {
    if (failed++ === 0) return route.fulfill({ status: 404, body: "" });
    return route.continue();
  });
  await navTo(page, "Wrap up");
  await expect.poll(() => failed, { message: "the chunk asked for twice: the 404, then after the reload" }).toBeGreaterThanOrEqual(2);
  await expect(page.locator("[data-error-panel]")).toHaveCount(0);
  await expect(page.locator("[data-wrap-camera], [data-flag-camera], video").first()).toBeAttached();
});
