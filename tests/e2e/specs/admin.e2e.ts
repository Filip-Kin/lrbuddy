/**
 * Admin (SPEC 5 admin, 8, 16, 19, 25): a new event that stays inactive; a CC placed on the map of a
 * free day with a green shirt and a truck whose codes sign in, and a new green code that locks the
 * old one out; Copy from the previous day; crew CSV import; the Land Bank import by rectangle (the
 * Land Bank answers from tests/e2e/support/fake-world.ts, inside the server); the print page; the
 * CSV and zip downloads; the crash panel and the client error list; the green view.
 */
import { readFile } from "node:fs/promises";
import { expect, expectNoOverflow, test, until, visit, type Role } from "../support/fixtures.ts";
import { PARCELS } from "../support/fake-world.ts";
import { centreOf, centreOn, zoomOf, zoomOn } from "../support/map.ts";

interface DayRow {
  id: number;
  sort: number;
  label: string;
}
interface DayData {
  ccs: Array<{ id: number; name: string; greenCode: string | null; trucks: Array<{ id: number; name: string; code: string }>; greenShirts: Array<{ name: string }> }>;
}
interface AdminLot {
  id: number;
  ccId: number | null;
  source: string;
  lat: number;
  lng: number;
}

const dayOf = async (adm: Role, sort: number): Promise<DayRow> => (await adm.api.query<DayRow[]>("admin.days.list")).find((d) => d.sort === sort)!;

test("New event: made without taking over the active one", async ({ as, admin, L }) => {
  const adm = await as(admin);
  const page = adm.page;
  await visit(page, "/admin");
  await page.getByRole("button", { name: "New event" }).click();
  const sheet = page.getByRole("dialog", { name: "New event" });
  await sheet.getByLabel("Name").fill(`E2E event ${L.id}`);
  await sheet.getByLabel("First day").fill("2027-09-27");
  const makeActive = sheet.getByRole("switch", { name: "Make active" });
  if ((await makeActive.getAttribute("aria-checked")) === "true") await makeActive.click();
  await expectNoOverflow(page, "new event sheet");
  await sheet.getByRole("button", { name: "Create event" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Events" }).locator("..").locator("..")).toContainText(`E2E event ${L.id}`);
  await expect(page.getByRole("heading", { level: 1, name: "Demo 2026" })).toBeVisible();
  const events = await adm.api.query<Array<{ name: string; active: boolean }>>("admin.events.list");
  expect(events.find((e) => e.active)?.name).toBe("Demo 2026");
  expect(events.find((e) => e.name === `E2E event ${L.id}`)?.active).toBe(false);
});

test("Day: a CC placed on the map, a green shirt and a truck; the codes sign in; New code locks the old one out", async ({ as, admin, L }) => {
  const adm = await as(admin);
  const page = adm.page;
  const day = await dayOf(adm, L.freeDay);
  const ccName = `E2E ${L.id.toUpperCase()}`;
  let ccId: number | null = null;
  try {
    await visit(page, `/admin/days/${day.id}`);
    await expect(page.getByRole("heading", { name: "No command centers" })).toBeVisible();
    await page.getByRole("button", { name: "Add CC" }).first().click();
    await expect(page.getByText("New CC position")).toBeVisible();
    const map = (await page.getByRole("region", { name: "Command centers map" }).boundingBox())!;
    await page.mouse.click(map.x + map.width / 2, map.y + map.height / 2);
    const sheet = page.getByRole("dialog", { name: "New command center" });
    await sheet.getByLabel("Name").fill(ccName);
    await sheet.getByLabel("Address").fill("100 Test St");
    await sheet.getByLabel("Letter").fill("Z");
    await expectNoOverflow(page, "new CC sheet");
    await sheet.getByRole("button", { name: "Add command center" }).click();
    const data = await until(async () => (await adm.api.query<DayData>("admin.days.get", { id: day.id })).ccs.find((c) => c.name === ccName), "the new CC");
    ccId = data.id;
    const card = page.locator(`#cc-card-${ccId}`);
    await expect(card).toContainText(`CC ${ccName}`);

    await card.getByRole("heading", { name: "Green shirts" }).locator("..").getByRole("button", { name: "Add" }).click();
    const shirt = page.getByRole("dialog", { name: "New green shirt" });
    await shirt.getByLabel("Name").fill("Dana E2E");
    await shirt.getByLabel("Phone").fill("313-555-0999");
    await shirt.getByRole("button", { name: "Add green shirt" }).click();
    await expect(card).toContainText("Dana E2E");

    await card.getByRole("heading", { name: "Trucks" }).locator("..").getByRole("button", { name: "Add" }).click();
    const truckSheet = page.getByRole("dialog", { name: "New truck" });
    await truckSheet.getByLabel("Driver", { exact: true }).fill("Lee E2E");
    await truckSheet.getByRole("button", { name: "Add truck" }).click();
    const cc = await until(async () => (await adm.api.query<DayData>("admin.days.get", { id: day.id })).ccs.find((c) => c.id === ccId && c.trucks.length === 1), "the new truck");
    await expectNoOverflow(page);

    const green = await as(`/g/${cc.greenCode!}`);
    await visit(green.page, "/");
    await expect(green.page.locator("header")).toContainText(`CC ${ccName}`);
    const driver = await as(`/t/${cc.trucks[0]!.code}`);
    await visit(driver.page, "/stock");
    await expect(driver.page.locator("header")).toContainText(cc.trucks[0]!.name);

    await card.getByRole("button", { name: "New code" }).first().click();
    await page.getByRole("dialog", { name: `New green code for CC ${ccName}` }).getByRole("button", { name: "New code" }).click();
    const fresh = await until(async () => {
      const c = (await adm.api.query<DayData>("admin.days.get", { id: day.id })).ccs.find((x) => x.id === ccId);
      return c && c.greenCode !== cc.greenCode ? c.greenCode : null;
    }, "a new green code");
    await expect(card).toContainText(fresh);
    expect((await green.api.query<{ role: string }>("shared.me")).role, "the old code's phone is signed out").toBe("anon");
    const old = await green.ctx.request.get(`/g/${cc.greenCode!}`, { maxRedirects: 0 });
    expect(old.headers()["location"], "the old green link").toBe("/login?link=unknown");
  } finally {
    if (ccId !== null) await adm.api.mutate("admin.ccs.delete", { id: ccId });
  }
});

test("Copy from the previous day brings its CCs and trucks", async ({ as, admin, L }) => {
  test.skip(L.id === "b", "One copy per run: Day 5 is the only empty day after a set-up day (Day 4); lane a runs it");
  const adm = await as(admin);
  const page = adm.page;
  const day = await dayOf(adm, 5);
  try {
    await visit(page, `/admin/days/${day.id}`);
    await page.getByRole("button", { name: "Copy from Day 4" }).click();
    await expect(page.getByText(/CC.* and .*truck.* copied/)).toBeVisible();
    const data = await adm.api.query<DayData>("admin.days.get", { id: day.id });
    expect(data.ccs.map((c) => c.name)).toEqual(["Webb"]);
    expect(data.ccs[0]!.trucks.map((t) => t.name).sort()).toEqual(["Truck B1", "Truck B2"]);
    await expect(page.locator(`#cc-card-${data.ccs[0]!.id}`)).toContainText("CC Webb");
  } finally {
    for (const c of (await adm.api.query<DayData>("admin.days.get", { id: day.id })).ccs) await adm.api.mutate("admin.ccs.delete", { id: c.id });
  }
});

test("Crews: CSV import adds crews to a day's CC", async ({ as, admin, L }) => {
  const adm = await as(admin);
  const page = adm.page;
  const day = await dayOf(adm, L.freeDay);
  const ccName = `E2E CSV ${L.id.toUpperCase()}`;
  const cc = await adm.api.mutate<{ id: number }>("admin.ccs.create", { dayId: day.id, name: ccName, lat: 42.38, lng: -83.0 });
  try {
    await visit(page, `/admin/crews?day=${day.id}`);
    await page.getByRole("radiogroup", { name: "Day" }).getByRole("radio", { name: new RegExp(`^${day.label}\\b`) }).click();
    await page.getByRole("button", { name: "Import CSV" }).first().click();
    const sheet = page.getByRole("dialog", { name: "Import crews" });
    const csv = ["day,cc,company,lead_name,lead_phone,headcount", `${day.label},${ccName},Ford,Ana E2E,313-555-0801,9`, `${day.label},${ccName},Ford,Ben E2E,313-555-0802,11`, `Day 99,${ccName},Ford,Nobody,,1`].join("\n");
    await sheet.getByRole("textbox", { name: "CSV" }).fill(csv);
    await expectNoOverflow(page, "import sheet");
    await sheet.getByRole("button", { name: "Import 3 rows" }).click();
    await expect(sheet.getByRole("status")).toContainText("1 row skipped");
    await expect(sheet.getByRole("status")).toContainText('Row 4: day "Day 99" not found');
    await page.keyboard.press("Escape");
    const rows = await adm.api.query<Array<{ name: string; leadName: string | null; ccId: number }>>("admin.crews.list", { dayId: day.id });
    const mine = rows.filter((r) => r.ccId === cc.id);
    expect(mine.map((r) => r.leadName).sort()).toEqual(["Ana E2E", "Ben E2E"]);
    expect(mine.every((r) => /^FORD \d+$/.test(r.name))).toBe(true);
    await expect(page.getByRole("main")).toContainText("Ana E2E");
    await expectNoOverflow(page);
  } finally {
    await adm.api.mutate("admin.ccs.delete", { id: cc.id });
  }
});

test("Lots: Import DLBA by rectangle (Land Bank answered offline), the new lots land at the chosen CC", async ({ as, admin, L }) => {
  const adm = await as(admin);
  const page = adm.page;
  const webb = await as(L.webbGreen);
  const area = (await webb.api.query<{ areas: Array<{ label: string; ring: Array<[number, number]> }> }>("green.plan")).areas.find((a) => a.label === L.importArea)!;
  const [w, s, e, n] = [Math.min(...area.ring.map((p) => p[0])), Math.min(...area.ring.map((p) => p[1])), Math.max(...area.ring.map((p) => p[0])), Math.max(...area.ring.map((p) => p[1]))];
  const mid = { lat: (s + n) / 2, lng: (w + e) / 2 };
  const bare = new Set((await webb.api.query<Array<{ parcelId: string }>>("green.parcels")).map((p) => p.parcelId));
  // A Land Bank parcel of the fake city that is not a lot yet, near the middle of the lane's rectangle.
  const target = PARCELS.filter((p) => p.dlba && bare.has(p.parcelId) && p.lng > w && p.lng < e && p.lat > s && p.lat < n).sort(
    (x, y) => Math.hypot(x.lat - mid.lat, x.lng - mid.lng) - Math.hypot(y.lat - mid.lat, y.lng - mid.lng),
  )[0]!;
  expect(target, "a bare Land Bank parcel in the rectangle").toBeTruthy();
  const before = await adm.api.query<AdminLot[]>("admin.lots.list");
  const beforeIds = new Set(before.map((l) => l.id));
  const webbCc = (await webb.api.query<{ cc: { id: number } }>("green.overview")).cc.id;
  const anchor = before.filter((l) => l.ccId === webbCc).reduce((a, l) => (Math.hypot(l.lat - target.lat, l.lng - target.lng) < Math.hypot(a.lat - target.lat, a.lng - target.lng) ? l : a));
  let added: number[] = [];
  try {
    await visit(page, "/admin/lots");
    await page.getByRole("radiogroup", { name: "Show" }).getByRole("radio", { name: /^Day 4, CC Webb/ }).click();
    const sel = `[data-lot-id="${anchor.id}"]`;
    await expect(page.locator(sel).first()).toBeAttached();
    // The map sits under the toolbar on a phone: keep it in the middle of the viewport so every
    // drag and click lands on it. Clicking Import DLBA can scroll the page, so measure after it.
    const mapRegion = page.getByRole("region", { name: "Lots map" });
    const middle = (): Promise<void> => mapRegion.evaluate((el) => el.scrollIntoView({ block: "center" }));
    await middle();
    await centreOn(page, sel);
    await zoomOn(page, sel, 17);
    await centreOn(page, sel);
    const zoom = await zoomOf(page);
    expect(zoom).toBeGreaterThanOrEqual(17);
    await page.getByRole("button", { name: "Import DLBA" }).click();
    await middle();
    const at = (await centreOf(page, sel))!;
    // The target from the anchor lot at this zoom (Web Mercator, small distances).
    const pxLng = (256 * 2 ** zoom) / 360;
    const pxLat = pxLng / Math.cos((target.lat * Math.PI) / 180);
    const tx = at.x + (target.lng - anchor.lng) * pxLng;
    const ty = at.y - (target.lat - anchor.lat) * pxLat;
    // Oriented rectangle round the target: two clicks along the street, a third for the width (SPEC 16).
    await page.mouse.click(tx - 25, ty - 6);
    await page.mouse.click(tx + 25, ty - 6);
    await page.mouse.click(tx, ty + 6);
    const sheet = page.getByRole("dialog");
    await expect(sheet).toContainText("Already in this area");
    await sheet.getByLabel("Command center").selectOption({ label: "Day 4, CC Webb" });
    await expectNoOverflow(page, "import sheet");
    await sheet.getByRole("button", { name: "Import Land Bank lots" }).click();
    await expect(page.getByText(/[1-9]\d* lots? added, \d+ updated, \d+ outlines/).first()).toBeVisible({ timeout: 30_000 });
    const after = await adm.api.query<Array<AdminLot & { parcelId: string | null }>>("admin.lots.list");
    // Other tests add lots at the same time (paint, the other lane's import): keep the ones in this rectangle.
    const fresh = after.filter((l) => !beforeIds.has(l.id) && l.lng > w && l.lng < e && l.lat > s && l.lat < n && l.source === "dlba");
    added = fresh.map((l) => l.id);
    expect(fresh.map((l) => l.parcelId)).toContain(target.parcelId);
    expect(fresh.every((l) => l.source === "dlba" && l.ccId === webbCc)).toBe(true);
  } finally {
    if (added.length) await adm.api.mutate("admin.lots.delete", { ids: added });
  }
});

test("Print: every map loads, the page sets data-print-ready, company sheets are landscape", async ({ as, admin, isMobile }) => {
  test.skip(isMobile, "The print page is a laptop surface (scripts/gate.py ROUTE_SIZES)");
  const adm = await as(admin);
  const page = adm.page;
  await page.goto("/plan/print");
  await page.locator("[data-print-ready]").waitFor({ state: "attached", timeout: 60_000 });
  const sheets = page.locator("[data-sheet=company]");
  expect(await sheets.count()).toBeGreaterThan(0);
  const box = (await sheets.first().boundingBox())!;
  expect(box.width).toBeGreaterThan(box.height);
  await expect(page.locator(".lrb-pm-pill").filter({ hasText: "&" }).first()).toBeAttached();
  await expect(page.getByRole("button", { name: "Print" })).toBeEnabled();
  await expectNoOverflow(page, "/plan/print");
});

test("Export: each CSV downloads with a header and rows; the photos zip downloads", async ({ as, admin }) => {
  const adm = await as(admin);
  const page = adm.page;
  await visit(page, "/admin/export");
  for (const label of ["Requests", "Lots", "Positions", "Stock moves", "Photos"]) {
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: `Download ${label} CSV` }).click()]);
    expect(download.suggestedFilename()).toMatch(/^lrbuddy-.*\.csv$/);
    const text = await readFile((await download.path())!, "utf8");
    const lines = text.trim().split(/\r?\n/);
    expect(lines.length, `${label} CSV rows`).toBeGreaterThan(1);
    expect(lines[0]!.split(",").length, `${label} CSV columns`).toBeGreaterThan(2);
    expect(text).not.toMatch(/\b(undefined|NaN|\[object Object\])\b/);
  }
  await visit(page, "/admin/photos");
  const [zip] = await Promise.all([page.waitForEvent("download"), page.getByRole("link", { name: "Download zip" }).click()]);
  expect(zip.suggestedFilename()).toMatch(/^lrbuddy-photos-.*\.zip$/);
  const bytes = await readFile((await zip.path())!);
  expect(bytes.subarray(0, 2).toString("latin1")).toBe("PK");
});

test("Crash panel on the test route, and the report in the client error list", async ({ as, admin }) => {
  const adm = await as(admin);
  adm.allowPageErrors = true;
  const page = adm.page;
  await visit(page, "/admin/client-errors");
  await page.goto("/admin/client-errors/test");
  const panel = page.locator("[data-error-panel]");
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("heading", { level: 2 })).toHaveText("Screen failed");
  await expect(panel.locator("[data-error-message]")).toContainText("Crash test");
  for (const name of ["Reload", "Back"]) expect((await panel.getByRole("button", { name }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await expect(page.getByRole("button", { name: "Menu" }).or(page.getByRole("navigation", { name: "Main" })).first()).toBeVisible();
  await expectNoOverflow(page, "crash panel");
  await until(
    async () =>
      (await adm.api.query<Array<{ message: string; role: string | null; url: string }>>("admin.clientErrors")).some(
        (r) => r.message.includes("Crash test") && r.role === "admin" && r.url === "/admin/client-errors/test",
      ),
    "the report in admin.clientErrors",
  );
  await panel.getByRole("button", { name: "Back" }).click();
  await page.waitForURL("**/admin/client-errors");
  await expect(page.locator("[data-error-panel]")).toHaveCount(0);
  await expect(page.locator("[data-client-error]").first()).toBeVisible();
  await expectNoOverflow(page);
});

test("Green view opens a CC's green map for the admin", async ({ as, admin, L }) => {
  const adm = await as(admin);
  const page = adm.page;
  await visit(page, "/admin/green");
  await page.getByRole("link", { name: new RegExp(`^CC ${L.cc}`) }).click();
  await page.waitForURL(/\/green\?cc=\d+/);
  await expect(page.getByRole("region", { name: "Command center map" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Command center map" }).getByRole("button", { name: `CC ${L.cc}` }).first()).toBeVisible();
  await expectNoOverflow(page);
});
