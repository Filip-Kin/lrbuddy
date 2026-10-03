import { describe, expect, test } from "bun:test";
import { compassPoint, pickAlley, pickByRay, pickFlag, pickNearest, pickParcel, type Candidate } from "./pick.ts";

// A street running east-west at lat 42.38; parcels north of it, 10 m wide, 30 m deep.
const AT = { lat: 42.38, lng: -83.1 };
const M_LAT = 111_320;
const kx = M_LAT * Math.cos((42.38 * Math.PI) / 180);
/** A parcel whose south-west corner is x metres east and y metres north of AT. */
const parcel = (key: string, x: number, y: number, w = 10, d = 30): Candidate => {
  const lng = (m: number) => AT.lng + m / kx;
  const lat = (m: number) => AT.lat + m / M_LAT;
  return {
    key,
    lat: lat(y + d / 2),
    lng: lng(x + w / 2),
    geometry: { type: "Polygon", coordinates: [[[lng(x), lat(y)], [lng(x + w), lat(y)], [lng(x + w), lat(y + d)], [lng(x), lat(y + d)], [lng(x), lat(y)]]] },
  };
};

const row = [parcel("a", -15, 8), parcel("b", -5, 8), parcel("c", 5, 8), parcel("far", -5, 60)];

describe("flag pick (SPEC 22)", () => {
  test("facing north picks the parcel straight ahead", () => {
    expect(pickByRay(AT, 0, row)?.key).toBe("b");
  });

  test("turning picks the parcel the ray enters first", () => {
    // 45 degrees east of north: the ray crosses x = 5 at y = 5, then enters c at y = 8.
    expect(pickByRay(AT, 45, row)?.key).toBe("c");
    expect(pickByRay(AT, -40, row)?.key).toBe("a");
  });

  test("nothing within 30 m ahead: no hit; facing away: no hit", () => {
    expect(pickByRay(AT, 180, row)).toBeNull();
    expect(pickByRay(AT, 0, [parcel("far", -5, 40)])).toBeNull();
  });

  test("a parcel closer than 4 m is skipped (the one the phone stands on)", () => {
    const under = parcel("under", -5, -1, 10, 4);
    expect(pickByRay(AT, 0, [under, ...row])?.key).toBe("b");
  });

  test("no heading: the parcel under the fix, else the nearest centre within 25 m", () => {
    const under = parcel("under", -5, -5, 10, 10);
    expect(pickNearest(AT, [under, ...row])?.key).toBe("under");
    expect(pickNearest(AT, row)?.key).toBe("b");
    expect(pickNearest(AT, [parcel("far", -5, 60)])).toBeNull();
  });

  test("pickParcel falls back to the nearest when the ray hits nothing, and needs a fix", () => {
    expect(pickParcel(AT, 180, row)?.key).toBe("b");
    expect(pickParcel(AT, null, row)?.key).toBe("b");
    expect(pickParcel(null, 0, row)).toBeNull();
  });

  test("compass points", () => {
    expect(compassPoint(0)).toBe("N");
    expect(compassPoint(44)).toBe("NE");
    expect(compassPoint(200)).toBe("S");
    expect(compassPoint(-30)).toBe("NW");
    expect(compassPoint(359)).toBe("N");
  });
});

describe("drawn lots", () => {
  test("a drawn lot wins over the parcel it lies across, by ray and under the fix", () => {
    const big = parcel("p:1", -15, -5, 30, 40);
    const drawn = { ...parcel("l:9", -3, -3, 6, 30), drawn: true };
    expect(pickNearest(AT, [big, drawn])?.key).toBe("l:9");
    expect(pickByRay(AT, 0, [big, drawn])?.key).toBe("l:9");
    expect(pickByRay(AT, 0, [big])?.key).toBe("p:1");
  });
});

describe("alleys (SPEC 22, alleys)", () => {
  // An east-west alley 20 m north of AT, from x = 10 to x = 210 m, in two halves of 100 m.
  const pt = (x: number, y: number): [number, number] => [AT.lat + y / M_LAT, AT.lng + x / kx];
  const west = { key: "a:1:0:0", line: [pt(10, 20), pt(110, 20)] };
  const east = { key: "a:1:0:1", line: [pt(110, 20), pt(210, 20)] };
  const halves = [west, east];
  // Parcels north of the street, the alley running across their backs.
  const backs = [parcel("p1", 0, 8, 12, 10), parcel("p2", 12, 8, 12, 10), parcel("p3", 0, 22, 12, 10)];
  const at = (x: number, y: number) => ({ lat: AT.lat + y / M_LAT, lng: AT.lng + x / kx });

  test("at the mouth, pointing down the alley, picks the half it points into", () => {
    expect(pickAlley(at(4, 20), 90, halves)?.key).toBe("a:1:0:0");
    // From the far end, looking back west: the east half.
    expect(pickAlley(at(216, 20), 270, halves)?.key).toBe("a:1:0:1");
  });

  test("within 25 degrees either side of the alley's direction; not beyond", () => {
    expect(pickAlley(at(4, 20), 90 + 24, halves)?.key).toBe("a:1:0:0");
    expect(pickAlley(at(4, 20), 90 - 24, halves)?.key).toBe("a:1:0:0");
    expect(pickAlley(at(4, 20), 90 + 30, halves)).toBeNull();
    expect(pickAlley(at(4, 20), 0, halves)).toBeNull();
  });

  test("within 15 m of the centreline or its end, or an end up to 30 m straight ahead; not beyond", () => {
    expect(pickAlley(at(50, 34), 90, halves)?.key).toBe("a:1:0:0");
    expect(pickAlley(at(50, 37), 90, halves)).toBeNull();
    expect(pickAlley(at(-4, 20), 90, halves)?.key).toBe("a:1:0:0");
    // The end straight ahead reaches 30 m (across a cross street), not further, and not off to the side.
    expect(pickAlley(at(-8, 20), 90, halves)?.key).toBe("a:1:0:0");
    expect(pickAlley(at(-25, 20), 90, halves)).toBeNull();
    expect(pickAlley(at(-8, 0), 90, halves)).toBeNull();
  });

  test("pointing away from the alley at its mouth picks nothing", () => {
    expect(pickAlley(at(4, 20), 270, halves)).toBeNull();
  });

  test("inside a half, the half the phone stands in; at the middle, the half ahead", () => {
    expect(pickAlley(at(90, 20), 90, halves)?.key).toBe("a:1:0:0");
    expect(pickAlley(at(90, 20), 270, halves)?.key).toBe("a:1:0:0");
    // Under 10 m from the end of its half, facing out of it: the half ahead.
    expect(pickAlley(at(105, 20), 90, halves)?.key).toBe("a:1:0:1");
    expect(pickAlley(at(110, 20), 90, halves)?.key).toBe("a:1:0:1");
    expect(pickAlley(at(110, 20), 270, halves)?.key).toBe("a:1:0:0");
  });

  test("at a cross street, GPS a few metres inside the alley behind: the alley ahead, never the one behind", () => {
    // Filip, 2026-10-03, 14th St: the block to the west across the street runs x -210 to -10.
    const wWest = { key: "a:2:0:0", line: [pt(-210, 20), pt(-110, 20)] };
    const wEast = { key: "a:2:0:1", line: [pt(-110, 20), pt(-10, 20)] };
    const all = [wWest, wEast, west, east];
    expect(pickAlley(at(13, 20), 270, all)?.key).toBe("a:2:0:1");
    expect(pickAlley(at(-13, 20), 90, all)?.key).toBe("a:1:0:0");
  });

  test("pickFlag: the alley when pointing along it, the parcel when pointing across it, the parcel with no heading", () => {
    expect(pickFlag(at(4, 20), 90, halves, backs)?.key).toBe("a:1:0:0");
    // Standing in the alley facing south: the parcel behind the house row.
    expect(pickFlag(at(6, 20), 180, halves, backs)?.key).toBe("p1");
    // Facing north across it: the parcel on the other side.
    expect(pickFlag(at(6, 18), 0, halves, backs)?.key).toBe("p3");
    expect(pickFlag(at(4, 20), null, halves, backs)?.key).not.toBe("a:1:0:0");
    expect(pickFlag(null, 90, halves, backs)).toBeNull();
  });
});
