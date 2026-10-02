import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LotStatus, Role } from "./db/schema.ts";

// SPEC 27: switch day, CC and role from the header; capabilities follow the person.
// The db opens $DATA_DIR at import, so the env is set first and every app module is imported dynamically.
const dir = mkdtempSync(join(tmpdir(), "lrbuddy-switch-test-"));
process.env.DATA_DIR ??= dir;
process.env.SESSION_SECRET ??= "test-secret";
process.env.OSRM_URL = "off";
process.env.VAPID_PUBLIC_KEY = "";
process.env.VAPID_PRIVATE_KEY = "";

const { db } = await import("./db/index.ts");
const s = await import("./db/schema.ts");
const setup = await import("./setup.ts");
const a = await import("./access.ts");
const sw = await import("./switch.ts");
const { createSession, getSession } = await import("./auth.ts");
const { accessRouter } = await import("./routers/access.ts");
const { sharedRouter } = await import("./routers/shared.ts");
const { greenRouter } = await import("./routers/green.ts");
const { driverRouter } = await import("./routers/driver.ts");
const { crewRouter } = await import("./routers/crew.ts");
const { clearPaintHistory } = await import("./paint.ts");
const { and, eq } = await import("drizzle-orm");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

// #region fixture
/** Noon in Detroit on a date, as unix ms (EDT). */
const noon = (date: string): number => Date.parse(`${date}T16:00:00Z`);

const world = () => {
  db.delete(s.events).run();
  const ev = setup.createEvent({ name: "Switch test", year: 2026, startDate: "2026-10-01", dayCount: 3, active: true });
  const [d1, d2, d3] = db.select().from(s.days).where(eq(s.days.eventId, ev.id)).orderBy(s.days.sort).all();
  const company = db.insert(s.companies).values({ eventId: ev.id, name: "General Motors", short: "GM" }).returning().get();
  const webb1 = setup.createCc({ dayId: d1!.id, name: "Webb", lat: 42.38, lng: -83.12 });
  const east1 = setup.createCc({ dayId: d1!.id, name: "East", lat: 42.3786, lng: -82.9911 });
  const webb2 = setup.createCc({ dayId: d2!.id, name: "Webb", lat: 42.38, lng: -83.12 });
  const b1 = setup.createTruck({ dayId: d1!.id, ccId: webb1.id, name: "Truck B1" });
  const b2 = setup.createTruck({ dayId: d1!.id, ccId: webb1.id, name: "Truck B2" });
  const e1 = setup.createTruck({ dayId: d1!.id, ccId: east1.id, name: "Truck 1" });
  const b1d2 = setup.createTruck({ dayId: d2!.id, ccId: webb2.id, name: "Truck B1" });
  const crew = setup.createCrew({ dayId: d1!.id, ccId: webb1.id, companyId: company.id });
  const crewD2 = setup.createCrew({ dayId: d2!.id, ccId: webb2.id, companyId: company.id });
  const lot = (status: LotStatus) =>
    db.insert(s.lots).values({ eventId: ev.id, lat: 42.3801, lng: -83.1201, source: "manual", status, ccId: webb1.id }).returning().get();
  return { ev, d1: d1!, d2: d2!, d3: d3!, webb1, east1, webb2, b1, b2, e1, b1d2, crew, crewD2, lot };
};
type World = ReturnType<typeof world>;

let n = 0;
const person = (name = "Filip") => {
  n += 1;
  const user = a.upsertUser({ uid: `switch-${process.pid}-${n}-${Date.now()}`, phone: null, email: null, name: null }, name);
  const session = createSession({ role: "none", userId: user.id, displayName: user.name });
  return { user, session };
};

const grant = (userId: number, role: Role, place: { dayId?: number | null; ccId?: number | null; truckId?: number | null; crewId?: number | null }, eventId: number | null) =>
  db
    .insert(s.memberships)
    .values({ userId, eventId, role, dayId: place.dayId ?? null, ccId: place.ccId ?? null, truckId: place.truckId ?? null, crewId: place.crewId ?? null, status: "approved", requestedAt: Date.now(), decidedAt: Date.now() })
    .returning()
    .get();

const adminPerson = () => {
  const p = person("Admin");
  grant(p.user.id, "admin", {}, null);
  return p;
};

const ctx = (sessionId: string) => ({ session: getSession(sessionId), ip: "test", ccOverride: null });
const row = (id: string) => db.select().from(s.sessions).where(eq(s.sessions.id, id)).get()!;
const roleKeys = (v: ReturnType<typeof sw.switchOptions>, ccId: number) =>
  v.days.flatMap((d) => d.ccs).find((c) => c.id === ccId)?.roles.map((r) => `${r.key}=${r.action}`) ?? [];

let w: World;
beforeEach(() => {
  w = world();
  clearPaintHistory();
});
// #endregion

describe("switch options", () => {
  test("an admin may pick any day, any CC and every role there", () => {
    const { user, session } = adminPerson();
    // A date outside the event: no day is today, so the days keep their order.
    const v = sw.switchOptions(user.id, session, noon("2026-12-01"));
    expect(v.admin).toEqual({ held: true, current: false });
    expect(v.days.some((d) => d.today)).toBe(false);
    expect(v.days.map((d) => d.id)).toEqual([w.d1.id, w.d2.id]);
    expect(roleKeys(v, w.webb1.id)).toEqual([`green:${w.webb1.id}=enter`, `driver:${w.b1.id}=enter`, `driver:${w.b2.id}=enter`, `crew:${w.crew.id}=enter`]);
    expect(roleKeys(v, w.east1.id)).toEqual([`green:${w.east1.id}=enter`, `driver:${w.e1.id}=enter`]);
  });

  test("today is first and marked", () => {
    const { user, session } = adminPerson();
    const v = sw.switchOptions(user.id, session, noon(w.d2.date));
    expect(v.days[0]).toMatchObject({ id: w.d2.id, today: true });
    expect(v.days.filter((d) => d.today)).toHaveLength(1);
  });

  test("a green shirt sees green, every truck of the CC to take, and the same CC name on other days as a request", () => {
    const { user, session } = person();
    grant(user.id, "green", { dayId: w.d1.id, ccId: w.webb1.id }, w.ev.id);
    const v = sw.switchOptions(user.id, session);
    expect(v.admin.held).toBe(false);
    expect(roleKeys(v, w.webb1.id)).toEqual([`green:${w.webb1.id}=enter`, `driver:${w.b1.id}=take`, `driver:${w.b2.id}=take`]);
    // Not at CC East: nothing held there, so that CC is not listed.
    expect(v.days.flatMap((d) => d.ccs).some((c) => c.id === w.east1.id)).toBe(false);
    // Day 2's Webb: green as a one-tap request.
    const req = v.days.find((d) => d.id === w.d2.id)!.ccs.find((c) => c.id === w.webb2.id)!.roles;
    expect(req).toHaveLength(1);
    expect(req[0]).toMatchObject({ role: "green", action: "request", request: { role: "green", dayId: w.d2.id, ccId: w.webb2.id } });
  });

  test("a driver on one day: the same truck name on the next day is a request; the current role is marked", () => {
    const { user, session } = person();
    const m = grant(user.id, "driver", { dayId: w.d1.id, ccId: w.webb1.id, truckId: w.b1.id }, w.ev.id);
    a.enterMembership(session.id, m);
    const v = sw.switchOptions(user.id, row(session.id));
    expect(v.current).toEqual({ dayId: w.d1.id, ccId: w.webb1.id });
    const d1 = v.days.find((d) => d.id === w.d1.id)!.ccs.find((c) => c.id === w.webb1.id)!.roles;
    expect(d1.map((r) => [r.key, r.action, r.current])).toEqual([[`driver:${w.b1.id}`, "enter", true]]);
    const d2 = v.days.find((d) => d.id === w.d2.id)!.ccs.find((c) => c.id === w.webb2.id)!.roles;
    expect(d2.map((r) => [r.key, r.action])).toEqual([[`driver:${w.b1d2.id}`, "request"]]);
  });

  test("a pending request shows as pending", () => {
    const { user, session } = person();
    const r = a.requestAccess(user.id, { role: "green", dayId: w.d1.id, ccId: w.east1.id });
    expect(r.ok).toBe(true);
    expect(roleKeys(sw.switchOptions(user.id, session), w.east1.id)).toEqual([`green:${w.east1.id}=pending`]);
  });
});

describe("switch to", () => {
  test("a green shirt takes Driver for a truck at its CC: an approved membership noted self, green", () => {
    const { user, session } = person();
    const green = grant(user.id, "green", { dayId: w.d1.id, ccId: w.webb1.id }, w.ev.id);
    a.enterMembership(session.id, green);
    expect(sw.switchTo(user.id, session.id, { role: "driver", truckId: w.b1.id })).toEqual({ ok: true, role: "driver" });
    const m = db.select().from(s.memberships).where(and(eq(s.memberships.userId, user.id), eq(s.memberships.role, "driver"))).get()!;
    expect(m).toMatchObject({ status: "approved", note: "self, green", truckId: w.b1.id, dayId: w.d1.id, ccId: w.webb1.id });
    expect(row(session.id)).toMatchObject({ role: "driver", truckId: w.b1.id, ccId: w.webb1.id, membershipId: m.id });
    // And back to green.
    expect(sw.switchTo(user.id, session.id, { role: "green", ccId: w.webb1.id })).toEqual({ ok: true, role: "green" });
    expect(row(session.id)).toMatchObject({ role: "green", ccId: w.webb1.id, membershipId: green.id, truckId: null });
  });

  test("a green shirt cannot take a truck at another CC, nor a crew, nor admin", () => {
    const { user, session } = person();
    grant(user.id, "green", { dayId: w.d1.id, ccId: w.webb1.id }, w.ev.id);
    expect(sw.switchTo(user.id, session.id, { role: "driver", truckId: w.e1.id })).toEqual({ ok: false, code: "FORBIDDEN" });
    expect(sw.switchTo(user.id, session.id, { role: "driver", truckId: w.b1d2.id })).toEqual({ ok: false, code: "FORBIDDEN" });
    expect(sw.switchTo(user.id, session.id, { role: "crew", crewId: w.crew.id })).toEqual({ ok: false, code: "FORBIDDEN" });
    expect(sw.switchTo(user.id, session.id, { role: "admin" })).toEqual({ ok: false, code: "FORBIDDEN" });
    expect(row(session.id).role).toBe("none");
  });

  test("a driver-only user cannot take another truck or green", () => {
    const { user, session } = person();
    grant(user.id, "driver", { dayId: w.d1.id, ccId: w.webb1.id, truckId: w.b1.id }, w.ev.id);
    expect(sw.switchTo(user.id, session.id, { role: "driver", truckId: w.b2.id })).toEqual({ ok: false, code: "FORBIDDEN" });
    expect(sw.switchTo(user.id, session.id, { role: "green", ccId: w.webb1.id })).toEqual({ ok: false, code: "FORBIDDEN" });
    expect(sw.switchTo(user.id, session.id, { role: "driver", truckId: w.b1.id })).toEqual({ ok: true, role: "driver" });
  });

  test("every approved membership, any day, is a pick", () => {
    const { user, session } = person();
    grant(user.id, "green", { dayId: w.d2.id, ccId: w.webb2.id }, w.ev.id);
    expect(sw.switchTo(user.id, session.id, { role: "green", ccId: w.webb2.id })).toEqual({ ok: true, role: "green" });
    expect(row(session.id)).toMatchObject({ role: "green", ccId: w.webb2.id });
  });

  test("an admin switches to green, driver and red shirt anywhere with no membership row, then back to admin", () => {
    const { user, session } = adminPerson();
    expect(sw.switchTo(user.id, session.id, { role: "green", ccId: w.webb2.id })).toEqual({ ok: true, role: "green" });
    expect(row(session.id)).toMatchObject({ role: "green", ccId: w.webb2.id, membershipId: null });
    expect(sw.switchTo(user.id, session.id, { role: "driver", truckId: w.e1.id })).toEqual({ ok: true, role: "driver" });
    expect(row(session.id)).toMatchObject({ role: "driver", truckId: w.e1.id, ccId: w.east1.id });
    expect(sw.switchTo(user.id, session.id, { role: "crew", crewId: w.crew.id })).toEqual({ ok: true, role: "crew" });
    expect(row(session.id)).toMatchObject({ role: "crew", crewId: w.crew.id, ccId: w.webb1.id });
    expect(db.select().from(s.memberships).where(eq(s.memberships.userId, user.id)).all().map((m) => m.role)).toEqual(["admin"]);
    expect(getSession(session.id)?.role).toBe("crew");
    expect(sw.switchTo(user.id, session.id, { role: "admin" })).toEqual({ ok: true, role: "admin" });
    expect(row(session.id).role).toBe("admin");
  });

  test("a role an admin switched into ends when admin is taken away", () => {
    const other = adminPerson();
    const { user, session } = adminPerson();
    sw.switchTo(user.id, session.id, { role: "green", ccId: w.webb1.id });
    expect(a.removeAdmin(user.id)).toEqual({ ok: true });
    expect(getSession(session.id)?.role).toBe("none");
    // Also when the session row was not caught by removeAdmin (written later by hand): getSession drops it.
    db.update(s.sessions).set({ role: "green", ccId: w.webb1.id, membershipId: null }).where(eq(s.sessions.id, session.id)).run();
    expect(getSession(session.id)?.role).toBe("none");
    expect(other.user.id).toBeGreaterThan(0);
  });

  test("access.switchTo through the router, and a code session cannot switch", async () => {
    const { user, session } = person();
    grant(user.id, "green", { dayId: w.d1.id, ccId: w.webb1.id }, w.ev.id);
    const api = accessRouter.createCaller(ctx(session.id));
    expect(await api.switchTo({ role: "driver", truckId: w.b2.id })).toEqual({ role: "driver" });
    await expect(api.switchTo({ role: "driver", truckId: w.e1.id })).rejects.toThrow("Not allowed");
    const code = createSession({ role: "green", ccId: w.webb1.id });
    await expect(accessRouter.createCaller(ctx(code.id)).switchOptions()).rejects.toThrow();
  });
});

describe("capabilities follow the person", () => {
  const driverOf = (truckId: number, withGreen: boolean) => {
    const { user, session } = person();
    if (withGreen) grant(user.id, "green", { dayId: w.d1.id, ccId: w.webb1.id }, w.ev.id);
    const m = grant(user.id, "driver", { dayId: w.d1.id, ccId: w.webb1.id, truckId }, w.ev.id);
    a.enterMembership(session.id, m);
    return { user, session };
  };

  test("a driver who holds green at the CC: green procedures, Do not touch, Not todo lots, me.can.green", async () => {
    const { session } = driverOf(w.b1.id, true);
    const notTodo = w.lot("not_todo");
    const open = w.lot("open");
    const green = greenRouter.createCaller(ctx(session.id));
    expect(Array.isArray(await green.parcels())).toBe(true);
    const r = await green.paint({ brush: { kind: "status", status: "done" }, lotIds: [open.id], parcelIds: [] });
    expect(r.changed).toBe(1);
    expect((await green.paintUndo()).restored).toBe(1);
    const driver = driverRouter.createCaller(ctx(session.id));
    expect((await driver.setLotStatus({ lotId: open.id, status: "do_not_touch" })).lot?.status).toBe("do_not_touch");
    expect((await driver.setLotStatus({ lotId: open.id, status: "open" })).lot?.status).toBe("open");
    expect((await driver.lots()).lots.map((l) => l.id)).toContain(notTodo.id);
    const me = await sharedRouter.createCaller(ctx(session.id)).me();
    expect(me.role === "driver" && me.can.green).toBe(true);
  });

  test("a driver-only user still cannot do green things", async () => {
    const { session } = driverOf(w.b1.id, false);
    const notTodo = w.lot("not_todo");
    const open = w.lot("open");
    const green = greenRouter.createCaller(ctx(session.id));
    await expect(green.parcels()).rejects.toThrow("Not allowed");
    await expect(green.paint({ brush: { kind: "status", status: "done" }, lotIds: [open.id], parcelIds: [] })).rejects.toThrow("Not allowed");
    await expect(green.setLotStatus({ lotId: open.id, status: "do_not_touch" })).rejects.toThrow("Not allowed");
    await expect(accessRouter.createCaller(ctx(session.id)).pending()).rejects.toThrow("Not allowed");
    const driver = driverRouter.createCaller(ctx(session.id));
    await expect(driver.setLotStatus({ lotId: open.id, status: "do_not_touch" })).rejects.toThrow("Do not touch is for green shirts");
    expect((await driver.setLotStatus({ lotId: open.id, status: "done" })).lot?.status).toBe("done");
    expect((await driver.lots()).lots.map((l) => l.id)).not.toContain(notTodo.id);
    const me = await sharedRouter.createCaller(ctx(session.id)).me();
    expect(me.role === "driver" && me.can.green).toBe(false);
  });

  test("green at another CC or another day does not count", async () => {
    const { user, session } = person();
    grant(user.id, "green", { dayId: w.d1.id, ccId: w.east1.id }, w.ev.id);
    grant(user.id, "green", { dayId: w.d2.id, ccId: w.webb2.id }, w.ev.id);
    const m = grant(user.id, "driver", { dayId: w.d1.id, ccId: w.webb1.id, truckId: w.b1.id }, w.ev.id);
    a.enterMembership(session.id, m);
    await expect(greenRouter.createCaller(ctx(session.id)).parcels()).rejects.toThrow("Not allowed");
  });

  test("a pending green request does not count", async () => {
    const { user, session } = driverOf(w.b1.id, false);
    a.requestAccess(user.id, { role: "green", dayId: w.d1.id, ccId: w.webb1.id });
    await expect(greenRouter.createCaller(ctx(session.id)).parcels()).rejects.toThrow("Not allowed");
  });

  test("a red shirt who holds green at the CC may set Do not touch; a red shirt alone may not", async () => {
    const lot = w.lot("open");
    const mk = (withGreen: boolean) => {
      const { user, session } = person();
      if (withGreen) grant(user.id, "green", { dayId: w.d1.id, ccId: w.webb1.id }, w.ev.id);
      a.enterMembership(session.id, grant(user.id, "crew", { dayId: w.d1.id, ccId: w.webb1.id, crewId: w.crew.id }, w.ev.id));
      return crewRouter.createCaller(ctx(session.id));
    };
    await expect(mk(false).setLotStatus({ lotId: lot.id, status: "do_not_touch" })).rejects.toThrow("Do not touch is for green shirts");
    expect((await mk(true).setLotStatus({ lotId: lot.id, status: "do_not_touch" })).lot?.status).toBe("do_not_touch");
  });

  test("an admin's driver session has green powers at the truck's CC", async () => {
    const { user, session } = adminPerson();
    sw.switchTo(user.id, session.id, { role: "driver", truckId: w.b1.id });
    expect(Array.isArray(await greenRouter.createCaller(ctx(session.id)).parcels())).toBe(true);
  });
});
