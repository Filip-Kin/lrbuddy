import { describe, expect, test } from "bun:test";
import { alleyOutline, halfMiddle, parseHalfKey, splitAlley, streetWord, type SplitParcel } from "./alley-halves.ts";

// An east-west alley at lat 42.38 from x = 0 to x = 600 m, between Calvert (north) and Glynn (south),
// crossing Linwood at x = 200 and La Salle at x = 400.
const LAT = 42.38;
const LNG = -83.11;
const M_LAT = 111_320;
const kx = M_LAT * Math.cos((LAT * Math.PI) / 180);
const at = (x: number, y = 0): [number, number] => [LAT + y / M_LAT, LNG + x / kx];
const line = [at(0), at(300), at(600)];

const P = (x: number, y: number, street: string, c1: string | null, c2: string | null): SplitParcel => {
  const [lat, lng] = at(x, y);
  return { lat, lng, streetName: street, crossStreet1: c1, crossStreet2: c2 };
};

/** A block of houses on both sides between x0 and x1 (12 m lots), backing onto the alley. */
const block = (x0: number, x1: number, c1: string, c2: string): SplitParcel[] => {
  const out: SplitParcel[] = [];
  for (let x = x0 + 6; x < x1; x += 12) out.push(P(x, 20, "CALVERT", c1, c2), P(x, -20, "GLYNN", c1, c2));
  return out;
};

const parcels = [
  ...block(10, 190, "14th St", "Linwood St"),
  ...block(210, 390, "Linwood St", "La Salle Blvd"),
  ...block(410, 590, "La Salle Blvd", "Rosa Parks Blvd"),
];

describe("alley halves (SPEC 22, alleys)", () => {
  test("cut at each cross street, then each block at its middle", () => {
    const halves = splitAlley(77, line, parcels);
    expect(halves.map((h) => h.key)).toEqual(["77:0:0", "77:0:1", "77:1:0", "77:1:1", "77:2:0", "77:2:1"]);
    // Cuts halfway between the last lot of one block and the first of the next: 200 and 400 m.
    const len = halves.map((h) => Math.round(h.lengthM));
    expect(len).toEqual([100, 100, 100, 100, 100, 100]);
    expect(halves.map((h) => h.side)).toEqual(["west", "east", "west", "east", "west", "east"]);
    // A half follows the way through its bend: the middle block's halves meet at the 300 m vertex.
    expect(halves[2]!.line.at(-1)![1]).toBeCloseTo(at(300)[1], 6);
  });

  test("no parcels, or none naming both cross streets: one block, two halves", () => {
    expect(splitAlley(5, line, []).map((h) => h.key)).toEqual(["5:0:0", "5:0:1"]);
    const blank = parcels.map((p) => ({ ...p, crossStreet2: null }));
    expect(splitAlley(5, line, blank).map((h) => Math.round(h.lengthM))).toEqual([300, 300]);
  });

  test("corner lots facing the cross street do not make a block", () => {
    // Linwood corner lots name Calvert and Glynn as their cross streets.
    const corners = [P(196, 15, "LINWOOD", "Calvert St", "Glynn St"), P(204, 15, "LINWOOD", "Calvert St", "Glynn St"), P(196, -15, "LINWOOD", "Calvert St", "Glynn St"), P(204, -15, "LINWOOD", "Glynn St", "Calvert St")];
    expect(splitAlley(9, line, [...parcels, ...corners]).map((h) => Math.round(h.lengthM))).toEqual([100, 100, 100, 100, 100, 100]);
  });

  test("the same block under two spellings is one block; far or past-the-end parcels are ignored", () => {
    const spelled = block(210, 390, "LINWOOD", "LA SALLE").map((p, i) => (i % 2 ? p : { ...p, crossStreet1: "Linwood", crossStreet2: "La Salle Blvd" }));
    const far = block(0, 600, "Somewhere St", "Else St").map((p) => ({ ...p, lat: p.lat + 60 / M_LAT }));
    const past = [P(-30, 5, "CALVERT", "A St", "B St"), P(-40, 5, "CALVERT", "A St", "B St")];
    const halves = splitAlley(3, line, [...block(10, 190, "14th St", "Linwood St"), ...spelled, ...far, ...past]);
    expect(halves.map((h) => Math.round(h.lengthM))).toEqual([100, 100, 200, 200]);
  });

  test("a stub under 10 m gets no halves", () => {
    expect(splitAlley(1, [at(0), at(8)], [])).toEqual([]);
  });

  test("north-south alley: north and south halves", () => {
    const ns = splitAlley(2, [at(0, 0), at(0, 120)], []);
    expect(ns.map((h) => h.side)).toEqual(["south", "north"]);
  });

  test("keys parse back; other strings do not", () => {
    expect(parseHalfKey("558673969:2:1")).toEqual({ osmId: 558673969, block: 2, half: 1 });
    expect(parseHalfKey("1:2:3")).toBeNull();
    expect(parseHalfKey("p:1")).toBeNull();
  });

  test("street words drop the suffix", () => {
    expect(streetWord("Linwood St")).toBe("LINWOOD");
    expect(streetWord("La Salle Blvd")).toBe("LA SALLE");
    expect(streetWord("14th St.")).toBe("14TH");
    expect(streetWord(null)).toBe("");
  });

  test("outline: 4 m wide round the centreline, closed, with the half's middle inside", () => {
    const half = splitAlley(77, line, parcels)[2]!;
    const g = alleyOutline(half.line);
    if (g.type !== "Polygon") throw new Error("polygon expected");
    const ring = g.coordinates[0]!;
    expect(ring[0]).toEqual(ring.at(-1)!);
    const ys = ring.map((p) => ((p[1] ?? 0) - LAT) * M_LAT);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(4, 3);
    const xs = ring.map((p) => ((p[0] ?? 0) - LNG) * kx);
    expect(Math.min(...xs)).toBeCloseTo(200, 3);
    expect(Math.max(...xs)).toBeCloseTo(300, 3);
    const [mLat, mLng] = halfMiddle(half.line);
    expect((mLng - LNG) * kx).toBeCloseTo(250, 3);
    expect(mLat).toBeCloseTo(LAT, 9);
  });

  test("outline round a right-angle bend keeps its width", () => {
    const g = alleyOutline([at(0, 0), at(50, 0), at(50, 50)]);
    if (g.type !== "Polygon") throw new Error("polygon expected");
    const xy = g.coordinates[0]!.map((p) => [((p[0] ?? 0) - LNG) * kx, ((p[1] ?? 0) - LAT) * M_LAT] as const);
    // The outer corner sits at (52, -2), the inner at (48, 2).
    expect(xy.some(([x, y]) => Math.abs(x - 52) < 0.01 && Math.abs(y + 2) < 0.01)).toBe(true);
    expect(xy.some(([x, y]) => Math.abs(x - 48) < 0.01 && Math.abs(y - 2) < 0.01)).toBe(true);
  });
});
