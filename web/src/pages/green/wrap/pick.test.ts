import { describe, expect, test } from "bun:test";
import type { Candidate } from "../flag/pick.ts";
import { nearest, pickWrap, spotDistance } from "./pick.ts";

// A street running east-west at lat 42.38; lots north of it, 10 m wide, 30 m deep.
const AT = { lat: 42.38, lng: -83.1 };
const M_LAT = 111_320;
const kx = M_LAT * Math.cos((42.38 * Math.PI) / 180);
type Lot = Candidate & { id: number; needs: boolean };
const lot = (id: number, x: number, y: number, needs: boolean, w = 10, d = 30): Lot => {
  const lng = (m: number) => AT.lng + m / kx;
  const lat = (m: number) => AT.lat + m / M_LAT;
  return {
    id,
    needs,
    key: `l:${id}`,
    lat: lat(y + d / 2),
    lng: lng(x + w / 2),
    geometry: { type: "Polygon", coordinates: [[[lng(x), lat(y)], [lng(x + w), lat(y)], [lng(x + w), lat(y + d)], [lng(x), lat(y + d)], [lng(x), lat(y)]]] },
  };
};
const needs = (l: Lot): boolean => l.needs;

describe("wrap pick (SPEC 28)", () => {
  test("the ray picks the work lot the camera faces, Needs After or not", () => {
    const row = [lot(1, -15, 8, true), lot(2, -5, 8, false), lot(3, 5, 8, true)];
    expect(pickWrap(AT, 0, row, needs)?.id).toBe(2);
    expect(pickWrap(AT, 45, row, needs)?.id).toBe(3);
  });

  test("no hit or no compass: the nearest Needs After lot within 40 m", () => {
    const row = [lot(1, -5, 8, false), lot(2, 20, 8, true), lot(3, -60, 8, true)];
    expect(pickWrap(AT, 180, row, needs)?.id).toBe(2);
    expect(pickWrap(AT, null, row, needs)?.id).toBe(2);
    expect(pickWrap(AT, null, [lot(3, -60, 8, true)], needs)).toBeNull();
    expect(pickWrap(null, 0, row, needs)).toBeNull();
  });

  test("next after a shot: the nearest at any distance, never the lot just shot", () => {
    const row = [lot(1, -5, 8, true), lot(2, 200, 8, true)];
    expect(nearest(AT, row)?.id).toBe(1);
    expect(nearest(AT, row, Number.POSITIVE_INFINITY, 1)?.id).toBe(2);
    expect(nearest(AT, row.slice(0, 1), Number.POSITIVE_INFINITY, 1)).toBeNull();
  });

  test("the Before spot to the metre up close", () => {
    expect(spotDistance(2.4)).toBe("2 m");
    expect(spotDistance(17.6)).toBe("18 m");
    expect(spotDistance(1250)).toBe("1.3 km");
  });
});
