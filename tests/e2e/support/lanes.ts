/**
 * The phone and laptop projects run every spec at the same time against one server, so each
 * works in its own part of the seed. A spec file takes its crews by index, and two files of the
 * same lane never use the same crew, so files can run in parallel too.
 *
 *   crews[0] crew.e2e        crews[3] live.e2e
 *   crews[1] driver.e2e      crews[4] auth.e2e
 *   crews[2] green.e2e       crews[5] invite.e2e
 *
 * The driver and live specs deliver whole stops, so crews[1] and crews[3] are crews the seed gave
 * no open, assigned or en route request (delivering would close the seed's request too).
 *
 * The green map tests that make and delete lots (green-map.e2e) run at Day 4's CC Webb, which no
 * other spec reads, each lane inside its own rectangles of the middle column. The driver map paint
 * test (switch.e2e) paints in other rectangles of its lane (driverAreas), since the two files run
 * at the same time. The admin Land Bank
 * import draws its rectangle over another rectangle of the east column.
 *
 * The seed generates every code and token (SPEC 11) and writes them to `$DATA_DIR/seed-codes.json`;
 * global-setup.ts passes each server's file in E2E_CODES and E2E_SIGNIN_CODES. A lane names its
 * places by CC and crew or truck name and reads the QR link paths from that file. Sign-in is a fake
 * Firebase sign-in, then a link path (`/g/...`, `/t/...`, `/j/...`), or the seed's admin user
 * (fixtures.ts `as`).
 */
import { readFileSync } from "node:fs";

export type LaneId = "a" | "b";

/** One row of `$DATA_DIR/seed-codes.json` (server/seed.ts). */
export interface SeedCode {
  /** `admin`: the seeded admin user, its Firebase uid in `code`, no link. */
  role: "green" | "driver" | "crew" | "admin";
  day: number;
  cc: string;
  name: string;
  code: string;
  path: string;
  link: string;
}

export interface LaneCrew {
  name: string;
  token: string;
  /** `/j/<token>` */
  link: string;
}

export interface Lane {
  id: LaneId;
  /** CC name as the screens show it, without "CC ". */
  cc: string;
  /** The lane CC's QR link path, `/g/<code>`. */
  green: string;
  /** The lane truck's QR link path, `/t/<code>`. */
  truck: string;
  truckName: string;
  crews: readonly LaneCrew[];
  /** Day 1 truck QR link paths by truck name, both CCs. */
  trucks: Readonly<Record<string, string>>;
  /** Day 1 green QR link paths by "CC <name>", plus Day 4's "CC Webb". */
  greens: Readonly<Record<string, string>>;
  /** Day 4 CC Webb's green link and Truck B1's link. */
  webbGreen: string;
  webbTruck: string;
  /** A day of Demo 2026 with nothing on it, for the admin set-up test. */
  freeDay: number;
  /** Phone numbers for the access test users. */
  phone: string;
  /** CC Webb rectangles (by label) the lane's green map tests work in. */
  webbAreas: readonly string[];
  /** CC Webb rectangles the lane's driver map paint test (switch.e2e) works in, apart from webbAreas so the two files run side by side. */
  driverAreas: readonly string[];
  /** CC Webb rectangle the lane's admin Land Bank import is drawn over. */
  importArea: string;
}

interface LaneShape {
  cc: string;
  truckName: string;
  crews: readonly string[];
  freeDay: number;
  phone: string;
  webbAreas: readonly string[];
  driverAreas: readonly string[];
  importArea: string;
}

const SHAPES: Record<LaneId, LaneShape> = {
  a: {
    cc: "East",
    truckName: "Truck 1",
    crews: ["FORD 1", "ROCKET 1", "DTE 1", "FORD 2", "GM 1", "HFH 1"],
    freeDay: 2,
    phone: "+1313555071",
    webbAreas: ["GM 3", "GM 5"],
    driverAreas: ["GM 2"],
    importArea: "GM 1",
  },
  b: {
    cc: "West",
    truckName: "Truck 3",
    crews: ["ROCKET 2", "HFH 2", "DTE 2", "FORD 3", "ROCKET 3", "GM 2"],
    freeDay: 6,
    phone: "+1313555072",
    webbAreas: ["GM 7", "GM 12 & GM 13"],
    driverAreas: ["GM 4"],
    importArea: "GM 14",
  },
};

const cache = new Map<string, SeedCode[]>();

/** The seed's codes for one server: `E2E_CODES` (main) or `E2E_SIGNIN_CODES` (signin). */
export const seedCodes = (env: "E2E_CODES" | "E2E_SIGNIN_CODES"): SeedCode[] => {
  const file = process.env[env];
  if (!file) throw new Error(`${env} unset: run the suite with \`bun run e2e\``);
  let rows = cache.get(file);
  if (!rows) {
    rows = JSON.parse(readFileSync(file, "utf8")) as SeedCode[];
    cache.set(file, rows);
  }
  return rows;
};

const pick = (codes: readonly SeedCode[], role: SeedCode["role"], day: number, cc: string, name: string): SeedCode => {
  const row = codes.find((c) => c.role === role && c.day === day && c.cc === cc && c.name === name);
  if (!row) throw new Error(`seed-codes.json has no ${role} "${name}" at Day ${day} CC ${cc}`);
  return row;
};

/** Firebase uid of the seed's admin user. */
export const adminUid = (codes: readonly SeedCode[]): string => {
  const row = codes.find((c) => c.role === "admin");
  if (!row) throw new Error("seed-codes.json has no admin row");
  return row.code;
};

export const laneFrom = (id: LaneId, codes: readonly SeedCode[]): Lane => {
  const s = SHAPES[id];
  const day1 = codes.filter((c) => c.day === 1);
  return {
    id,
    cc: s.cc,
    green: pick(codes, "green", 1, s.cc, `CC ${s.cc}`).path,
    truck: pick(codes, "driver", 1, s.cc, s.truckName).path,
    truckName: s.truckName,
    crews: s.crews.map((name) => {
      const row = pick(codes, "crew", 1, s.cc, name);
      return { name, token: row.code, link: row.path };
    }),
    trucks: Object.fromEntries(day1.filter((c) => c.role === "driver").map((c) => [c.name, c.path])),
    greens: Object.fromEntries([...day1, ...codes.filter((c) => c.day === 4)].filter((c) => c.role === "green").map((c) => [c.name, c.path])),
    webbGreen: pick(codes, "green", 4, "Webb", "CC Webb").path,
    webbTruck: pick(codes, "driver", 4, "Webb", "Truck B1").path,
    freeDay: s.freeDay,
    phone: s.phone,
    webbAreas: s.webbAreas,
    driverAreas: s.driverAreas,
    importArea: s.importArea,
  };
};
