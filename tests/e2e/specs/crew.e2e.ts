/**
 * Red shirt (SPEC 5 crew, 15, 21) as the lane's first crew: request water and watch it get a
 * truck, cancel it, mark lots inside the crew's rectangle, be refused outside it, and take before
 * and after photos. Every change is put back at the end of its test.
 */
import { expect, expectNoOverflow, navTo, test, until, visit, type Role } from "../support/fixtures.ts";
import { jpegFile, type LotPhotos } from "../support/photo.ts";

interface CrewLot {
  id: number;
  address: string | null;
  status: string;
  lat: number;
  lng: number;
  mine: boolean;
}
interface CrewRequest {
  id: number;
  typeKey: string;
  qty: number;
  status: string;
  truckName: string | null;
}
interface GreenLot {
  id: number;
  crewId: number | null;
  status: string;
  parcelId: string | null;
}

/** Signs in as the crew with the phone standing on one of its lots. */
const crewOnLot = async (as: (who: string, o?: object) => Promise<Role>, link: string): Promise<{ crew: Role; lots: CrewLot[] }> => {
  const crew = await as(link, { geo: { latitude: 42.37, longitude: -83.0, accuracy: 8 } });
  const lots = await crew.api.query<CrewLot[]>("crew.lots");
  expect(lots.length, "the seed gives every crew lots in its rectangle").toBeGreaterThan(3);
  await crew.ctx.setGeolocation({ latitude: lots[0]!.lat, longitude: lots[0]!.lng, accuracy: 8 });
  return { crew, lots };
};

test("map shows the crew's lots, its CC and the Request button", async ({ as, L }) => {
  const { crew, lots } = await crewOnLot(as, L.crews[0]!.link);
  await visit(crew.page, "/");
  const map = crew.page.getByRole("region", { name: "Crew map" });
  await expect(map).toBeVisible();
  await expect(map.getByRole("button", { name: `CC ${L.cc}` })).toBeVisible();
  await expect(crew.page.locator(`[data-lot-id="${lots[0]!.id}"]`).first()).toBeAttached();
  await expect(crew.page.getByRole("main").getByRole("link", { name: "Request", exact: true })).toBeVisible();
});

test("request water, see the truck it went to, cancel it", async ({ as, L }) => {
  const { crew } = await crewOnLot(as, L.crews[0]!.link);
  const page = crew.page;
  const before = new Set((await crew.api.query<CrewRequest[]>("crew.myRequests")).map((r) => r.id));
  await visit(page, "/");
  await page.getByRole("main").getByRole("link", { name: "Request", exact: true }).click();
  await page.waitForURL("**/request");
  await page.getByRole("button", { name: "Water", exact: true }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet).toBeVisible();
  await expectNoOverflow(page, "request sheet");
  // Water is not counted (only mowers and weed whips are): no stepper, it goes as one.
  await expect(sheet.getByRole("button", { name: "More" })).toHaveCount(0);
  await sheet.getByRole("button", { name: "Send" }).click();
  await page.waitForURL("**/requests");

  const mine = await until(async () => (await crew.api.query<CrewRequest[]>("crew.myRequests")).find((r) => !before.has(r.id) && r.typeKey === "water"), "the new request");
  expect(mine.qty).toBe(1);
  const assigned = await until(
    async () => (await crew.api.query<CrewRequest[]>("crew.myRequests")).find((r) => r.id === mine.id && r.status === "assigned" && r.truckName),
    "a truck for the request",
  );
  const card = page.locator("article", { hasText: "Water" }).filter({ hasText: assigned.truckName! }).first();
  await expect(card).toBeVisible();
  await expect(card).toContainText("Assigned");
  await expectNoOverflow(page);

  await card.getByRole("button", { name: "Cancel" }).click();
  const confirm = page.getByRole("dialog");
  await expect(confirm).toContainText("Cancel request");
  await confirm.getByRole("button", { name: "Cancel request" }).click();
  await until(async () => (await crew.api.query<CrewRequest[]>("crew.myRequests")).find((r) => r.id === mine.id && r.status === "cancelled"), "cancelled");
  await expect(page.locator("article", { hasText: "Water" }).filter({ hasText: "Cancelled" }).first()).toBeVisible();
});

test("lots page: Todo to Done and back on a lot in the crew's rectangle", async ({ as, L }) => {
  const { crew, lots } = await crewOnLot(as, L.crews[0]!.link);
  const lot = lots.find((l) => l.status === "open" && l.address);
  expect(lot, "a Todo lot in the rectangle").toBeTruthy();
  await visit(crew.page, "/lots");
  const status = crew.page.getByRole("radiogroup", { name: `Status of ${lot!.address}` });
  await expect(status.getByRole("radio", { name: "Todo", exact: true })).toBeChecked();
  await expect(status.getByRole("radio", { name: "Do not touch" })).toBeDisabled();
  try {
    await status.getByRole("radio", { name: "Done", exact: true }).click();
    await expect(status.getByRole("radio", { name: "Done", exact: true })).toBeChecked();
    await until(async () => (await crew.api.query<CrewLot[]>("crew.lots")).find((l) => l.id === lot!.id && l.status === "done"), "lot done on the server");
    await crew.page.reload();
    await expect(crew.page.getByRole("radiogroup", { name: `Status of ${lot!.address}` }).getByRole("radio", { name: "Done", exact: true })).toBeChecked();
    await crew.page.getByRole("radiogroup", { name: `Status of ${lot!.address}` }).getByRole("radio", { name: "Todo", exact: true }).click();
    await until(async () => (await crew.api.query<CrewLot[]>("crew.lots")).find((l) => l.id === lot!.id && l.status === "open"), "lot back to Todo");
  } finally {
    await crew.api.mutate("crew.setLotStatus", { lotId: lot!.id, status: "open" }).catch(() => undefined);
  }
});

test("a lot outside the crew's rectangle is not on its map and cannot be changed", async ({ as, L }) => {
  const { crew, lots } = await crewOnLot(as, L.crews[0]!.link);
  const green = await as(L.green);
  const ids = new Set(lots.map((l) => l.id));
  const outside = (await green.api.query<{ lots: GreenLot[] }>("green.overview")).lots.find((l) => !ids.has(l.id) && l.status === "open");
  expect(outside, "a Todo lot at the CC outside this crew's rectangle").toBeTruthy();
  const code = await crew.api.refusal("mutate", "crew.setLotStatus", { lotId: outside!.id, status: "done" });
  expect(code, "crew.setLotStatus outside the rectangle").not.toBeNull();
  expect(["FORBIDDEN", "NOT_FOUND", "BAD_REQUEST"]).toContain(code);
  const after = (await green.api.query<{ lots: GreenLot[] }>("green.overview")).lots.find((l) => l.id === outside!.id);
  expect(after?.status).toBe("open");
  await visit(crew.page, "/");
  await expect(crew.page.locator(`[data-lot-id="${lots[0]!.id}"]`).first()).toBeAttached();
  await expect(crew.page.locator(`[data-lot-id="${outside!.id}"]`)).toHaveCount(0);
});

test("before and after photos from the lots list", async ({ as, L }) => {
  const { crew, lots } = await crewOnLot(as, L.crews[0]!.link);
  const lot = lots.find((l) => l.address && !/BUCKINGHAM|ALTER/.test(l.address)) ?? lots[1]!;
  const initial = new Set((await crew.api.query<LotPhotos>("shared.lotPhotos", { lotId: lot.id })).photos.map((p) => p.id));
  await visit(crew.page, "/lots");
  const row = crew.page.getByRole("listitem").filter({ has: crew.page.getByRole("heading", { name: lot.address!, exact: true }) });
  const made: number[] = [];
  try {
    for (const [kind, seed] of [["before", 1], ["after", 2]] as const) {
      await row.locator(`[data-camera-input="${kind}"]`).setInputFiles(jpegFile(`${kind}.jpg`, seed));
      const photo = await until(
        async () => (await crew.api.query<LotPhotos>("shared.lotPhotos", { lotId: lot.id })).photos.find((p) => p.kind === kind && !initial.has(p.id)),
        `${kind} photo on the server`,
        20_000,
      );
      made.push(photo.id);
      const label = kind === "before" ? "Before" : "After";
      await expect(row.getByRole("button", { name: `${label} photo, ${lot.address}` }).locator("img")).toBeVisible();
    }
    const res = await crew.ctx.request.get(`/photos/${made[0]}/thumb`);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("image/jpeg");
    await expectNoOverflow(crew.page);
  } finally {
    for (const id of made) await crew.api.mutate("shared.deletePhoto", { id }).catch(() => undefined);
  }
});

test("CC page and settings: green shirts to call, the crew card", async ({ as, L }) => {
  const crew = await as(L.crews[0]!.link);
  await visit(crew.page, "/");
  await navTo(crew.page, "Command center");
  await expect(crew.page.getByRole("heading", { level: 1, name: `CC ${L.cc}` })).toBeVisible();
  await expect(crew.page.getByRole("region", { name: "Green shirts" }).getByRole("link", { name: "Call" }).first()).toHaveAttribute("href", /^tel:/);
  await expectNoOverflow(crew.page);
  await navTo(crew.page, "Settings");
  await expect(crew.page.getByRole("heading", { level: 2, name: "Crew" })).toBeVisible();
  await expect(crew.page.getByRole("main").getByText(L.crews[0]!.name).first()).toBeVisible();
  await expectNoOverflow(crew.page);
});
