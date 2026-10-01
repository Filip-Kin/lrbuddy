import { describe, expect, test } from "bun:test";
import { labelLevel, largestAreaIds, ringAreaM2, showCrewName, showPill } from "./declutter.ts";

const box = (id: number, side: number) => {
  // `side` metres square near Detroit, as a closed [lng, lat] ring.
  const dLat = side / 111320;
  const dLng = side / (111320 * Math.cos((42.38 * Math.PI) / 180));
  return { id, ring: [[-83.1, 42.38], [-83.1 + dLng, 42.38], [-83.1 + dLng, 42.38 + dLat], [-83.1, 42.38 + dLat], [-83.1, 42.38]] };
};

describe("label declutter (SPEC 20)", () => {
  test("zoom thresholds", () => {
    expect(labelLevel(18)).toBe("all");
    expect(labelLevel(16)).toBe("all");
    expect(labelLevel(15.5)).toBe("big");
    expect(labelLevel(14)).toBe("big");
    expect(labelLevel(13.5)).toBe("none");
    expect(labelLevel(11)).toBe("none");
  });

  test("pills: every one from 16, the largest from 14, none below", () => {
    expect(showPill("all", false)).toBe(true);
    expect(showPill("big", true)).toBe(true);
    expect(showPill("big", false)).toBe(false);
    expect(showPill("none", true)).toBe(false);
  });

  test("crew names only from 16", () => {
    expect(showCrewName("all")).toBe(true);
    expect(showCrewName("big")).toBe(false);
    expect(showCrewName("none")).toBe(false);
  });

  test("the six largest areas by size, ties to the lower id", () => {
    expect(Math.round(ringAreaM2(box(1, 100).ring) / 100)).toBe(100);
    const areas = [box(1, 50), box(2, 200), box(3, 120), box(4, 120), box(5, 300), box(6, 80), box(7, 90), box(8, 10)];
    expect([...largestAreaIds(areas)].sort((a, b) => a - b)).toEqual([2, 3, 4, 5, 6, 7]);
    expect([...largestAreaIds(areas, 1)]).toEqual([5]);
  });
});
