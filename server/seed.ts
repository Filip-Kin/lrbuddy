/**
 * Demo event for SPEC 11. Wipes and recreates "Demo 2026" on every run, so it
 * is safe to run again. Prints every code and join link at the end.
 */
import { and, eq, inArray } from "drizzle-orm";
import { config } from "./config.ts";
import { db } from "./db/index.ts";
import {
  broadcasts,
  companies,
  crews,
  days,
  events,
  greenShirts,
  lots,
  positions,
  requests,
  requestTypes,
  stockMoves,
  trucks,
  truckStock,
  type Crew,
  type Lot,
  type RequestStatus,
} from "./db/schema.ts";
import { cancelScheduledRoutes, computeRouteNow } from "./dispatch.ts";
import { haversine, type LatLng } from "./geo.ts";
import { attachOutlines, fetchDlba, upsertLots, type LotInput } from "./lots-import.ts";
import { sweepPhotoFiles } from "./photos.ts";
import { seedLotPhotos, type SeedPhotoTarget } from "./seed-photos.ts";
import { seedPlan } from "./seed-plan.ts";
import { createCc, createCrew, createEvent, createTruck } from "./setup.ts";

const EVENT_NAME = "Demo 2026";
const START = "2026-09-28";
const BBOX: [number, number, number, number] = [-83.03, 42.36, -82.98, 42.39];
const MIN = 60_000;

// #region deterministic randomness
let seed = 20260928;
const rand = (): number => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};
const jitter = (p: LatLng, m: number): LatLng => ({
  lat: p.lat + ((rand() - 0.5) * 2 * m) / 111320,
  lng: p.lng + ((rand() - 0.5) * 2 * m) / 82000,
});
// #endregion

// #region wipe
const wipe = (): void => {
  const old = db.select().from(events).where(eq(events.name, EVENT_NAME)).all();
  for (const ev of old) {
    const dayIds = db.select({ id: days.id }).from(days).where(eq(days.eventId, ev.id)).all().map((d) => d.id);
    if (dayIds.length > 0) {
      const crewIds = db.select({ id: crews.id }).from(crews).where(inArray(crews.dayId, dayIds)).all().map((c) => c.id);
      const truckIds = db.select({ id: trucks.id }).from(trucks).where(inArray(trucks.dayId, dayIds)).all().map((t) => t.id);
      if (crewIds.length) db.delete(positions).where(and(eq(positions.kind, "crew"), inArray(positions.refId, crewIds))).run();
      if (truckIds.length) db.delete(positions).where(and(eq(positions.kind, "truck"), inArray(positions.refId, truckIds))).run();
    }
    db.delete(events).where(eq(events.id, ev.id)).run();
  }
  // Photo rows went with their lots; their files go here.
  sweepPhotoFiles();
};
// #endregion

// #region lots
const syntheticLots = (): LotInput[] => {
  const out: LotInput[] = [];
  const streets = ["Harding", "Lycaste", "Chalmers", "Alter", "Marlborough", "Philip", "Lakepointe", "Beaconsfield", "Wayburn", "Maryland"];
  for (let i = 0; i < 150; i++) {
    const row = Math.floor(i / 15);
    const col = i % 15;
    const base = { lat: 42.362 + row * 0.0026, lng: -83.027 + col * 0.0031 };
    const p = jitter(base, 60);
    out.push({
      parcelId: null,
      address: `${4000 + ((i * 37) % 900)} ${streets[col % streets.length]} St`,
      lat: p.lat,
      lng: p.lng,
    });
  }
  return out;
};

const loadLots = async (eventId: number): Promise<"dlba" | "synthetic"> => {
  try {
    const rows = await fetchDlba(BBOX, { limit: 300, timeoutMs: 20_000 });
    if (rows.length > 0) {
      upsertLots(eventId, rows, "dlba");
      const outlines = await attachOutlines(eventId, { timeoutMs: 20_000 }).catch((err: unknown) => {
        console.warn("[seed] parcel outlines failed:", err instanceof Error ? err.message : String(err));
        return 0;
      });
      console.log(`[seed] ${outlines} of ${rows.length} lots have parcel outlines`);
      return "dlba";
    }
  } catch (err) {
    console.warn("[seed] Land Bank query failed, using synthetic lots:", err instanceof Error ? err.message : String(err));
  }
  upsertLots(eventId, syntheticLots(), "csv");
  return "synthetic";
};
// #endregion

const main = async (): Promise<void> => {
  wipe();
  const now = Date.now();
  const ev = createEvent({ name: EVENT_NAME, year: 2026, startDate: START, dayCount: 6, active: true });
  const day1 = db.select().from(days).where(and(eq(days.eventId, ev.id), eq(days.sort, 1))).get()!;
  const types = db.select().from(requestTypes).where(eq(requestTypes.eventId, ev.id)).all();
  const typeId = (key: string): number => types.find((t) => t.key === key)!.id;

  // #region command centers
  const east = createCc({ dayId: day1.id, name: "East", lat: 42.3786, lng: -82.9911, address: "Anchor Detroit, East Warren Ave", code: "EAST01", letter: "A" });
  const west = createCc({ dayId: day1.id, name: "West", lat: 42.3701, lng: -83.0209, address: "Chandler Park Dr and Conner St", code: "WEST01", letter: "B" });
  const shirts: Array<[number, string, string, string]> = [
    [east.id, "Dana Brooks", "313-555-0101", "Site lead"],
    [east.id, "Marcus Hill", "313-555-0102", "Supplies"],
    [east.id, "Priya Shah", "313-555-0103", "Crews"],
    [west.id, "Tom Nowak", "313-555-0201", "Site lead"],
    [west.id, "Aisha Grant", "313-555-0202", "Supplies"],
    [west.id, "Leo Martin", "313-555-0203", "Crews"],
  ];
  for (const [ccId, name, phone, roleLabel] of shirts) db.insert(greenShirts).values({ ccId, name, phone, roleLabel }).run();
  // #endregion

  // #region companies and crews
  const companyNames: Array<[string, string]> = [
    ["Ford", "FORD"],
    ["Rocket", "ROCKET"],
    ["DTE", "DTE"],
    ["Henry Ford Health", "HFH"],
    ["GM", "GM"],
  ];
  const companyIds = companyNames.map(([name, short]) => db.insert(companies).values({ eventId: ev.id, name, short }).returning().get().id);
  const leads = [
    "Jordan Reed", "Casey Lee", "Morgan Diaz", "Riley Chen", "Taylor Brooks", "Avery Kim",
    "Quinn Patel", "Jamie Fox", "Drew Evans", "Sam Rivera", "Alex Moore", "Robin Clark",
  ];
  const crewRows: Crew[] = [];
  for (let i = 0; i < 12; i++) {
    const ccId = i < 6 ? east.id : west.id;
    crewRows.push(
      createCrew({
        dayId: day1.id,
        ccId,
        companyId: companyIds[i % companyIds.length]!,
        leadName: leads[i]!,
        leadPhone: `313-555-${String(1100 + i).padStart(4, "0")}`,
        headcount: 8 + (i % 5),
        number: i + 1,
        token: `demo-crew-${String(i + 1).padStart(2, "0")}`,
      }),
    );
  }
  // #endregion

  // #region trucks
  const t1 = createTruck({ dayId: day1.id, ccId: east.id, name: "Truck 1", driverName: "Chris Young", driverPhone: "313-555-0301", code: "TRUCK1" });
  const t2 = createTruck({ dayId: day1.id, ccId: east.id, name: "Truck 2", driverName: "Pat Ortiz", driverPhone: "313-555-0302", code: "TRUCK2" });
  const t3 = createTruck({ dayId: day1.id, ccId: west.id, name: "Truck 3", driverName: "Kim Walsh", driverPhone: "313-555-0303", code: "TRUCK3" });
  // #endregion

  // #region lots: CC by nearest, about half to crews in clusters
  const lotSource = await loadLots(ev.id);
  const allLots = db.select().from(lots).where(eq(lots.eventId, ev.id)).all();
  for (const l of allLots) {
    const ccId = haversine(l, east) <= haversine(l, west) ? east.id : west.id;
    db.update(lots).set({ ccId }).where(eq(lots.id, l.id)).run();
    l.ccId = ccId;
  }
  const perCrew = Math.max(3, Math.floor(allLots.length / 2 / crewRows.length));
  const taken = new Set<number>();
  const crewHome = new Map<number, LatLng>();
  for (const crew of crewRows) {
    const pool = allLots.filter((l) => l.ccId === crew.ccId && !taken.has(l.id));
    if (pool.length === 0) continue;
    const cc = crew.ccId === east.id ? east : west;
    // Start each crew at the free lot nearest its CC, then take its neighbours.
    const seedLot = pool.reduce((a, b) => (haversine(a, cc) <= haversine(b, cc) ? a : b));
    const mine: Lot[] = pool.sort((a, b) => haversine(a, seedLot) - haversine(b, seedLot)).slice(0, perCrew);
    mine.forEach((l, k) => {
      taken.add(l.id);
      const status = k < Math.floor(perCrew / 3) ? "done" : k === Math.floor(perCrew / 3) ? "in_progress" : "open";
      db.update(lots)
        .set({ crewId: crew.id, status, statusByCrewId: status === "open" ? null : crew.id, statusAt: status === "open" ? null : now - (60 - k * 5) * MIN })
        .where(eq(lots.id, l.id))
        .run();
    });
    const active = mine[Math.floor(perCrew / 3)] ?? mine[0]!;
    crewHome.set(crew.id, active);
  }
  // #endregion

  // #region planning portal: parcel cache, survey tags, assignments, crew areas
  const plan = await seedPlan({ eventId: ev.id, dayId: day1.id, bbox: BBOX, crews: crewRows });
  // #endregion

  // #region positions
  for (const crew of crewRows) {
    const home = crewHome.get(crew.id) ?? (crew.ccId === east.id ? east : west);
    for (let k = 3; k >= 0; k--) {
      const p = jitter(home, 25);
      db.insert(positions).values({ kind: "crew", refId: crew.id, lat: p.lat, lng: p.lng, accuracy: 12, at: now - k * 2 * MIN }).run();
    }
    db.update(crews).set({ lastSeenAt: now - MIN }).where(eq(crews.id, crew.id)).run();
  }
  const truckStart: Array<[number, LatLng]> = [
    [t1.id, jitter({ lat: (east.lat + crewHome.get(crewRows[2]!.id)!.lat) / 2, lng: (east.lng + crewHome.get(crewRows[2]!.id)!.lng) / 2 }, 40)],
    [t2.id, jitter(east, 30)],
    [t3.id, jitter(west, 30)],
  ];
  for (const [truckId, p] of truckStart) {
    db.insert(positions).values({ kind: "truck", refId: truckId, lat: p.lat, lng: p.lng, accuracy: 8, heading: 90, speed: 4, at: now - MIN }).run();
    db.update(trucks).set({ lastSeenAt: now - MIN }).where(eq(trucks.id, truckId)).run();
  }
  // #endregion

  // #region requests
  interface SeedReq {
    crew: Crew | null;
    key: string;
    qty: number;
    status: RequestStatus;
    truckId: number | null;
    ageMin: number;
    note?: string;
    label?: string;
    at?: LatLng;
  }
  const c = (n: number): Crew => crewRows[n - 1]!;
  const seedReqs: SeedReq[] = [
    { crew: c(1), key: "water", qty: 2, status: "delivered", truckId: t1.id, ageMin: 95 },
    { crew: c(2), key: "trash_bags", qty: 3, status: "delivered", truckId: t1.id, ageMin: 70 },
    { crew: c(3), key: "gas_mower", qty: 1, status: "en_route", truckId: t1.id, ageMin: 14, note: "Blue house side yard" },
    { crew: c(4), key: "water", qty: 3, status: "assigned", truckId: t2.id, ageMin: 6 },
    { crew: null, key: "water", qty: 4, status: "assigned", truckId: t2.id, ageMin: 4, label: "Corner of Harding and Warren", at: jitter(east, 400) },
    { crew: c(5), key: "snacks", qty: 2, status: "cancelled", truckId: null, ageMin: 40 },
    { crew: c(8), key: "swap_trimmer", qty: 1, status: "assigned", truckId: t3.id, ageMin: 9, note: "Pull cord snapped" },
    { crew: c(10), key: "loppers", qty: 2, status: "open", truckId: null, ageMin: 1 },
  ];
  for (const r of seedReqs) {
    const created = now - r.ageMin * MIN;
    const pos = r.at ?? (r.crew ? crewHome.get(r.crew.id) ?? null : null);
    const row = db
      .insert(requests)
      .values({
        crewId: r.crew?.id ?? null,
        ccId: r.crew?.ccId ?? east.id,
        dayId: day1.id,
        typeId: typeId(r.key),
        qty: r.qty,
        note: r.note ?? null,
        label: r.label ?? null,
        createdBy: r.crew ? "crew" : "green",
        status: r.status,
        truckId: r.truckId,
        createdAt: created,
        assignedAt: r.truckId !== null ? created + 20_000 : null,
        enRouteAt: r.status === "en_route" || r.status === "delivered" ? created + 3 * MIN : null,
        deliveredAt: r.status === "delivered" ? created + 18 * MIN : null,
        cancelledAt: r.status === "cancelled" ? created + 2 * MIN : null,
        cancelledBy: r.status === "cancelled" ? "crew" : null,
        lat: pos?.lat ?? null,
        lng: pos?.lng ?? null,
      })
      .returning()
      .get();
    if (r.status === "delivered" && r.truckId !== null) {
      const s = db.select().from(truckStock).where(and(eq(truckStock.truckId, r.truckId), eq(truckStock.typeId, row.typeId))).get();
      if (s) {
        const after = Math.max(0, s.qty - r.qty);
        db.update(truckStock).set({ qty: after }).where(and(eq(truckStock.truckId, r.truckId), eq(truckStock.typeId, row.typeId))).run();
        db.insert(stockMoves).values({ truckId: r.truckId, typeId: row.typeId, delta: after - s.qty, reason: "delivery", requestId: row.id, at: row.deliveredAt! }).run();
      }
    }
  }
  // Truck 2 has handed out most of its water, so the demo shows the Low stock pill.
  db.update(truckStock).set({ qty: 5 }).where(and(eq(truckStock.truckId, t2.id), eq(truckStock.typeId, typeId("water")))).run();
  // #endregion

  // #region photos: two done lots per CC get a before and after pair
  const photoTargets: SeedPhotoTarget[] = [];
  for (const cc of [east, west]) {
    const done = db
      .select()
      .from(lots)
      .where(and(eq(lots.eventId, ev.id), eq(lots.ccId, cc.id), eq(lots.status, "done")))
      .all()
      .sort((a, b) => haversine(a, cc) - haversine(b, cc))
      .slice(0, 2);
    done.forEach((l, k) => {
      const crew = crewRows.find((c) => c.id === l.crewId) ?? null;
      photoTargets.push({
        lot: l,
        ccId: cc.id,
        dayId: day1.id,
        crewId: crew?.id ?? null,
        takenBy: crew?.leadName ?? "Crew",
        beforeAt: now - (150 - k * 10) * MIN,
        afterAt: now - (50 - k * 10) * MIN,
      });
    });
  }
  const photographed = await seedLotPhotos(photoTargets);
  // #endregion

  db.insert(broadcasts).values({ ccId: east.id, dayId: day1.id, body: "Lunch at the CC 12:30", sentBy: "Dana Brooks", at: now - 25 * MIN }).run();

  for (const t of [t1, t2, t3]) await computeRouteNow(t.id, now);
  cancelScheduledRoutes();

  // #region report
  const base = config.publicUrl;
  const rows: Array<[string, string, string]> = [
    ["admin", "Admin", "(ADMIN_PASSWORD)"],
    ["green", "CC East", `EAST01  ${base}/g/EAST01`],
    ["green", "CC West", `WEST01  ${base}/g/WEST01`],
    ["driver", "Truck 1 (East)", `TRUCK1  ${base}/t/TRUCK1`],
    ["driver", "Truck 2 (East)", `TRUCK2  ${base}/t/TRUCK2`],
    ["driver", "Truck 3 (West)", `TRUCK3  ${base}/t/TRUCK3`],
    ...crewRows.map((cr): [string, string, string] => [
      "crew",
      `Crew ${cr.number} (${companyNames[(cr.number - 1) % companyNames.length]?.[0] ?? ""}, ${cr.ccId === east.id ? "East" : "West"})`,
      `${base}/j/${cr.token}`,
    ]),
  ];
  const w0 = Math.max(...rows.map((r) => r[0].length));
  const w1 = Math.max(...rows.map((r) => r[1].length));
  console.log(`\nSeeded "${EVENT_NAME}": ${allLots.length} lots (${lotSource}), ${crewRows.length} crews, 3 trucks, ${seedReqs.length} requests, ${photographed} photo pairs`);
  console.log(`Plan: ${plan.parcels}, ${plan.tags} survey tags, ${plan.assigned} block sides assigned, ${plan.shared} shared areas, ${plan.published} lots published, ${plan.areas} crew areas\n`);
  console.log(`${"role".padEnd(w0)}  ${"who".padEnd(w1)}  code or join link`);
  console.log(`${"-".repeat(w0)}  ${"-".repeat(w1)}  ${"-".repeat(40)}`);
  for (const [role, who, code] of rows) console.log(`${role.padEnd(w0)}  ${who.padEnd(w1)}  ${code}`);
  console.log(`\nLog in at ${base}/login\n`);
  // #endregion
};

await main();
