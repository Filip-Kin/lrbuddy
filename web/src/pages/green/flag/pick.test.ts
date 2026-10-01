import { describe, expect, test } from "bun:test";
import { compassPoint, pickByRay, pickNearest, pickParcel, type Candidate } from "./pick.ts";

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
