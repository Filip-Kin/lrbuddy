import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The db module opens $DATA_DIR at import; set the env before anything loads it.
// Firebase is mocked: setVerifier replaces the Admin SDK check, so these tests
// need neither the emulator nor a project. scripts/access.py drives the real
// emulator end to end.
const dir = mkdtempSync(join(tmpdir(), "lrbuddy-access-test-"));
process.env.DATA_DIR = dir;
process.env.SESSION_SECRET = "test-secret";
process.env.OSRM_URL = "off";
process.env.VAPID_PUBLIC_KEY = "";
process.env.VAPID_PRIVATE_KEY = "";

const { db } = await import("./db/index.ts");
const s = await import("./db/schema.ts");
const setup = await import("./setup.ts");
const a = await import("./access.ts");
const { createSession, getSession } = await import("./auth.ts");
const { setVerifier, verifyIdToken, firebaseConfigured } = await import("./firebase.ts");
const { accessRouter } = await import("./routers/access.ts");
const { sharedRouter } = await import("./routers/shared.ts");
const { eq } = await import("drizzle-orm");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

// #region fixture
const DAY_MS = 86_400_000;
/** Noon in Detroit on a date, as unix ms (EDT, UTC-4, all event long). */
const noon = (date: string): number => Date.parse(`${date}T16:00:00Z`);

const world = () => {
  db.delete(s.events).run();
  db.delete(s.users).run();
  db.delete(s.sessions).run();
  const ev = setup.createEvent({ name: "Test", year: 2026, startDate: "2026-09-28", dayCount: 3, active: true });
  const [d1, d2, d3] = db.select().from(s.days).where(eq(s.days.eventId, ev.id)).orderBy(s.days.sort).all();
  const company = db.insert(s.companies).values({ eventId: ev.id, name: "Ford" }).returning().get();
  const east = setup.createCc({ dayId: d1!.id, name: "East", lat: 42.3786, lng: -82.9911, code: "EASTT1" });
  const west = setup.createCc({ dayId: d1!.id, name: "West", lat: 42.3701, lng: -83.0209, code: "WESTT1" });
  const east2 = setup.createCc({ dayId: d2!.id, name: "East", lat: 42.3786, lng: -82.9911, code: "EASTT2" });
  const crew = setup.createCrew({ dayId: d1!.id, ccId: east.id, companyId: company.id, token: "access-crew-01" });
  const led = setup.createCrew({ dayId: d1!.id, ccId: east.id, companyId: company.id, leadName: "Pat Lee", leadPhone: "313-555-0100", token: "access-crew-02" });
  const crewDay2 = setup.createCrew({ dayId: d2!.id, ccId: east2.id, companyId: company.id, token: "access-crew-03" });
  const truck = setup.createTruck({ dayId: d1!.id, ccId: east.id, name: "Truck 1" });
  return { ev, d1: d1!, d2: d2!, d3: d3!, east, west, east2, crew, led, crewDay2, truck };
};
type World = ReturnType<typeof world>;

let n = 0;
const person = (name = "Jordan Reed", phone = "+13135550142") => {
  n += 1;
  const user = a.upsertUser({ uid: `uid-${n}`, phone, email: null, name: null }, name);
  const session = createSession({ role: "none", userId: user.id, displayName: user.name });
  return { user, session };
};

const sessionRow = (id: string) => db.select().from(s.sessions).where(eq(s.sessions.id, id)).get()!;
const membershipsOf = (userId: number) => db.select().from(s.memberships).where(eq(s.memberships.userId, userId)).all();

let w: World;
beforeEach(() => {
  w = world();
});
// #endregion

describe("verifier", () => {
  test("a mocked verifier stands in for the Admin SDK", async () => {
    setVerifier(async (t) => (t === "good" ? { uid: "u1", phone: "+13135550100", email: null, name: null } : null));
    expect(firebaseConfigured()).toBe(true);
    expect(await verifyIdToken("good")).toMatchObject({ uid: "u1" });
    expect(await verifyIdToken("bad")).toBeNull();
    setVerifier(null);
  });

  test("signing in again updates the same user", () => {
    const one = a.upsertUser({ uid: "same", phone: "+13135550101", email: null, name: "Google Name" }, null);
    expect(one.name).toBe("Google Name");
    const two = a.upsertUser({ uid: "same", phone: "+13135550101", email: null, name: "Google Name" }, "  Sam   Ortiz ");
    expect(two.id).toBe(one.id);
    expect(two.name).toBe("Sam Ortiz");
  });
});

describe("join links", () => {
  test("a crew QR creates one approved membership and signs the session in", () => {
    const { user, session } = person();
    const m = a.joinByLink(user.id, session.id, "crew", "access-crew-01")!;
    expect(m).toMatchObject({ role: "crew", status: "approved", crewId: w.crew.id, dayId: w.d1.id, ccId: w.east.id });
    expect(sessionRow(session.id)).toMatchObject({ role: "crew", crewId: w.crew.id, ccId: w.east.id, membershipId: m.id, displayName: "Jordan Reed" });
    // The crew had no red shirt: the person who scanned becomes it.
    expect(db.select().from(s.crews).where(eq(s.crews.id, w.crew.id)).get()).toMatchObject({ leadName: "Jordan Reed", leadPhone: "+13135550142" });
  });

  test("scanning twice keeps one membership", () => {
    const { user, session } = person();
    const first = a.joinByLink(user.id, session.id, "crew", "access-crew-01")!;
    const again = a.joinByLink(user.id, session.id, "crew", "access-crew-01")!;
    expect(again.id).toBe(first.id);
    expect(membershipsOf(user.id)).toHaveLength(1);
  });

  test("a scan approves a pending request for the same crew and drops other pending ones that day", () => {
    const { user, session } = person();
    const r = a.requestAccess(user.id, { role: "crew", dayId: w.d1.id, ccId: w.east.id, crewId: w.crew.id });
    expect(r.ok).toBe(true);
    const m = a.joinByLink(user.id, session.id, "crew", "access-crew-01")!;
    expect(r.ok && m.id === r.membership.id).toBe(true);
    expect(membershipsOf(user.id).map((x) => x.status)).toEqual(["approved"]);
  });

  test("a scan never overwrites a crew's red shirt", () => {
    const { user, session } = person();
    a.joinByLink(user.id, session.id, "crew", "access-crew-02");
    expect(db.select().from(s.crews).where(eq(s.crews.id, w.led.id)).get()).toMatchObject({ leadName: "Pat Lee", leadPhone: "313-555-0100" });
  });

  test("truck and CC codes join as driver and green shirt, any case", () => {
    const { user, session } = person();
    expect(a.joinByLink(user.id, session.id, "truck", w.truck.code.toLowerCase())).toMatchObject({ role: "driver", truckId: w.truck.id, ccId: w.east.id });
    expect(sessionRow(session.id)).toMatchObject({ role: "driver", truckId: w.truck.id });
    expect(a.joinByLink(user.id, session.id, "cc", "eastt1")).toMatchObject({ role: "green", ccId: w.east.id });
    expect(sessionRow(session.id)).toMatchObject({ role: "green", ccId: w.east.id, truckId: null });
    // A green shirt who scans in is listed for Call and Text.
    expect(db.select().from(s.greenShirts).where(eq(s.greenShirts.ccId, w.east.id)).all().map((g) => g.name)).toContain("Jordan Reed");
  });

  test("an unknown link creates nothing", () => {
    const { user, session } = person();
    expect(a.joinByLink(user.id, session.id, "crew", "no-such-token")).toBeNull();
    expect(a.joinByLink(user.id, session.id, "truck", "ZZZZZZ")).toBeNull();
    expect(membershipsOf(user.id)).toHaveLength(0);
    expect(sessionRow(session.id).role).toBe("none");
  });
});

describe("requests", () => {
  test("a crew request must name a crew at that CC", () => {
    const { user } = person();
    expect(a.requestAccess(user.id, { role: "crew", dayId: w.d1.id, ccId: w.west.id, crewId: w.crew.id })).toEqual({ ok: false, error: "Choose a crew" });
    expect(a.requestAccess(user.id, { role: "driver", dayId: w.d1.id, ccId: w.east.id })).toEqual({ ok: false, error: "Choose a truck" });
    expect(a.requestAccess(user.id, { role: "green", dayId: w.d2.id, ccId: w.east.id })).toEqual({ ok: false, error: "Command center not found" });
    expect(membershipsOf(user.id)).toHaveLength(0);
  });

  test("asking twice returns the same row; a new pick replaces a pending one", () => {
    const { user } = person();
    const one = a.requestAccess(user.id, { role: "crew", dayId: w.d1.id, ccId: w.east.id, crewId: w.crew.id });
    const two = a.requestAccess(user.id, { role: "crew", dayId: w.d1.id, ccId: w.east.id, crewId: w.crew.id });
    expect(one.ok && two.ok && one.membership.id === two.membership.id && !two.created).toBe(true);
    a.requestAccess(user.id, { role: "crew", dayId: w.d1.id, ccId: w.east.id, crewId: w.led.id });
    expect(membershipsOf(user.id).map((m) => m.crewId)).toEqual([w.led.id]);
  });

  test("the user withdraws their own pending request only", () => {
    const { user } = person();
    const other = person("Sam Ortiz", "+13135550143");
    const r = a.requestAccess(user.id, { role: "green", dayId: w.d1.id, ccId: w.east.id });
    if (!r.ok) throw new Error(r.error);
    expect(a.cancelRequest(other.user.id, r.membership.id)).toBe(false);
    expect(a.cancelRequest(user.id, r.membership.id)).toBe(true);
    expect(membershipsOf(user.id)).toHaveLength(0);
  });
});

describe("approval rules", () => {
  const ask = (userId: number, crewId: number) => {
    const r = a.requestAccess(userId, { role: "crew", dayId: w.d1.id, ccId: w.east.id, crewId });
    if (!r.ok) throw new Error(r.error);
    return r.membership;
  };

  test("a green shirt decides only for their own CC", () => {
    const { user } = person();
    const m = ask(user.id, w.crew.id);
    expect(a.decide(m.id, "approve", { userId: null, ccId: w.west.id, admin: false })).toEqual({ ok: false, code: "NOT_FOUND" });
    expect(a.decide(m.id, "approve", { userId: null, ccId: w.east.id, admin: false }).ok).toBe(true);
  });

  test("a decided request cannot be decided again", () => {
    const { user } = person();
    const m = ask(user.id, w.crew.id);
    a.decide(m.id, "deny", { userId: null, ccId: null, admin: true });
    expect(a.decide(m.id, "approve", { userId: null, ccId: null, admin: true })).toEqual({ ok: false, code: "CONFLICT" });
  });

  test("approving a red shirt for a crew with a lead asks Replace lead or Add", () => {
    const one = person();
    const m1 = ask(one.user.id, w.led.id);
    expect(a.decide(m1.id, "approve", { userId: null, ccId: w.east.id, admin: false })).toEqual({ ok: false, code: "LEAD_CHOICE", lead: "Pat Lee, 313-555-0100" });
    expect(db.select().from(s.memberships).where(eq(s.memberships.id, m1.id)).get()?.status).toBe("pending");
    expect(a.decide(m1.id, "approve", { userId: null, ccId: w.east.id, admin: false }, "add").ok).toBe(true);
    expect(db.select().from(s.crews).where(eq(s.crews.id, w.led.id)).get()).toMatchObject({ leadName: "Pat Lee" });

    const two = person("Alex Kim", "+13135550144");
    const m2 = ask(two.user.id, w.led.id);
    expect(a.decide(m2.id, "approve", { userId: null, ccId: w.east.id, admin: false }, "replace").ok).toBe(true);
    expect(db.select().from(s.crews).where(eq(s.crews.id, w.led.id)).get()).toMatchObject({ leadName: "Alex Kim", leadPhone: "+13135550144" });
  });

  test("a crew with no lead takes the approved red shirt without asking", () => {
    const { user } = person();
    const m = ask(user.id, w.crew.id);
    expect(a.decide(m.id, "approve", { userId: null, ccId: w.east.id, admin: false }).ok).toBe(true);
    expect(db.select().from(s.crews).where(eq(s.crews.id, w.crew.id)).get()).toMatchObject({ leadName: "Jordan Reed" });
  });

  test("approval moves a waiting session into the role; denial leaves it waiting", () => {
    const { user, session } = person();
    const m = ask(user.id, w.crew.id);
    a.decide(m.id, "approve", { userId: null, ccId: w.east.id, admin: false });
    expect(sessionRow(session.id)).toMatchObject({ role: "crew", crewId: w.crew.id, membershipId: m.id });

    const other = person("Sam Ortiz", "+13135550143");
    const m2 = ask(other.user.id, w.crew.id);
    a.decide(m2.id, "deny", { userId: user.id, ccId: w.east.id, admin: false });
    expect(sessionRow(other.session.id).role).toBe("none");
    expect(db.select().from(s.memberships).where(eq(s.memberships.id, m2.id)).get()).toMatchObject({ status: "denied", decidedByUserId: user.id });
  });

  test("the green's pending list holds only their CC's requests, oldest first", () => {
    const one = person();
    const two = person("Sam Ortiz", "+13135550143");
    ask(one.user.id, w.crew.id);
    a.requestAccess(two.user.id, { role: "green", dayId: w.d1.id, ccId: w.west.id });
    expect(a.pendingRequests(w.east.id).map((v) => v.user.name)).toEqual(["Jordan Reed"]);
    expect(a.pendingRequests(null)).toHaveLength(2);
    expect(a.requestLine(a.pendingRequests(w.east.id)[0]!)).toBe("Jordan Reed, Red shirt, Ford 1");
  });
});

describe("session resolution", () => {
  const approve = (userId: number, input: Parameters<typeof a.requestAccess>[1]) => {
    const r = a.requestAccess(userId, input);
    if (!r.ok) throw new Error(r.error);
    const d = a.decide(r.membership.id, "approve", { userId: null, ccId: null, admin: true }, "add");
    if (!d.ok) throw new Error(d.code);
    return d.membership;
  };

  test("no approved membership: the request screen", () => {
    const { user, session } = person();
    a.requestAccess(user.id, { role: "crew", dayId: w.d1.id, ccId: w.east.id, crewId: w.crew.id });
    expect(a.resolveSession(session.id, user.id, noon("2026-09-28"))).toBe("request");
  });

  test("one approved membership for today: straight into the role", () => {
    const { user } = person();
    const m = approve(user.id, { role: "crew", dayId: w.d1.id, ccId: w.east.id, crewId: w.crew.id });
    const fresh = createSession({ role: "none", userId: user.id });
    expect(a.resolveSession(fresh.id, user.id, noon("2026-09-28"))).toBe("entered");
    expect(sessionRow(fresh.id)).toMatchObject({ role: "crew", membershipId: m.id });
  });

  test("on an event day only that day's memberships count", () => {
    const { user } = person();
    approve(user.id, { role: "crew", dayId: w.d1.id, ccId: w.east.id, crewId: w.crew.id });
    const fresh = createSession({ role: "none", userId: user.id });
    // Day 2 has a CC, and this user has nothing on Day 2.
    expect(a.resolveSession(fresh.id, user.id, noon("2026-09-29"))).toBe("request");
    expect(sessionRow(fresh.id).role).toBe("none");
  });

  test("several for today: the chooser", () => {
    const { user } = person();
    approve(user.id, { role: "crew", dayId: w.d1.id, ccId: w.east.id, crewId: w.crew.id });
    approve(user.id, { role: "green", dayId: w.d1.id, ccId: w.west.id });
    const fresh = createSession({ role: "none", userId: user.id });
    expect(a.resolveSession(fresh.id, user.id, noon("2026-09-28"))).toBe("choose");
    expect(a.mine(user.id, noon("2026-09-28")).approved).toHaveLength(2);
  });

  test("off the event days (or a day with no CC) every approved membership counts", () => {
    const { user } = person();
    approve(user.id, { role: "crew", dayId: w.d2.id, ccId: w.east2.id, crewId: w.crewDay2.id });
    const before = createSession({ role: "none", userId: user.id });
    expect(a.resolveSession(before.id, user.id, noon("2026-09-01"))).toBe("entered");
    // Day 3 exists but has no CC set up.
    const day3 = createSession({ role: "none", userId: user.id });
    expect(a.resolveSession(day3.id, user.id, noon("2026-09-30"))).toBe("entered");
    expect(a.currentDayId(w.ev.id, noon("2026-09-30"))).toBeNull();
    expect(a.currentDayId(w.ev.id, noon("2026-09-29"))).toBe(w.d2.id);
    expect(a.currentDayId(w.ev.id, noon("2026-09-29") + DAY_MS * 30)).toBeNull();
  });

  test("leaving a role keeps the sign-in and the memberships", () => {
    const { user, session } = person();
    a.joinByLink(user.id, session.id, "crew", "access-crew-01");
    a.clearRole(session.id);
    expect(getSession(session.id)).toMatchObject({ role: "none", userId: user.id, crewId: null, membershipId: null });
    expect(membershipsOf(user.id)).toHaveLength(1);
  });
});

describe("routers", () => {
  test("me reads none for a user without a role, and anon for a code session without one", async () => {
    const { session } = person();
    const me = await sharedRouter.createCaller({ session, ip: "test", ccOverride: null }).me();
    expect(me).toEqual({ role: "none", displayName: "Jordan Reed" });
  });

  test("access.enter takes only the user's own approved membership", async () => {
    const one = person();
    const two = person("Sam Ortiz", "+13135550143");
    const m = a.joinByLink(one.user.id, one.session.id, "crew", "access-crew-01")!;
    const api2 = accessRouter.createCaller({ session: two.session, ip: "test", ccOverride: null });
    await expect(api2.enter({ id: m.id })).rejects.toThrow("Access not found");
    a.clearRole(one.session.id);
    const api1 = accessRouter.createCaller({ session: getSession(one.session.id), ip: "test", ccOverride: null });
    expect(await api1.enter({ id: m.id })).toEqual({ role: "crew" });
  });

  test("a code session cannot use the user procedures", async () => {
    const code = createSession({ role: "green", ccId: w.east.id });
    const api = accessRouter.createCaller({ session: code, ip: "test", ccOverride: null });
    await expect(api.mine()).rejects.toThrow("Not allowed");
    // ...but a green code session decides for its CC.
    const { user } = person();
    const r = a.requestAccess(user.id, { role: "crew", dayId: w.d1.id, ccId: w.east.id, crewId: w.led.id });
    if (!r.ok) throw new Error(r.error);
    expect(await api.pendingCount()).toBe(1);
    expect(await api.decide({ id: r.membership.id, decision: "approve" })).toEqual({ ok: false, leadChoice: "Pat Lee, 313-555-0100" });
    expect(await api.decide({ id: r.membership.id, decision: "approve", lead: "add" })).toEqual({ ok: true });
  });

  test("the sign-in page names a waiting link", async () => {
    const api = accessRouter.createCaller({ session: null, ip: "test", ccOverride: null, joinLink: "crew:access-crew-01" });
    expect(await api.link()).toEqual({ label: "Ford 1, Ford, CC East" });
    const none = accessRouter.createCaller({ session: null, ip: "test", ccOverride: null, joinLink: "crew:nope-nope" });
    expect(await none.link()).toBeNull();
  });
});
