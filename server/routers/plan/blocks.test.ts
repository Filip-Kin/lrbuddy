import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// blocks.ts reaches the db module, which opens $DATA_DIR at import.
const dir = mkdtempSync(join(tmpdir(), "lrbuddy-blocks-test-"));
process.env.DATA_DIR = dir;
process.env.SESSION_SECRET = "test-secret";
process.env.OSRM_URL = "off";

const { convexHull } = await import("./blocks.ts");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("convexHull", () => {
  test("drops inner points and closes the ring", () => {
    const ring = convexHull([
      [0, 0],
      [2, 0],
      [1, 1],
      [2, 2],
      [0, 2],
      [0, 0],
    ]);
    expect(ring[0]).toEqual(ring[ring.length - 1]!);
    expect(ring.length).toBe(5);
    expect(ring.some((p) => p[0] === 1 && p[1] === 1)).toBe(false);
  });

  test("collinear points keep the two ends", () => {
    const ring = convexHull([
      [0, 0],
      [1, 1],
      [2, 2],
    ]);
    expect(ring).toEqual([
      [0, 0],
      [2, 2],
      [0, 0],
    ]);
  });

  test("no points, no ring", () => {
    expect(convexHull([])).toEqual([]);
  });
});
