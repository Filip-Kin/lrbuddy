import { describe, expect, test } from "bun:test";
import { cameraBearing, circularMean } from "./bearing.ts";

/** Angular distance in degrees. */
const off = (a: number | null, b: number): number => {
  if (a === null) return Infinity;
  const d = Math.abs((((a - b) % 360) + 360) % 360);
  return Math.min(d, 360 - d);
};

// Hand-computed: the camera looks along the device's -z axis. With R = Rz(a) Rx(b) Ry(g),
// R (0, 0, -1) = (east, north) = (-cos a sin g - sin a sin b cos g, -sin a sin g + cos a sin b cos g).
describe("camera bearing (SPEC 22)", () => {
  test("upright portrait (beta 90) facing N, E, S, W", () => {
    // a = 0: (0, 1) north. a = 270: (-(-1)(1)(1), 0) = (1, 0) east. a = 180: (0, -1) south. a = 90: (-1, 0) west.
    expect(off(cameraBearing(0, 90, 0), 0)).toBeLessThan(1e-6);
    expect(off(cameraBearing(270, 90, 0), 90)).toBeLessThan(1e-6);
    expect(off(cameraBearing(180, 90, 0), 180)).toBeLessThan(1e-6);
    expect(off(cameraBearing(90, 90, 0), 270)).toBeLessThan(1e-6);
  });

  test("tilted back or forward keeps the bearing", () => {
    // b = 60: (0, sin 60) still north; b = 120 (screen tipped toward the sky past upright): (0, sin 120) north.
    expect(off(cameraBearing(0, 60, 0), 0)).toBeLessThan(1e-6);
    expect(off(cameraBearing(0, 120, 0), 0)).toBeLessThan(1e-6);
    expect(off(cameraBearing(270, 45, 0), 90)).toBeLessThan(1e-6);
  });

  test("upright and turned about the long axis: gamma moves the camera, alpha alone would not", () => {
    // a = 0, b = 90, g = 30: (-sin 30, cos 30) = (-0.5, 0.866), bearing -30 = 330.
    expect(off(cameraBearing(0, 90, 30), 330)).toBeLessThan(1e-6);
    expect(off(cameraBearing(0, 90, -30), 30)).toBeLessThan(1e-6);
  });

  test("landscape: screen turned left (angle 90) and right (angle 270)", () => {
    // Left: b = 0, g = -90: R(0,0,-1) = (cos a, sin a). Facing N needs a = 90; naive 360 - a says W.
    expect(off(cameraBearing(90, 0, -90, 90), 0)).toBeLessThan(1e-6);
    expect(off(cameraBearing(0, 0, -90, 90), 90)).toBeLessThan(1e-6);
    // Right: g = 90: R(0,0,-1) = (-cos a, -sin a). Facing N needs a = 270; facing S, a = 90.
    expect(off(cameraBearing(270, 0, 90, 270), 0)).toBeLessThan(1e-6);
    expect(off(cameraBearing(90, 0, 90, 270), 180)).toBeLessThan(1e-6);
  });

  test("flat: the camera looks down, so the top of the screen is ahead", () => {
    // Portrait: up is the device +y, R (0,1,0) = (-sin a, cos a): a = 30 gives 330.
    expect(off(cameraBearing(30, 0, 0, 0), 330)).toBeLessThan(1e-6);
    expect(off(cameraBearing(0, 0, 0, 0), 0)).toBeLessThan(1e-6);
    // Landscape left: up is the device +x, R (1,0,0) = (cos a, sin a): a = 0 gives east.
    expect(off(cameraBearing(0, 0, 0, 90), 90)).toBeLessThan(1e-6);
    // Landscape right: up is the device -x: a = 0 gives west.
    expect(off(cameraBearing(0, 0, 0, 270), 270)).toBeLessThan(1e-6);
    // Ten degrees off flat is still flat.
    expect(off(cameraBearing(0, 10, 0, 0), 0)).toBeLessThan(1e-6);
  });

  test("a missing angle gives no bearing", () => {
    expect(cameraBearing(null, 90, 0)).toBeNull();
    expect(cameraBearing(0, Number.NaN, 0)).toBeNull();
  });

  test("circular mean wraps through north", () => {
    expect(off(circularMean([358, 2]), 0)).toBeLessThan(1e-6);
    expect(off(circularMean([80, 90, 100]), 90)).toBeLessThan(1e-6);
    expect(circularMean([])).toBeNull();
  });
});
