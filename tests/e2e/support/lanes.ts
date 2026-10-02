/**
 * The phone and laptop projects run every spec at the same time against one server, so each
 * works in its own part of the seed. A spec file takes its crews by index, and two files of the
 * same lane never use the same crew, so files can run in parallel too.
 *
 *   crews[0] crew.e2e        crews[3] live.e2e
 *   crews[1] driver.e2e      crews[4] auth.e2e
 *   crews[2] green.e2e
 *
 * The driver and live specs deliver whole stops, so crews[1] and crews[3] are crews the seed gave
 * no open, assigned or en route request (delivering would close the seed's request too).
 *
 * The green map tests that make and delete lots (green-map.e2e) run at Day 4's CC Webb (DURFB1),
 * which no other spec reads, each lane inside its own rectangles of the middle column. The admin
 * Land Bank import draws its rectangle over another rectangle of the east column.
 */
export type LaneId = "a" | "b";

export interface Lane {
  id: LaneId;
  /** CC name as the screens show it, without "CC ". */
  cc: string;
  green: string;
  truck: string;
  truckName: string;
  crews: ReadonlyArray<{ token: string; name: string }>;
  /** A day of Demo 2026 with nothing on it, for the admin set-up test. */
  freeDay: number;
  /** Phone numbers for the access test users. */
  phone: string;
  /** CC Webb rectangles (by label) the lane's green map tests work in. */
  webbAreas: readonly string[];
  /** CC Webb rectangle the lane's admin Land Bank import is drawn over. */
  importArea: string;
}

const crew = (n: number, name: string): { token: string; name: string } => ({ token: `demo-crew-${String(n).padStart(2, "0")}`, name });

export const LANES: Record<LaneId, Lane> = {
  a: {
    id: "a",
    cc: "East",
    green: "EAST01",
    truck: "TRUCK1",
    truckName: "Truck 1",
    crews: [crew(1, "FORD 1"), crew(2, "ROCKET 1"), crew(3, "DTE 1"), crew(6, "FORD 2"), crew(5, "GM 1"), crew(4, "HFH 1")],
    freeDay: 2,
    phone: "+1313555071",
    webbAreas: ["GM 3", "GM 5"],
    importArea: "GM 1",
  },
  b: {
    id: "b",
    cc: "West",
    green: "WEST01",
    truck: "TRUCK3",
    truckName: "Truck 3",
    crews: [crew(7, "ROCKET 2"), crew(9, "HFH 2"), crew(8, "DTE 2"), crew(11, "FORD 3"), crew(12, "ROCKET 3"), crew(10, "GM 2")],
    freeDay: 6,
    phone: "+1313555072",
    webbAreas: ["GM 7", "GM 12 & GM 13"],
    importArea: "GM 14",
  },
};
