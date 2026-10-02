/**
 * Live updates (SPEC 6): one phone changes something, another screen that is already open shows
 * it without a reload. Uses the lane's fourth crew; gas requests, which take nothing off a truck,
 * so the driver spec's stock counts are not disturbed. Everything is put back.
 */
import { expect, test, until, visit, type Role } from "../support/fixtures.ts";

interface CrewLot {
  id: number;
  address: string | null;
  status: string;
}
interface CrewRequest {
  id: number;
  status: string;
  truckName: string | null;
}
interface Stop {
  key: string;
  items: Array<{ id: number }>;
}

const gasFrom = async (crew: Role): Promise<number> => {
  const typeId = (await crew.api.query<Array<{ id: number; key: string }>>("shared.catalog")).find((c) => c.key === "gas_mower")!.id;
  const lots = await crew.api.query<Array<{ lat: number; lng: number }>>("crew.lots");
  return (await crew.api.mutate<{ id: number }>("crew.createRequest", { typeId, qty: 1, lat: lots[0]!.lat, lng: lots[0]!.lng })).id;
};

test("a crew marks a lot Done on its phone; the green map recolours it", async ({ as, L }) => {
  const crew = await as(L.crews[3]!.link);
  const green = await as(L.green);
  const lot = (await crew.api.query<CrewLot[]>("crew.lots")).find((l) => l.status === "open" && l.address)!;
  await visit(green.page, "/");
  const shape = green.page.locator(`[data-lot-id="${lot.id}"]`).first();
  await expect(shape).toHaveClass(/lrb-lot-shape-open/);
  await visit(crew.page, "/lots");
  const status = crew.page.getByRole("radiogroup", { name: `Status of ${lot.address}` });
  try {
    await status.getByRole("radio", { name: "Done", exact: true }).click();
    await expect(shape, "green map follows without a reload").toHaveClass(/lrb-lot-shape-done/);
    await status.getByRole("radio", { name: "Todo", exact: true }).click();
    await expect(shape).toHaveClass(/lrb-lot-shape-open/);
  } finally {
    await crew.api.mutate("crew.setLotStatus", { lotId: lot.id, status: "open" });
  }
});

test("the green shirt changes a crew's lot; the crew's Lots screen follows", async ({ as, L }) => {
  const crew = await as(L.crews[3]!.link);
  const green = await as(L.green);
  const lot = (await crew.api.query<CrewLot[]>("crew.lots")).filter((l) => l.status === "open" && l.address)[1]!;
  await visit(crew.page, "/lots");
  const status = crew.page.getByRole("radiogroup", { name: `Status of ${lot.address}` });
  await expect(status.getByRole("radio", { name: "Todo", exact: true })).toBeChecked();
  try {
    await green.api.mutate("green.setLotStatus", { lotId: lot.id, status: "in_progress" });
    await expect(status.getByRole("radio", { name: "In progress", exact: true }), "crew screen follows without a reload").toBeChecked();
  } finally {
    await green.api.mutate("green.setLotStatus", { lotId: lot.id, status: "open" });
  }
  await expect(status.getByRole("radio", { name: "Todo", exact: true })).toBeChecked();
});

test("a crew's new request rings on the green map, and En route and Delivered reach the crew's screen", async ({ as, L }) => {
  const crew = await as(L.crews[3]!.link);
  const green = await as(L.green);
  await visit(green.page, "/");
  const rings = green.page.locator(".lrb-req");
  const ringsBefore = await rings.count();
  await visit(crew.page, "/requests");
  const requestId = await gasFrom(crew);
  let done = false;
  try {
    await expect.poll(() => rings.count(), { message: "a ring for the crew on the green map" }).toBeGreaterThan(ringsBefore);
    const req = await until(async () => (await crew.api.query<CrewRequest[]>("crew.myRequests")).find((r) => r.id === requestId && r.truckName), "a truck for the request");
    const card = crew.page.locator("article", { hasText: "Gas, mower" }).filter({ hasText: req.truckName! }).first();
    await expect(card).toContainText("Assigned");
    const driver = await as(L.trucks[req.truckName!]!);
    const stop = await until(async () => (await driver.api.query<{ stops: Stop[] }>("driver.queue")).stops.find((s) => s.items.some((i) => i.id === requestId)), "the stop");
    await driver.api.mutate("driver.enRoute", { stopKey: stop.key });
    await expect(card, "En route without a reload").toContainText("En route");
    await driver.api.mutate("driver.deliver", { stopKey: stop.key });
    done = true;
    await expect(crew.page.locator("article", { hasText: "Gas, mower" }).filter({ hasText: "Delivered" }).first(), "Delivered without a reload").toBeVisible();
  } finally {
    if (!done) await green.api.mutate("green.cancel", { requestId }).catch(() => undefined);
  }
});
