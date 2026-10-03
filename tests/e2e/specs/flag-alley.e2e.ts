/**
 * Flag on alleys (SPEC 22, alleys) at CC Webb (L.webbGreen): the e2e world's Overpass fake gives
 * an alley down the middle of every block, cached by the seed. Standing at an alley's mouth with
 * the fake compass pointing down it picks the alley half; the shutter makes one alley lot with a
 * Before; flagging the half again finds that lot; pointing across the alley picks the parcel. Each
 * lane works on a half inside its own rectangles (lanes.ts webbAreas).
 */
import { expect, expectNoOverflow, test, until, type Role } from "../support/fixtures.ts";
import type { LotPhotos } from "../support/photo.ts";

interface Half {
  key: string;
  name: string;
  line: Array<[number, number]>;
  lat: number;
  lng: number;
  lotId: number | null;
}
interface Area {
  id: number;
  label: string;
  ring: Array<[number, number]>;
}
interface Lot {
  id: number;
  status: string;
  source: string;
  parcelId: string | null;
  alleyKey: string | null;
  address: string | null;
}

const M_LAT = 111_320;
const lngM = (lat: number): number => 1 / (M_LAT * Math.cos((lat * Math.PI) / 180));

/** Fires `deviceorientationabsolute` a few times, as a phone's compass does, with these W3C angles. */
const face = async (page: Role["page"], alpha: number, beta: number, gamma: number): Promise<void> => {
  await page.evaluate(([a, b, g]) => {
    for (let i = 0; i < 6; i++) {
      window.setTimeout(() => window.dispatchEvent(new DeviceOrientationEvent("deviceorientationabsolute", { alpha: a, beta: b, gamma: g, absolute: true })), i * 50);
    }
  }, [alpha, beta, gamma] as const);
};

const pickedKey = (page: Role["page"]): Promise<string | null> =>
  page.evaluate(() => document.querySelector("[data-flag-strip] [data-flag-pick]")?.getAttribute("data-flag-pick") ?? null);

test("Flag: pointing down an alley picks its half; Todo makes one alley lot with a Before; again finds it; across picks the parcel", async ({ as, L }) => {
  const probe = await as(L.webbGreen);
  const [halves, plan] = await Promise.all([probe.api.query<Half[]>("green.alleyHalves"), probe.api.query<{ areas: Area[] }>("green.plan")]);
  // A west half (the line runs west to east) with no lot yet whose nearest rectangle is one of the
  // lane's. Alleys run behind the rectangles' rear lot lines, so a half is near a rectangle, not in it.
  const away = (h: Half, a: Area): number => {
    const xs = a.ring.map((p) => p[0]);
    const ys = a.ring.map((p) => p[1]);
    const dx = Math.max(Math.min(...xs) - h.lng, 0, h.lng - Math.max(...xs)) / lngM(h.lat);
    const dy = Math.max(Math.min(...ys) - h.lat, 0, h.lat - Math.max(...ys)) * M_LAT;
    return Math.hypot(dx, dy);
  };
  const nearest = (h: Half): Area => plan.areas.reduce((best, a) => (away(h, a) < away(h, best) ? a : best));
  const half = halves.find((h) => h.lotId === null && h.key.endsWith(":0") && h.line[0]![1] < h.line.at(-1)![1] && L.webbAreas.includes(nearest(h).label));
  expect(half, `an alley half in ${L.webbAreas.join(", ")}`).toBeTruthy();
  const h = half!;
  expect(h.name).toMatch(/^Alley, .+, west half$/);
  const [lat, lng] = h.line[0]!;
  // At the alley's mouth, 5 m west of its west end.
  const mouth = { latitude: lat, longitude: lng - 5 * lngM(lat), accuracy: 5 };
  const green = await as(L.webbGreen, { camera: true, geo: mouth });
  const page = green.page;
  let lotId: number | null = null;
  try {
    await page.goto("/flag");
    await expect(page.locator("[data-flag-shutter]")).toBeVisible();
    // Upright portrait facing east (alpha 270, beta 90): down the alley.
    await face(page, 270, 90, 0);
    await expect(page.locator("[data-flag-heading]")).toHaveText("Facing E");
    await expect.poll(() => pickedKey(page), { message: "the alley half picked" }).toBe(`a:${h.key}`);
    await expect(page.locator("[data-flag-target] p")).toContainText(h.name);
    await expect(page.locator("[data-flag-target] p")).toContainText("Not todo");
    await expectNoOverflow(page, "/flag on an alley");

    await page.locator("[data-flag-shutter]").click();
    const lot = await until(async () => (await green.api.query<{ lots: Lot[] }>("green.overview")).lots.find((l) => l.alleyKey === h.key), "the alley lot", 20_000);
    lotId = lot.id;
    expect(lot).toMatchObject({ status: "open", source: "drawn", parcelId: null, address: h.name });
    await until(async () => (await green.api.query<LotPhotos>("shared.lotPhotos", { lotId: lot.id })).photos.filter((p) => p.kind === "before").length === 1 || null, "a Before photo", 20_000);

    // The half is now that lot: the pick follows it, and a second flag adds a photo to the same lot.
    await expect.poll(() => pickedKey(page), { message: "the alley lot picked", timeout: 20_000 }).toBe(`l:${lot.id}`);
    await expect(page.locator("[data-flag-target] p")).toContainText("Todo");
    await page.locator("[data-flag-shutter]").click();
    await until(async () => (await green.api.query<LotPhotos>("shared.lotPhotos", { lotId: lot.id })).photos.filter((p) => p.kind === "before").length === 2 || null, "a second Before on the same lot", 20_000);
    const alleyLots = (await green.api.query<{ lots: Lot[] }>("green.overview")).lots.filter((l) => l.alleyKey === h.key);
    expect(alleyLots.map((l) => l.id)).toEqual([lot.id]);

    // In the alley, pointing across it (north): the parcel behind, not the alley.
    const mid = h.line.at(-1)!;
    await green.ctx.setGeolocation({ latitude: (lat + mid[0]) / 2, longitude: (lng + mid[1]) / 2, accuracy: 5 });
    await face(page, 0, 90, 0);
    await expect(page.locator("[data-flag-heading]")).toHaveText("Facing N");
    // A parcel, bare or a seeded lot; never the alley.
    const across = async (): Promise<boolean> => {
      const k = await pickedKey(page);
      return k !== null && k !== `l:${lot.id}` && !k.startsWith("a:");
    };
    await expect.poll(across, { message: "a parcel picked across the alley" }).toBe(true);
    const parcelKey = await pickedKey(page);
    if (parcelKey?.startsWith("l:")) {
      const l = (await green.api.query<{ lots: Lot[] }>("green.overview")).lots.find((x) => `l:${x.id}` === parcelKey);
      expect(l?.parcelId, "the lot picked across the alley is a parcel's").toBeTruthy();
    }
    // And down it again (east), from inside the half: the alley lot.
    await face(page, 270, 90, 0);
    await expect.poll(() => pickedKey(page), { message: "the alley lot picked again" }).toBe(`l:${lot.id}`);
  } finally {
    if (lotId !== null) await green.api.mutate("green.setLotStatus", { lotId, status: "not_todo" }).catch(() => undefined);
  }
});
