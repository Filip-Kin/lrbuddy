import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// SPEC 26: admin as a membership role, Admin access requests, /admin/people
// and invite links. The db module opens $DATA_DIR at import; set the env first.
const dir = mkdtempSync(join(tmpdir(), "lrbuddy-invites-test-"));
process.env.DATA_DIR = dir;
process.env.SESSION_SECRET ??= "test-secret";
process.env.OSRM_URL = "off";
process.env.VAPID_PUBLIC_KEY = "";
process.env.VAPID_PRIVATE_KEY = "";

const { db } = await import("./db/index.ts");
const s = await import("./db/schema.ts");
const setup = await import("./setup.ts");
const a = await import("./access.ts");
const inv = await import("./invites.ts");
const { createSession, getSession, isAdminSession } = await import("./auth.ts");
const { accessRouter } = await import("./routers/access.ts");
const { peopleRouter } = await import("./routers/people.ts");
const { invitesRouter } = await import("./routers/invites.ts");
const { adminRouter } = await import("./routers/admin.ts");
const { eq, and } = await import("drizzle-orm");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

// #region fixture
const HOUR = 3_600_000;

const world = () => {
  db.delete(s.events).run();
  db.delete(s.users).run();
  db.delete(s.sessions).run();
  db.delete(s.invites).run();
  // Day 1 is today in Detroit, so an invite's default expiry (the end of its day) is still ahead.
  const ev = setup.createEvent({ name: "Invites", year: 2026, startDate: a.detroitDate(), dayCount: 2, active: true });
  const [d1, d2] = db.select().from(s.days).where(eq(s.days.eventId, ev.id)).orderBy(s.days.sort).all();
  const east = setup.createCc({ dayId: d1!.id, name: "East", lat: 42.3786, lng: -82.9911 });
  const west = setup.createCc({ dayId: d1!.id, name: "West", lat: 42.3701, lng: -83.0209 });
  const east2 = setup.createCc({ dayId: d2!.id, name: "East", lat: 42.3786, lng: -82.9911 });
  const crew = setup.createCrew({ dayId: d1!.id, ccId: east.id, companyId: null });
  const westCrew = setup.createCrew({ dayId: d1!.id, ccId: west.id, companyId: null });
  const truck = setup.createTruck({ dayId: d1!.id, ccId: east.id, name: "Truck 1" });
  return { ev, d1: d1!, d2: d2!, east, west, east2, crew, westCrew, truck };
};
type World = ReturnType<typeof world>;

let n = 0;
/** A signed-in user with no role yet. */
const person = (name = "Jordan Reed") => {
  n += 1;
  const user = a.upsertUser({ uid: `inv-${n}`, phone: `+1313555${String(1000 + n)}`, email: `p${n}@test.example`, name: null }, name);
  const session = createSession({ role: "none", userId: user.id, displayName: user.name });
  return { user, session };
};

/** A user made admin the way the app does it, and their session in that role. */
const admin = (name = "Avery Admin") => {
  const p = person(name);
  const m = a.makeAdmin(p.user.id, null, "Test")!;
  a.enterMembership(p.session.id, m);
  return { ...p, session: getSession(p.session.id)! };
};

/** A green shirt user at a CC, in the role. */
const green = (ccId: number) => {
  const p = person("Gwen Green");
  const m = db
    .insert(s.memberships)
    .values({ userId: p.user.id, eventId: w.ev.id, role: "green", dayId: w.d1.id, ccId, status: "approved", requestedAt: 1, decidedAt: 1 })
    .returning()
    .get();
  a.enterMembership(p.session.id, m);
  return { ...p, session: getSession(p.session.id)! };
};

const greenBy = (ccId: number, userId: number) => ({ userId, admin: false, ccId });
const adminBy = (userId: number) => ({ userId, admin: true, ccId: null });
const sessionRow = (id: string) => db.select().from(s.sessions).where(eq(s.sessions.id, id)).get();
const ctxOf = (session: typeof s.sessions.$inferSelect | null) => ({ session, ip: "test", ccOverride: null });

let w: World;
beforeEach(() => {
  w = world();
});
// #endregion

describe("admin is a membership role", () => {
  test("an admin membership has no event or scope and opens the app in every event, and with none", () => {
    const p = person();
    const m = a.makeAdmin(p.user.id, null, "Test")!;
    expect(m).toMatchObject({ role: "admin", eventId: null, dayId: null, ccId: null, status: "approved" });
    expect(a.resolveSession(p.session.id, p.user.id)).toBe("entered");
    expect(sessionRow(p.session.id)?.role).toBe("admin");
    // Another event becomes active: still admin.
    setup.createEvent({ name: "Next", year: 2027, startDate: "2027-09-27", dayCount: 1, active: true });
    expect(a.candidates(p.user.id).map((c) => c.id)).toEqual([m.id]);
    db.update(s.events).set({ active: false }).run();
    expect(a.candidates(p.user.id).map((c) => c.id)).toEqual([m.id]);
  });

  test("makeAdmin is idempotent", () => {
    const p = person();
    const one = a.makeAdmin(p.user.id, null, "Test")!;
    const two = a.makeAdmin(p.user.id, null, "Test")!;
    expect(two.id).toBe(one.id);
    expect(db.select().from(s.memberships).where(eq(s.memberships.userId, p.user.id)).all()).toHaveLength(1);
  });

  test("an admin session without an admin membership is not admin anywhere", async () => {
    const userless = createSession({ role: "admin", displayName: "Old password session" });
    expect(isAdminSession(userless)).toBe(false);
    await expect(adminRouter.createCaller(ctxOf(userless)).events.list()).rejects.toThrow("Not allowed");
    // Reading it back ends a session with no user and drops a user's to no role.
    expect(getSession(userless.id)).toBeNull();
    expect(sessionRow(userless.id)).toBeUndefined();
    const p = person();
    db.update(s.sessions).set({ role: "admin" }).where(eq(s.sessions.id, p.session.id)).run();
    expect(getSession(p.session.id)?.role).toBe("none");
    const ok = admin();
    expect(isAdminSession(ok.session)).toBe(true);
    expect(await adminRouter.createCaller(ctxOf(ok.session)).events.list()).toBeArray();
  });
});

describe("Admin access requests", () => {
  test("a user asks for Admin; a green shirt cannot see or decide it, an admin approves and the waiting phone becomes admin", async () => {
    const boss = admin();
    const g = green(w.east.id);
    const asker = person("Riley Ask");
    const r = await accessRouter.createCaller(ctxOf(asker.session)).request({ role: "admin" });
    expect(r.status).toBe("pending");
    const row = db.select().from(s.memberships).where(eq(s.memberships.id, r.id)).get()!;
    expect(row).toMatchObject({ role: "admin", eventId: null, ccId: null, dayId: null });

    // Green shirts: not in their queue, and deciding it is refused as unknown.
    const greenCaller = accessRouter.createCaller({ ...ctxOf(g.session) });
    expect((await greenCaller.pending()).pending.map((v) => v.id)).not.toContain(r.id);
    await expect(greenCaller.decide({ id: r.id, decision: "approve" })).rejects.toThrow("Request not found");
    expect(a.decide(r.id, "approve", { userId: g.user.id, ccId: null, admin: false }).ok).toBe(false);
    expect(db.select().from(s.memberships).where(eq(s.memberships.id, r.id)).get()?.status).toBe("pending");

    // Admin: listed and decided.
    const adminCaller = accessRouter.createCaller(ctxOf(boss.session));
    expect((await adminCaller.adminPending()).pending.map((v) => v.id)).toContain(r.id);
    expect(await adminCaller.adminDecide({ id: r.id, decision: "approve" })).toEqual({ ok: true });
    expect(sessionRow(asker.session.id)?.role).toBe("admin");
    expect(a.adminUserIds()).toContain(asker.user.id);
  });

  test("asking for Admin again while pending keeps one row", () => {
    const p = person();
    const one = a.requestAccess(p.user.id, { role: "admin" });
    const two = a.requestAccess(p.user.id, { role: "admin" });
    expect(one.ok && two.ok && one.membership.id === two.membership.id).toBe(true);
    expect(two.ok && two.created).toBe(false);
  });
});

describe("/admin/people", () => {
  test("search by name, phone digits or email; admins first", async () => {
    const boss = admin("Avery Admin");
    person("Jordan Reed");
    const caller = peopleRouter.createCaller(ctxOf(boss.session));
    const all = (await caller.list({ q: "" })).people;
    expect(all[0]?.admin).toBe(true);
    expect((await caller.list({ q: "jordan" })).people.map((p) => p.name)).toEqual(["Jordan Reed"]);
    const jordan = (await caller.list({ q: "jordan" })).people[0]!;
    expect((await caller.list({ q: jordan.phone!.slice(-6) })).people.map((p) => p.id)).toEqual([jordan.id]);
    expect((await caller.list({ q: jordan.email! })).people.map((p) => p.id)).toEqual([jordan.id]);
    expect((await caller.list({ q: "" })).admins).toBe(1);
  });

  test("Make admin, Remove admin; removing drops the person's admin sessions at once", async () => {
    const boss = admin();
    const other = person("Sam Second");
    const caller = peopleRouter.createCaller(ctxOf(boss.session));
    await caller.makeAdmin({ userId: other.user.id });
    expect(a.resolveSession(other.session.id, other.user.id)).toBe("entered");
    expect(sessionRow(other.session.id)?.role).toBe("admin");
    await caller.removeAdmin({ userId: other.user.id });
    expect(sessionRow(other.session.id)?.role).toBe("none");
    expect(a.adminUserIds()).not.toContain(other.user.id);
  });

  test("the last admin cannot be removed, not even by themself", async () => {
    const boss = admin();
    const caller = peopleRouter.createCaller(ctxOf(boss.session));
    await expect(caller.removeAdmin({ userId: boss.user.id })).rejects.toThrow("Last admin");
    expect(a.removeAdmin(boss.user.id)).toEqual({ ok: false, error: "Last admin" });
    expect(a.adminUserIds()).toEqual([boss.user.id]);
    const two = admin("Second");
    expect(a.removeAdmin(boss.user.id)).toEqual({ ok: true });
    expect(a.removeAdmin(two.user.id)).toEqual({ ok: false, error: "Last admin" });
  });

  test("people is admin only", async () => {
    const g = green(w.east.id);
    await expect(peopleRouter.createCaller(ctxOf(g.session)).list({ q: "" })).rejects.toThrow("Not allowed");
  });
});

describe("invites: who may invite to what", () => {
  test("a green shirt invites a red shirt, driver or green shirt at their own CC only", () => {
    const g = green(w.east.id);
    const by = greenBy(w.east.id, g.user.id);
    expect(inv.createInvite(by, { role: "crew", crewId: w.crew.id }).ok).toBe(true);
    expect(inv.createInvite(by, { role: "driver", truckId: w.truck.id }).ok).toBe(true);
    expect(inv.createInvite(by, { role: "green" }).ok).toBe(true);
    // Another CC, another day's CC, a crew from another CC, admin: refused.
    expect(inv.createInvite(by, { role: "green", ccId: w.west.id })).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(inv.createInvite(by, { role: "green", ccId: w.east2.id })).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(inv.createInvite(by, { role: "crew", crewId: w.westCrew.id })).toMatchObject({ ok: false, code: "BAD_REQUEST" });
    expect(inv.createInvite(by, { role: "admin" })).toMatchObject({ ok: false, code: "FORBIDDEN" });
  });

  test("an admin invites to any role and scope; an admin invite lasts 7 days by default", () => {
    const boss = admin();
    const by = adminBy(boss.user.id);
    const now = Date.parse("2026-09-28T16:00:00Z");
    expect(inv.createInvite(by, { role: "green", ccId: w.west.id }, now).ok).toBe(true);
    expect(inv.createInvite(by, { role: "crew", ccId: w.west.id, crewId: w.westCrew.id }, now).ok).toBe(true);
    const r = inv.createInvite(by, { role: "admin" }, now);
    expect(r.ok && r.invite).toMatchObject({ role: "admin", eventId: null, ccId: null, expiresAt: now + 7 * 24 * HOUR });
    expect(inv.createInvite(by, { role: "crew", ccId: w.west.id }, now)).toMatchObject({ ok: false, error: "Choose a crew" });
  });

  test("the invite procedures refuse a green code session and a red shirt", async () => {
    const codeGreen = createSession({ role: "green", ccId: w.east.id, displayName: "Green shirt" });
    await expect(invitesRouter.createCaller(ctxOf(codeGreen)).list()).rejects.toThrow("Not allowed");
    const red = createSession({ role: "crew", crewId: w.crew.id, ccId: w.east.id });
    await expect(invitesRouter.createCaller(ctxOf(red)).create({ role: "crew", crewId: w.crew.id })).rejects.toThrow("Not allowed");
  });

  test("a green's options and list are their own CC", async () => {
    const g = green(w.east.id);
    const boss = admin();
    inv.createInvite(adminBy(boss.user.id), { role: "green", ccId: w.west.id });
    inv.createInvite(greenBy(w.east.id, g.user.id), { role: "green" });
    const caller = invitesRouter.createCaller(ctxOf(g.session));
    const opts = await caller.options();
    expect(opts.days.flatMap((d) => d.ccs.map((c) => c.id))).toEqual([w.east.id]);
    expect((await caller.list()).map((i) => i.label)).toEqual(["Green shirt, CC East"]);
    expect((await invitesRouter.createCaller(ctxOf(boss.session)).list()).length).toBe(2);
  });
});

describe("invites: opening one", () => {
  test("default expiry is the end of that day in Detroit; a day already over needs another expiry", () => {
    const g = green(w.east.id);
    const r = inv.createInvite(greenBy(w.east.id, g.user.id), { role: "green" });
    expect(r.ok && r.invite.expiresAt).toBe(inv.endOfDetroitDay(w.d1.date));
    // 2026-09-28 ends at midnight EDT, 04:00 UTC on the 29th; 2026-11-01 (EST from that morning) at 05:00 UTC on the 2nd.
    expect(inv.endOfDetroitDay("2026-09-28")).toBe(Date.parse("2026-09-29T04:00:00Z"));
    expect(inv.endOfDetroitDay("2026-11-01")).toBe(Date.parse("2026-11-02T05:00:00Z"));
    const after = inv.endOfDetroitDay(w.d1.date) + 1000;
    expect(inv.createInvite(greenBy(w.east.id, g.user.id), { role: "green" }, after)).toMatchObject({ ok: false, code: "BAD_REQUEST" });
    expect(inv.createInvite(greenBy(w.east.id, g.user.id), { role: "green", expiry: "1d" }, after).ok).toBe(true);
  });

  test("accepting grants the membership and lands the session in it", () => {
    const g = green(w.east.id);
    const r = inv.createInvite(greenBy(w.east.id, g.user.id), { role: "crew", crewId: w.crew.id, name: "Pat" });
    if (!r.ok) throw new Error(r.error);
    const p = person();
    const res = inv.acceptInvite(p.user.id, p.session.id, r.invite.token);
    expect(res.ok && res.membership).toMatchObject({ role: "crew", crewId: w.crew.id, status: "approved", note: "Invite" });
    expect(sessionRow(p.session.id)).toMatchObject({ role: "crew", crewId: w.crew.id, ccId: w.east.id });
    expect(inv.inviteByToken(r.invite.token)?.uses).toBe(1);
  });

  test("an admin invite makes the person an admin", () => {
    const boss = admin();
    const r = inv.createInvite(adminBy(boss.user.id), { role: "admin" });
    if (!r.ok) throw new Error(r.error);
    const p = person();
    expect(inv.acceptInvite(p.user.id, p.session.id, r.invite.token).ok).toBe(true);
    expect(sessionRow(p.session.id)?.role).toBe("admin");
    expect(a.adminUserIds()).toContain(p.user.id);
  });

  test("single use: the second person is refused as used; unlimited takes many", () => {
    const g = green(w.east.id);
    const one = inv.createInvite(greenBy(w.east.id, g.user.id), { role: "green", singleUse: true });
    const many = inv.createInvite(greenBy(w.east.id, g.user.id), { role: "green" });
    if (!one.ok || !many.ok) throw new Error("create");
    const p1 = person();
    const p2 = person();
    expect(inv.acceptInvite(p1.user.id, p1.session.id, one.invite.token).ok).toBe(true);
    expect(inv.acceptInvite(p2.user.id, p2.session.id, one.invite.token)).toEqual({ ok: false, state: "used" });
    expect(sessionRow(p2.session.id)?.role).toBe("none");
    for (let i = 0; i < 4; i++) {
      const p = person();
      expect(inv.acceptInvite(p.user.id, p.session.id, many.invite.token).ok).toBe(true);
    }
    expect(inv.inviteByToken(many.invite.token)?.uses).toBe(4);
  });

  test("expired and revoked invites are refused and grant nothing", () => {
    const g = green(w.east.id);
    const by = greenBy(w.east.id, g.user.id);
    const old = inv.createInvite(by, { role: "green", expiry: "1d" });
    const gone = inv.createInvite(by, { role: "green" });
    if (!old.ok || !gone.ok) throw new Error("create");
    const p = person();
    expect(inv.acceptInvite(p.user.id, p.session.id, old.invite.token, Date.now() + 25 * HOUR)).toEqual({ ok: false, state: "expired" });
    expect(inv.revokeInvite(by, gone.invite.id)).toBe(true);
    expect(inv.acceptInvite(p.user.id, p.session.id, gone.invite.token)).toEqual({ ok: false, state: "revoked" });
    expect(inv.acceptInvite(p.user.id, p.session.id, "no-such-token")).toEqual({ ok: false, state: "unknown" });
    expect(db.select().from(s.memberships).where(and(eq(s.memberships.userId, p.user.id))).all()).toHaveLength(0);
    expect(inv.inviteByToken(old.invite.token)?.uses).toBe(0);
  });

  test("a green cannot revoke another CC's invite; an admin can revoke any", () => {
    const boss = admin();
    const gEast = green(w.east.id);
    const r = inv.createInvite(adminBy(boss.user.id), { role: "green", ccId: w.west.id });
    if (!r.ok) throw new Error(r.error);
    expect(inv.revokeInvite(greenBy(w.east.id, gEast.user.id), r.invite.id)).toBe(false);
    expect(inv.inviteByToken(r.invite.token)?.revokedAt).toBeNull();
    expect(inv.revokeInvite(adminBy(boss.user.id), r.invite.id)).toBe(true);
    expect(inv.stateOf(inv.inviteByToken(r.invite.token)!)).toBe("revoked");
  });
});
