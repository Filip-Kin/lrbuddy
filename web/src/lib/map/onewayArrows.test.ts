import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ARROW_SPACING_M, arrowsAlong, bearingOf, segmentM } from "./onewayArrows.ts";

interface FixtureWay {
  type: string;
  id: number;
  tags?: Record<string, string>;
  geometry?: Array<{ lat: number; lon: number }>;
}
const fx = JSON.parse(readFileSync(join(import.meta.dir, "../../../../server/fixtures/overpass-oneway.json"), "utf8")) as { elements: FixtureWay[] };
const way = (id: number): Array<[number, number]> => fx.elements.find((e) => e.id === id)!.geometry!.map((g) => [g.lat, g.lon]);
/** Webb St, Detroit: a real one-way way, drawn west-south-west to east-north-east. */
const webb = way(8745637);
const lengthOf = (pts: ReadonlyArray<readonly [number, number]>): number => pts.slice(1).reduce((n, p, i) => n + segmentM(pts[i]!, p), 0);
const angleGap = (a: number, b: number): number => Math.abs(((a - b + 540) % 360) - 180);

describe("one-way arrows", () => {
  test("one arrow every 60 m, centred on the way", () => {
    const total = lengthOf(webb);
    const arrows = arrowsAlong(webb, 1);
    expect(arrows.length).toBe(Math.floor(total / ARROW_SPACING_M));
    for (let i = 1; i < arrows.length; i++) {
      const gap = segmentM([arrows[i - 1]!.lat, arrows[i - 1]!.lng], [arrows[i]!.lat, arrows[i]!.lng]);
      // Straight-line gap: at most the 60 m along the way, a little less across a bend.
      expect(gap).toBeLessThanOrEqual(ARROW_SPACING_M + 0.01);
      expect(gap).toBeGreaterThan(ARROW_SPACING_M * 0.9);
    }
    const startGap = segmentM(webb[0]!, [arrows[0]!.lat, arrows[0]!.lng]);
    const endGap = segmentM(webb[webb.length - 1]!, [arrows.at(-1)!.lat, arrows.at(-1)!.lng]);
    expect(Math.abs(startGap - endGap)).toBeLessThan(5);
  });

  test("oneway=yes points along the drawing, oneway=-1 against it", () => {
    const wayBearing = bearingOf(webb[0]!, webb[webb.length - 1]!);
    expect(wayBearing).toBeGreaterThan(45);
    expect(wayBearing).toBeLessThan(75);
    for (const a of arrowsAlong(webb, 1)) expect(angleGap(a.bearing, wayBearing)).toBeLessThan(25);
    for (const a of arrowsAlong(webb, -1)) expect(angleGap(a.bearing, (wayBearing + 180) % 360)).toBeLessThan(25);
  });

  test("the same places either way round", () => {
    const fwd = arrowsAlong(webb, 1).map((a) => `${a.lat.toFixed(5)},${a.lng.toFixed(5)}`).sort();
    const back = arrowsAlong(webb, -1).map((a) => `${a.lat.toFixed(5)},${a.lng.toFixed(5)}`).sort();
    expect(back).toEqual(fwd);
  });

  test("a short way gets one arrow at its middle; a point gets none", () => {
    const a: [number, number] = [42.38, -83.12];
    const b: [number, number] = [42.38 + 30 / 111320, -83.12];
    const one = arrowsAlong([a, b], 1);
    expect(one).toHaveLength(1);
    expect(segmentM(a, [one[0]!.lat, one[0]!.lng])).toBeCloseTo(15, 0);
    expect(one[0]!.bearing).toBeCloseTo(0, 3);
    expect(arrowsAlong([a, b], -1)[0]!.bearing).toBeCloseTo(180, 3);
    expect(arrowsAlong([a, a], 1)).toEqual([]);
  });

  test("bearings: east is 90, west is 270", () => {
    expect(bearingOf([42.38, -83.12], [42.38, -83.11])).toBeCloseTo(90, 3);
    expect(bearingOf([42.38, -83.11], [42.38, -83.12])).toBeCloseTo(270, 3);
  });
});
