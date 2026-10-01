import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LotGeometry } from "./db/schema.ts";

// The db opens $DATA_DIR at import, so the env is set first and every app module is imported dynamically.
const dir = mkdtempSync(join(tmpdir(), "lrbuddy-parcel-status-test-"));
process.env.DATA_DIR ??= dir;
process.env.SESSION_SECRET ??= "test-secret";
process.env.ADMIN_PASSWORD ??= "test-admin";
process.env.OSRM_URL = "off";
process.env.VAPID_PUBLIC_KEY = "";
process.env.VAPID_PRIVATE_KEY = "";

const { db } = await import("./db/index.ts");
const s = await import("./db/schema.ts");
const setup = await import("./setup.ts");
const { bus } = await import("./bus.ts");
const { createSession } = await import("./auth.ts");
const { upsertParcels } = await import("./parcels.ts");
const { greenRouter } = await import("./routers/green.ts");
const { driverRouter } = await import("./routers/driver.ts");
const { crewRouter } = await import("./routers/crew.ts");
const { publishAssignments } = await import("./routers/plan/assignments.ts");
const { eq } = await import("drizzle-orm");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

// #region fixture
const square = (lat: number, lng: number): LotGeometry => ({
  type: "Polygon",
  coordinates: [[[lng - 0.00005, lat - 0.00005], [lng + 0.00005, lat - 0.00005], [lng + 0.00005, lat + 0.00005], [lng - 0.00005, lat + 0.00005], [lng - 0.00005, lat - 0.00005]]],
});
const rect = (w: number, e: number, south: number, north: number): { type: "Polygon"; coordinates: Array<Array<[number, number]>> } => ({
  type: "Polygon",
  coordinates: [[[w, south], [e, south], [e, north], [w, north], [w, south]]],
});

const CC = { lat: 42.38, lng: -83.12 };
/** Parcels: two in crew A's rectangle, one in B's, one in the day area outside both, one far away. */
const SPOTS = {
  a1: { lat: 42.3800, lng: -83.1215 },
  a2: { lat: 42.3802, lng: -83.1205 },
  b1: { lat: 42.3800, lng: -83.1170 },
  mid: { lat: 42.3800, lng: -83.1194 },
  far: { lat: 42.3900, lng: -83.1000 },
} as const;
type Spot = keyof typeof SPOTS;
const pid = (k: Spot): string => `${k}.`;

const world = () => {
  db.delete(s.events).run();
  db.delete(s.parcels).run();
  const ev = setup.createEvent({ name: "Parcel status test", year: 2026, startDate: "2026-10-01", dayCount: 1, active: true });
  const day = db.select().from(s.days).where(eq(s.days.eventId, ev.id)).get()!;
  const east = setup.createCc({ dayId: day.id, name: "East", ...CC });
  const west = setup.createCc({ dayId: day.id, name: "West", lat: 42.37, lng: -83.0 });
  const gm = db.insert(s.companies).values({ eventId: ev.id, name: "General Motors", short: "GM" }).returning().get();
  const dte = db.insert(s.companies).values({ eventId: ev.id, name: "DTE", short: "DTE" }).returning().get();
  const crewA = setup.createCrew({ dayId: day.id, ccId: east.id, companyId: gm.id });
  const crewB = setup.createCrew({ dayId: day.id, ccId: east.id, companyId: gm.id });
  const crewC = setup.createCrew({ dayId: day.id, ccId: east.id, companyId: gm.id });
  const areaA = db.insert(s.crewAreas).values({ eventId: ev.id, dayId: day.id, polygon: rect(-83.122, -83.12, 42.3795, 42.3805) }).returning().get();
  const areaB = db.insert(s.crewAreas).values({ eventId: ev.id, dayId: day.id, polygon: rect(-83.118, -83.116, 42.3795, 42.3805) }).returning().get();
  db.update(s.crews).set({ areaId: areaA.id }).where(eq(s.crews.id, crewA.id)).run();
  db.update(s.crews).set({ areaId: areaB.id }).where(eq(s.crews.id, crewB.id)).run();
  upsertParcels(
    (Object.keys(SPOTS) as Spot[]).map((k) => ({
      parcelId: pid(k),
      address: `${100 + k.length} ${k.toUpperCase()} ST`,
      lat: SPOTS[k].lat,
      lng: SPOTS[k].lng,
      geometry: square(SPOTS[k].lat, SPOTS[k].lng),
      streetName: k.toUpperCase(),
      streetNumber: 100 + k.length,
      streetPrefix: null,
      crossStreet1: "Dexter Ave",
      crossStreet2: "Wildemere St",
      propertyClass: "402",
      propertyClassDescription: "RESIDENTIAL-VACANT",
      taxpayer1: null,
      isImproved: false,
      pctPreClaimed: 0,
      saleDate: null,
    })),
  );
  const truck = setup.createTruck({ dayId: day.id, ccId: east.id, name: "Truck 1" });
  const westLot = db.insert(s.lots).values({ eventId: ev.id, ccId: west.id, address: "1 West St", lat: 42.37, lng: -83.0, source: "manual" }).returning().get();
  const sessionCtx = (session: ReturnType<typeof createSession>, ccOverride: number | null = null) => ({ session, ip: "127.0.0.1", ccOverride });
  return {
    ev,
    day,
    east,
    west,
    gm,
    dte,
    crewA,
    crewB,
    crewC,
    areaA,
    areaB,
    truck,
    westLot,
    green: greenRouter.createCaller(sessionCtx(createSession({ role: "green", ccId: east.id, displayName: "Gwen" }))),
    admin: greenRouter.createCaller(sessionCtx(createSession({ role: "admin", displayName: "Staff" }), east.id)),
    driver: driverRouter.createCaller(sessionCtx(createSession({ role: "driver", truckId: truck.id, ccId: east.id, displayName: "Dana" }))),
    crew: (crewId: number) => crewRouter.createCaller(sessionCtx(createSession({ role: "crew", crewId, ccId: east.id, displayName: "Red" }))),
  };
};

let w: ReturnType<typeof world>;
beforeEach(() => {
  w = world();
});

const lotOf = (k: Spot) => db.select().from(s.lots).where(eq(s.lots.parcelId, pid(k))).get();
const codeOf = async (p: Promise<unknown>): Promise<string | null> => {
  try {
    await p;
    return null;
  } catch (e) {
    return typeof e === "object" && e !== null && "code" in e ? String((e as { code: unknown }).code) : "ERROR";
  }
};
const listen = () => {
  const got: number[] = [];
  const off = bus.subscribe((m) => {
    if (m.type === "lot.changed") got.push(m.payload.lot.id);
  });
  return { got, off };
};
// #endregion

describe("green and admin", () => {
  test("Todo on a bare parcel creates the lot at the CC with the rectangle's crew, and emits lot.changed", async () => {
    const l = listen();
    const r = await w.green.setLotStatus({ parcelId: pid("a1"), status: "open" });
    l.off();
    expect(r.lot).toMatchObject({ status: "open", ccId: w.east.id, crewId: w.crewA.id, source: "manual", parcelId: pid("a1"), address: "102 A1 St" });
    expect(r.lot!.geometry).not.toBeNull();
    expect(l.got).toContain(r.lot!.id);
    // Outside every rectangle: no crew.
    expect((await w.admin.setLotStatus({ parcelId: pid("mid"), status: "open" })).lot!.crewId).toBeNull();
  });

  test("Not todo deletes a lot nobody worked on, and keeps one with history as not_todo", async () => {
    const fresh = (await w.green.setLotStatus({ parcelId: pid("a1"), status: "open" })).lot!;
    const r = await w.green.setLotStatus({ lotId: fresh.id, status: "not_todo" });
    expect(r).toEqual({ lot: null, deleted: true, clearedTagId: null });
    expect(lotOf("a1")).toBeUndefined();

    const worked = (await w.green.setLotStatus({ parcelId: pid("a2"), status: "done" })).lot!;
    const kept = await w.green.setLotStatus({ lotId: worked.id, status: "not_todo" });
    expect(kept.deleted).toBe(false);
    expect(kept.lot!.status).toBe("not_todo");

    const photo = (await w.green.setLotStatus({ parcelId: pid("b1"), status: "open" })).lot!;
    db.insert(s.lotPhotos).values({ lotId: photo.id, kind: "before", role: "green", at: Date.now(), width: 10, height: 10, bytes: 10 }).run();
    expect((await w.green.setLotStatus({ lotId: photo.id, status: "not_todo" })).lot!.status).toBe("not_todo");
  });

  test("Do not touch, grade and note; a lot at another CC is refused", async () => {
    const dnt = (await w.green.setLotStatus({ parcelId: pid("b1"), status: "do_not_touch" })).lot!;
    expect(dnt.status).toBe("do_not_touch");
    const graded = (await w.green.setLotStatus({ lotId: dnt.id, status: "open", grade: "high", note: "Tall grass" })).lot!;
    expect(graded).toMatchObject({ status: "open", grade: "high", note: "Tall grass" });
    expect(await codeOf(w.green.setLotStatus({ lotId: w.westLot.id, status: "done" }))).toBe("FORBIDDEN");
    expect(await codeOf(w.green.setLotStatus({ parcelId: "nope.", status: "open" }))).toBe("NOT_FOUND");
  });

  test("bare parcels: the day area, without parcels that have a lot", async () => {
    await w.green.setLotStatus({ parcelId: pid("a1"), status: "open" });
    const ids = (await w.green.parcels()).map((p) => p.parcelId).sort();
    expect(ids).toEqual([pid("a2"), pid("b1"), pid("mid")]);
  });
});

describe("driver", () => {
  test("Todo, In progress, Done and Not todo anywhere in the CC's day area", async () => {
    const made = (await w.driver.setLotStatus({ parcelId: pid("mid"), status: "open" })).lot!;
    expect(made).toMatchObject({ status: "open", statusByCrewId: null, ccId: w.east.id });
    expect((await w.driver.setLotStatus({ lotId: made.id, status: "in_progress" })).lot!.status).toBe("in_progress");
    expect((await w.driver.setLotStatus({ lotId: made.id, status: "done" })).lot!.status).toBe("done");
    expect((await w.driver.setLotStatus({ lotId: made.id, status: "not_todo" })).lot!.status).toBe("not_todo");
    expect(await codeOf(w.driver.setLotStatus({ parcelId: pid("far"), status: "open" }))).toBe("FORBIDDEN");
    expect(await codeOf(w.driver.setLotStatus({ lotId: w.westLot.id, status: "done" }))).toBe("FORBIDDEN");
  });

  test("never Do not touch, and never undoes one", async () => {
    const lot = (await w.green.setLotStatus({ parcelId: pid("a1"), status: "do_not_touch" })).lot!;
    expect(await codeOf(w.driver.setLotStatus({ parcelId: pid("a2"), status: "do_not_touch" }))).toBe("FORBIDDEN");
    expect(await codeOf(w.driver.setLotStatus({ lotId: lot.id, status: "open" }))).toBe("FORBIDDEN");
    expect(lotOf("a2")).toBeUndefined();
  });

  test("sees lots only: no Not todo lots", async () => {
    await w.green.setLotStatus({ parcelId: pid("a1"), status: "open" });
    const gone = (await w.green.setLotStatus({ parcelId: pid("a2"), status: "done" })).lot!;
    await w.green.setLotStatus({ lotId: gone.id, status: "not_todo" });
    const seen = (await w.driver.lots()).lots.map((l) => l.parcelId);
    expect(seen).toEqual([pid("a1")]);
  });
});

describe("crew", () => {
  test("inside its own rectangle: Todo creates the lot for the crew; Done, Not todo work", async () => {
    const a = w.crew(w.crewA.id);
    const made = (await a.setLotStatus({ parcelId: pid("a2"), status: "open" })).lot!;
    expect(made).toMatchObject({ crewId: w.crewA.id, statusByCrewId: w.crewA.id });
    expect((await a.setLotStatus({ lotId: made.id, status: "done" })).lot!.status).toBe("done");
    expect((await a.setLotStatus({ lotId: made.id, status: "not_todo" })).lot!.status).toBe("not_todo");
  });

  test("outside its rectangle and Do not touch are refused", async () => {
    const a = w.crew(w.crewA.id);
    expect(await codeOf(a.setLotStatus({ parcelId: pid("b1"), status: "open" }))).toBe("FORBIDDEN");
    expect(await codeOf(a.setLotStatus({ parcelId: pid("mid"), status: "open" }))).toBe("FORBIDDEN");
    const other = (await w.green.setLotStatus({ parcelId: pid("b1"), status: "open" })).lot!;
    expect(await codeOf(a.setLotStatus({ lotId: other.id, status: "done" }))).toBe("FORBIDDEN");
    expect(await codeOf(a.setLotStatus({ parcelId: pid("a1"), status: "do_not_touch" }))).toBe("FORBIDDEN");
    expect(lotOf("a1")).toBeUndefined();
  });

  test("a crew without a rectangle cannot add parcels", async () => {
    expect(await codeOf(w.crew(w.crewC.id).setLotStatus({ parcelId: pid("mid"), status: "open" }))).toBe("FORBIDDEN");
  });

  test("sees only its rectangle: lots and bare parcels inside it; the map fits to it", async () => {
    await w.green.setLotStatus({ parcelId: pid("a1"), status: "open" });
    await w.green.setLotStatus({ parcelId: pid("b1"), status: "open" });
    const m = await w.crew(w.crewA.id).map();
    expect(m.lots.map((l) => l.parcelId)).toEqual([pid("a1")]);
    expect(m.bare.map((p) => p.parcelId)).toEqual([pid("a2")]);
    expect(m.area).not.toBeNull();
    expect((await w.crew(w.crewA.id).lots()).map((l) => l.parcelId)).toEqual([pid("a1")]);
    // No rectangle: the lots assigned to it, as before, and no bare parcels.
    const c = await w.crew(w.crewC.id).map();
    expect(c.area).toBeNull();
    expect(c.bare).toEqual([]);
  });

  test("moving the crew to another rectangle moves its view", async () => {
    await w.green.setLotStatus({ parcelId: pid("b1"), status: "open" });
    const r = await w.green.assignArea({ polygon: rect(-83.118, -83.116, 42.3795, 42.3805), crewIds: [w.crewA.id] });
    expect(r.moved).toBe(1);
    const m = await w.crew(w.crewA.id).map();
    expect(m.lots.map((l) => l.parcelId)).toEqual([pid("b1")]);
    expect(m.lots[0]!.crewId).toBe(w.crewA.id);
    expect(m.bare).toEqual([]);
  });
});

describe("areas drawn on the green map", () => {
  test("Assign moves the Todo lots inside to the crews and makes their area; others keep their crew", async () => {
    const todo = (await w.green.setLotStatus({ parcelId: pid("mid"), status: "open" })).lot!;
    const done = (await w.green.setLotStatus({ parcelId: pid("a1"), status: "done" })).lot!;
    const l = listen();
    const r = await w.green.assignArea({ polygon: rect(-83.1222, -83.119, 42.3790, 42.3810), crewIds: [w.crewC.id] });
    l.off();
    expect(r).toMatchObject({ moved: 1, label: "GM 3" });
    expect(db.select().from(s.lots).where(eq(s.lots.id, todo.id)).get()!.crewId).toBe(w.crewC.id);
    expect(db.select().from(s.lots).where(eq(s.lots.id, done.id)).get()!.crewId).toBe(w.crewA.id);
    expect(db.select().from(s.crews).where(eq(s.crews.id, w.crewC.id)).get()!.areaId).toBe(r.areaId);
    expect(l.got).toContain(todo.id);
    const plan = await w.green.plan();
    expect(plan.areas.find((a) => a.id === r.areaId)?.label).toBe("GM 3");
  });

  test("several crews split the lots; crews from another CC are refused", async () => {
    const dte1 = setup.createCrew({ dayId: w.day.id, ccId: w.west.id, companyId: w.dte.id });
    expect(await codeOf(w.green.assignArea({ polygon: rect(-83.123, -83.115, 42.379, 42.381), crewIds: [dte1.id] }))).toBe("NOT_FOUND");
    for (const k of ["a1", "a2", "b1", "mid"] as const) await w.green.setLotStatus({ parcelId: pid(k), status: "open" });
    const r = await w.green.assignArea({ polygon: rect(-83.123, -83.115, 42.379, 42.381), crewIds: [w.crewA.id, w.crewB.id] });
    expect(r.moved).toBeGreaterThan(0);
    const owners = new Set(db.select().from(s.lots).where(eq(s.lots.ccId, w.east.id)).all().map((l) => l.crewId));
    expect(owners).toEqual(new Set([w.crewA.id, w.crewB.id]));
    expect(r.label).toBe("GM 1 & GM 2");
  });

  test("Edit corners moves the outline; Delete area unassigns its lots and keeps them", async () => {
    const lot = (await w.green.setLotStatus({ parcelId: pid("a1"), status: "open" })).lot!;
    const done = (await w.green.setLotStatus({ parcelId: pid("a2"), status: "done" })).lot!;
    await w.green.moveArea({ areaId: w.areaA.id, polygon: rect(-83.1225, -83.1195, 42.379, 42.381) });
    expect(db.select().from(s.crewAreas).where(eq(s.crewAreas.id, w.areaA.id)).get()!.polygon!.coordinates[0]![0]).toEqual([-83.1225, 42.379]);
    const r = await w.green.deleteArea({ areaId: w.areaA.id });
    expect(r.unassigned).toBe(1);
    expect(db.select().from(s.lots).where(eq(s.lots.id, lot.id)).get()).toMatchObject({ crewId: null, status: "open" });
    expect(db.select().from(s.lots).where(eq(s.lots.id, done.id)).get()!.crewId).toBe(w.crewA.id);
    expect(db.select().from(s.crewAreas).where(eq(s.crewAreas.id, w.areaA.id)).get()).toBeUndefined();
    expect(db.select().from(s.crews).where(eq(s.crews.id, w.crewA.id)).get()!.areaId).toBeNull();
    expect(await codeOf(w.green.deleteArea({ areaId: w.areaA.id }))).toBe("NOT_FOUND");
  });

  test("Build crews for a company with none on the day", async () => {
    const built = await w.green.buildCrews({ companyId: w.dte.id, headcount: 25 });
    expect(built.map((c) => c.name)).toEqual(["DTE 1", "DTE 2", "DTE 3"]);
    expect(await codeOf(w.green.buildCrews({ companyId: w.dte.id, headcount: 5 }))).toBe("CONFLICT");
    expect((await w.green.plan()).buildable.map((c) => c.name)).toEqual([]);
  });

  test("drivers and crews cannot draw areas", async () => {
    const asDriver = greenRouter.createCaller({ session: createSession({ role: "driver", truckId: w.truck.id, ccId: w.east.id }), ip: "127.0.0.1", ccOverride: null });
    expect(await codeOf(asDriver.assignArea({ polygon: rect(-83.1222, -83.119, 42.379, 42.381), crewIds: [w.crewC.id] }))).toBe("FORBIDDEN");
  });
});

describe("survey and publish", () => {
  test("Not todo on a published survey lot clears the parcel, so Publish leaves it off", async () => {
    db.insert(s.surveyTags).values({ eventId: w.ev.id, parcelId: pid("a1"), grade: "high", side: "tap", at: Date.now() - 1000 }).run();
    const key = db.select().from(s.parcels).where(eq(s.parcels.parcelId, pid("a1"))).get()!.blockSideKey!;
    db.insert(s.assignments).values({ eventId: w.ev.id, dayId: w.day.id, ccId: w.east.id, companyId: w.gm.id, crewId: w.crewA.id, blockSideKey: key, order: 1 }).run();
    publishAssignments(w.ev.id, { dayId: w.day.id });
    const lot = lotOf("a1")!;
    expect(lot).toMatchObject({ source: "survey", grade: "high", crewId: w.crewA.id });
    await w.green.setLotStatus({ lotId: lot.id, status: "not_todo" });
    expect(lotOf("a1")).toBeUndefined();
    publishAssignments(w.ev.id, { dayId: w.day.id });
    expect(lotOf("a1")).toBeUndefined();
  });

  test("Publish leaves Do not touch and Not todo lots as the field set them", async () => {
    db.insert(s.surveyTags).values({ eventId: w.ev.id, parcelId: pid("a1"), grade: "low", side: "tap", at: Date.now() - 1000 }).run();
    const key = db.select().from(s.parcels).where(eq(s.parcels.parcelId, pid("a1"))).get()!.blockSideKey!;
    db.insert(s.assignments).values({ eventId: w.ev.id, dayId: w.day.id, ccId: w.east.id, companyId: w.gm.id, crewId: w.crewB.id, blockSideKey: key, order: 1 }).run();
    await w.green.setLotStatus({ parcelId: pid("a1"), status: "do_not_touch" });
    const r = publishAssignments(w.ev.id, { dayId: w.day.id });
    expect(r.kept).toBe(1);
    expect(lotOf("a1")).toMatchObject({ status: "do_not_touch", crewId: w.crewA.id });
  });
});
