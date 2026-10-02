/**
 * Map helpers, ported from scripts/gate.py where they were proven: find a bare parcel a tap would
 * hit, zoom on it with the wheel, find three neighbouring bare parcels in a row for a paint
 * stroke, read a lot's fill colour.
 */
import { expect, type Page } from "@playwright/test";

export const RED = "rgb(229, 72, 77)";

/** Leaflet zoom of the first map, from MapView's data-zoom. */
export const zoomOf = (page: Page, root = ""): Promise<number> =>
  page.evaluate((r) => Number((document.querySelector(`${r} .leaflet-container`) as HTMLElement | null)?.dataset.zoom ?? 0), root);

/**
 * A bare parcel near the map centre that a tap there would hit (not under a marker or a pill).
 * `allow` limits the pick to those parcel ids.
 */
export const pickBareParcel = (page: Page, allow: readonly string[] | null = null): Promise<string | null> =>
  page.evaluate((ids) => {
    const ok = ids ? new Set(ids) : null;
    const map = document.querySelector(".leaflet-container")!.getBoundingClientRect();
    const cx = map.left + map.width / 2;
    const cy = map.top + map.height / 2;
    let best: { d: number; pid: string } | null = null;
    for (const el of document.querySelectorAll("[data-parcel]")) {
      const pid = el.getAttribute("data-parcel")!;
      if (ok && !ok.has(pid)) continue;
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      if (x < map.left + 60 || x > map.right - 160 || y < map.top + 130 || y > map.bottom - 110) continue;
      if (document.elementFromPoint(x, y) !== el) continue;
      const d = Math.hypot(x - cx, y - cy);
      if (!best || d < best.d) best = { d, pid };
    }
    return best ? best.pid : null;
  }, allow as string[] | null);

export const centreOf = (page: Page, selector: string): Promise<{ x: number; y: number; w: number; h: number } | null> =>
  page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
  }, selector);

/** Class and computed fill of the lot outline drawn for a parcel id. */
export const lotFill = (page: Page, parcelId: string): Promise<{ cls: string; fill: string } | null> =>
  page.evaluate((pid) => {
    const el = document.querySelector(`[data-lot-parcel="${CSS.escape(pid)}"]`);
    if (!el) return null;
    return { cls: el.getAttribute("class") ?? "", fill: getComputedStyle(el).fill };
  }, parcelId);

/** Wheel-zooms on an element until the map reaches the zoom. */
export const zoomOn = async (page: Page, selector: string, target: number): Promise<void> => {
  for (let i = 0; i < 12 && (await zoomOf(page)) < target; i++) {
    const at = await centreOf(page, selector);
    if (!at) return;
    await page.mouse.move(at.x, at.y);
    await page.mouse.wheel(0, -120);
    await page.waitForTimeout(450);
  }
};

/**
 * Drags the map until the element sits near the middle of it. Every bare parcel is in the DOM
 * whether on screen or not, so its box says how far to pan. A short pause before letting go keeps
 * Leaflet from adding inertia.
 */
export const centreOn = async (page: Page, selector: string): Promise<void> => {
  for (let i = 0; i < 6; i++) {
    const map = await page.locator(".leaflet-container").first().boundingBox();
    const at = await centreOf(page, selector);
    if (!map || !at) return;
    const cx = map.x + map.width / 2;
    const cy = map.y + map.height / 2;
    const dx = Math.max(-map.width / 2 + 40, Math.min(map.width / 2 - 40, cx - at.x));
    const dy = Math.max(-map.height / 2 + 40, Math.min(map.height / 2 - 40, cy - at.y));
    if (Math.abs(cx - at.x) < 40 && Math.abs(cy - at.y) < 40) return;
    // Start beside the middle, not on a pill or the CC marker.
    const sx = cx - dx / 2;
    const sy = cy - dy / 2;
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    await page.mouse.move(sx + dx, sy + dy, { steps: 20 });
    await page.waitForTimeout(150);
    await page.mouse.up();
    await page.waitForTimeout(400);
  }
};

/**
 * Zoom button presses until the map is at the zoom (at most a step over it). The first fit can land
 * closer than the target (a truck that has posted a position near the CC pulls the fit in), and a map
 * zoomed in too far leaves the far parcels' outlines unrendered, so `centreOn` could not measure them.
 */
export const zoomButtonTo = async (page: Page, target: number): Promise<void> => {
  for (let i = 0; i < 8 && (await zoomOf(page)) >= target + 1; i++) {
    await page.locator(".leaflet-control-zoom-out").first().click();
    await page.waitForTimeout(450);
  }
  for (let i = 0; i < 8 && (await zoomOf(page)) < target; i++) {
    await page.locator(".leaflet-control-zoom-in").first().click();
    await page.waitForTimeout(450);
  }
};

export interface Pt {
  x: number;
  y: number;
  pid: string;
}

/**
 * Three bare parcels in a row near the map centre, each a tap target, with a clean straight path
 * between them that crosses no other parcel and no lot. `root` scopes to one map (the Flag strip).
 */
export const pickTriple = (page: Page, root = "", allow: readonly string[] | null = null): Promise<[Pt, Pt, Pt] | null> =>
  page.evaluate(([r, ids]) => {
    const okIds = ids ? new Set(ids) : null;
    const scope = r ? document.querySelector(r)! : document;
    const map = scope.querySelector(".leaflet-container")!.getBoundingClientRect();
    const bar = document.querySelector("[data-paint-bar]");
    const bottom = bar ? bar.getBoundingClientRect().top - 10 : map.bottom - 10;
    const legend = document.querySelector("[data-legend]");
    const lr = legend ? legend.getBoundingClientRect() : null;
    const pts: Array<{ x: number; y: number; pid: string }> = [];
    for (const el of scope.querySelectorAll("[data-parcel]")) {
      const b = el.getBoundingClientRect();
      const x = b.left + b.width / 2;
      const y = b.top + b.height / 2;
      if (x < map.left + 50 || x > map.right - 50 || y < map.top + 50 || y > bottom) continue;
      if (lr && x > lr.left - 10 && y < lr.bottom + 10) continue;
      if (document.elementFromPoint(x, y) !== el) continue;
      if (okIds && !okIds.has(el.getAttribute("data-parcel")!)) continue;
      pts.push({ x, y, pid: el.getAttribute("data-parcel")! });
    }
    const cx = map.left + map.width / 2;
    const cy = (map.top + bottom) / 2;
    pts.sort((a, b) => Math.hypot(a.x - cx, a.y - cy) - Math.hypot(b.x - cx, b.y - cy));
    const clean = (path: typeof pts, ok: Set<string>): boolean => {
      for (let i = 0; i + 1 < path.length; i++) {
        const a = path[i]!;
        const b = path[i + 1]!;
        const n = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 2);
        for (let k = 0; k <= n; k++) {
          const e = document.elementFromPoint(a.x + ((b.x - a.x) * k) / n, a.y + ((b.y - a.y) * k) / n);
          if (!e) return false;
          if (e.hasAttribute("data-lot-id") || e.hasAttribute("data-lot-parcel")) return false;
          if (e.hasAttribute("data-parcel") && !ok.has(e.getAttribute("data-parcel")!)) return false;
        }
      }
      return true;
    };
    for (const p of pts.slice(0, 40)) {
      const near = pts
        .filter((q) => q !== p)
        .map((q) => ({ q, d: Math.hypot(q.x - p.x, q.y - p.y) }))
        .sort((a, b) => a.d - b.d);
      for (const { q, d } of near.slice(0, 4)) {
        if (d > 90) break;
        const tx = q.x + (q.x - p.x);
        const ty = q.y + (q.y - p.y);
        const third = pts.find((o) => o !== p && o !== q && Math.hypot(o.x - tx, o.y - ty) < d * 0.35);
        if (!third) continue;
        if (clean([p, q, third], new Set([p.pid, q.pid, third.pid]))) return [p, q, third] as [typeof p, typeof p, typeof p];
      }
    }
    return null;
  }, [root, allow as string[] | null] as const);

/** Mouse drag through the points, the way a finger paints a stroke. */
export const drag = async (page: Page, pts: readonly { x: number; y: number }[]): Promise<void> => {
  await page.mouse.move(pts[0]!.x, pts[0]!.y);
  await page.mouse.down();
  for (const p of pts.slice(1)) await page.mouse.move(p.x, p.y, { steps: 8 });
  await page.mouse.up();
};

export const expectRedTodo = async (page: Page, parcelIds: readonly string[]): Promise<void> => {
  await expect
    .poll(async () => {
      const fills = await Promise.all(parcelIds.map((pid) => lotFill(page, pid)));
      return fills.every((f) => f !== null && f.cls.includes("lrb-lot-shape-open") && f.fill === RED);
    }, { message: `parcels ${parcelIds.join(", ")} drawn red Todo` })
    .toBe(true);
};

// #region the lane's own parcels at CC Webb
interface Area {
  label: string;
  ring: Array<[number, number]>;
}
interface Bare {
  parcelId: string;
  lat: number;
  lng: number;
}

/** About 25 m in degrees at Detroit's latitude. */
const MARGIN_LAT = 0.000225;
const MARGIN_LNG = 0.0003;

const box = (a: Area): [number, number, number, number] => {
  const xs = a.ring.map((p) => p[0]);
  const ys = a.ring.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
};

/**
 * Bare parcels inside the lane's rectangles and at least 25 m from every other rectangle. The
 * two lanes paint, draw and flag at CC Webb at the same time, each in its own rectangles, and
 * nothing else in the suite reads those crews.
 */
export const laneParcels = (bare: readonly Bare[], areas: readonly Area[], labels: readonly string[]): string[] => {
  const mine = areas.filter((a) => labels.includes(a.label)).map(box);
  const others = areas.filter((a) => !labels.includes(a.label)).map(box);
  return bare
    .filter((p) => mine.some((b) => p.lng > b[0] && p.lng < b[2] && p.lat > b[1] && p.lat < b[3]))
    .filter((p) => !others.some((b) => p.lng > b[0] - MARGIN_LNG && p.lng < b[2] + MARGIN_LNG && p.lat > b[1] - MARGIN_LAT && p.lat < b[3] + MARGIN_LAT))
    .map((p) => p.parcelId);
};
// #endregion
