/**
 * Users, memberships and the session a user acts under (SPEC 18). Routes and
 * routers stay thin; the rules live here so the tests can call them directly.
 */
import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { cleanPhone } from "./auth.ts";
import { bus } from "./bus.ts";
import { db } from "./db/index.ts";
import {
  commandCenters,
  companies,
  crews,
  days,
  greenCodes,
  greenShirts,
  memberships,
  sessions,
  trucks,
  users,
  type Membership,
  type MembershipStatus,
  type Role,
  type User,
} from "./db/schema.ts";
import { crewLabel } from "./dispatch.ts";
import type { VerifiedToken } from "./firebase.ts";
import { sendToSessions } from "./push.ts";
import { activeEvent } from "./queries.ts";

// #region labels and days
export const ROLE_LABEL: Record<Role, string> = { crew: "Red shirt", driver: "Driver", green: "Green shirt", admin: "Admin" };

/** The calendar date in Detroit, YYYY-MM-DD. */
export const detroitDate = (at = Date.now()): string => new Date(at).toLocaleDateString("sv-SE", { timeZone: "America/Detroit" });

const dayIdsWithCcs = (eventId: number): Set<number> =>
  new Set(
    db
      .select({ dayId: commandCenters.dayId })
      .from(commandCenters)
      .innerJoin(days, eq(days.id, commandCenters.dayId))
      .where(eq(days.eventId, eventId))
      .all()
      .map((r) => r.dayId),
  );

/**
 * The event day that is today in Detroit, when it has a command center set
 * up. Null on any other date: before and after the event, and on a day with
 * nothing to staff.
 */
export const currentDayId = (eventId: number, at = Date.now()): number | null => {
  const today = detroitDate(at);
  const day = db.select().from(days).where(and(eq(days.eventId, eventId), eq(days.date, today))).get();
  return day && dayIdsWithCcs(eventId).has(day.id) ? day.id : null;
};
// #endregion

// #region users
const cleanName = (n: string | null | undefined): string | null => {
  const v = n?.trim().replace(/\s+/g, " ").slice(0, 60);
  return v ? v : null;
};

/**
 * Creates or updates the user behind a verified token. A name typed on the
 * sign-in form wins over the one Google gives; phone and email follow the token.
 */
export const upsertUser = (token: VerifiedToken, typedName?: string | null, now = Date.now()): User => {
  const name = cleanName(typedName);
  const existing = db.select().from(users).where(eq(users.firebaseUid, token.uid)).get();
  if (existing) {
    return db
      .update(users)
      .set({
        name: name ?? existing.name ?? cleanName(token.name),
        phone: token.phone ?? existing.phone,
        email: token.email ?? existing.email,
        lastSeenAt: now,
      })
      .where(eq(users.id, existing.id))
      .returning()
      .get();
  }
  return db
    .insert(users)
    .values({ firebaseUid: token.uid, name: name ?? cleanName(token.name), phone: token.phone, email: token.email, createdAt: now, lastSeenAt: now })
    .returning()
    .get();
};

export const userById = (id: number): User | null => db.select().from(users).where(eq(users.id, id)).get() ?? null;
// #endregion

// #region views
export interface MembershipView {
  id: number;
  role: Role;
  roleLabel: string;
  status: MembershipStatus;
  dayId: number | null;
  dayLabel: string | null;
  dayDate: string | null;
  ccId: number | null;
  ccName: string | null;
  crewId: number | null;
  crewName: string | null;
  companyName: string | null;
  truckId: number | null;
  truckName: string | null;
  /** "Crew 7, Ford" or "Truck 2"; null for a green shirt or admin. */
  target: string | null;
  requestedAt: number;
  decidedAt: number | null;
  user: { id: number; name: string | null; phone: string | null; email: string | null };
  /** For a red shirt: the crew's current lead, when it has one. Approving asks Replace or Add. */
  crewLead: string | null;
}

export const membershipViews = (rows: readonly Membership[]): MembershipView[] => {
  if (rows.length === 0) return [];
  const ids = <K extends keyof Membership>(k: K): number[] => [...new Set(rows.map((r) => r[k]).filter((v): v is NonNullable<typeof v> & number => typeof v === "number"))];
  const dayMap = new Map(ids("dayId").length ? db.select().from(days).where(inArray(days.id, ids("dayId"))).all().map((d) => [d.id, d]) : []);
  const ccMap = new Map(ids("ccId").length ? db.select().from(commandCenters).where(inArray(commandCenters.id, ids("ccId"))).all().map((c) => [c.id, c]) : []);
  const crewMap = new Map(
    ids("crewId").length
      ? db
          .select({ crew: crews, company: companies })
          .from(crews)
          .leftJoin(companies, eq(companies.id, crews.companyId))
          .where(inArray(crews.id, ids("crewId")))
          .all()
          .map((r) => [r.crew.id, r])
      : [],
  );
  const truckMap = new Map(ids("truckId").length ? db.select().from(trucks).where(inArray(trucks.id, ids("truckId"))).all().map((t) => [t.id, t]) : []);
  const userMap = new Map(db.select().from(users).where(inArray(users.id, ids("userId"))).all().map((u) => [u.id, u]));
  return rows.map((m) => {
    const day = m.dayId !== null ? dayMap.get(m.dayId) : undefined;
    const cc = m.ccId !== null ? ccMap.get(m.ccId) : undefined;
    const crew = m.crewId !== null ? crewMap.get(m.crewId) : undefined;
    const truck = m.truckId !== null ? truckMap.get(m.truckId) : undefined;
    const u = userMap.get(m.userId);
    const crewName = crew ? crewLabel(crew.crew) : null;
    const companyName = crew?.company?.name ?? null;
    const lead = crew ? [crew.crew.leadName?.trim(), crew.crew.leadPhone?.trim()].filter(Boolean).join(", ") : "";
    return {
      id: m.id,
      role: m.role,
      roleLabel: ROLE_LABEL[m.role],
      status: m.status,
      dayId: m.dayId,
      dayLabel: day?.label ?? null,
      dayDate: day?.date ?? null,
      ccId: m.ccId,
      ccName: cc?.name ?? null,
      crewId: m.crewId,
      crewName,
      companyName,
      truckId: m.truckId,
      truckName: truck?.name ?? null,
      target: crewName ? [crewName, companyName].filter(Boolean).join(", ") : (truck?.name ?? null),
      requestedAt: m.requestedAt,
      decidedAt: m.decidedAt,
      user: { id: m.userId, name: u?.name ?? null, phone: u?.phone ?? null, email: u?.email ?? null },
      crewLead: lead || null,
    };
  });
};

/** "Jordan Reed, Red shirt, Crew 7 Ford", the push line for a new request. */
export const requestLine = (v: MembershipView): string =>
  [v.user.name ?? v.user.phone ?? v.user.email ?? "No name", v.roleLabel, v.crewName ? [v.crewName, v.companyName].filter(Boolean).join(" ") : v.truckName]
    .filter(Boolean)
    .join(", ");
// #endregion

// #region sessions
/**
 * Puts a session into an approved membership: the role and scope it names,
 * exactly as a code login would have set them, with the user's name.
 */
export const enterMembership = (sessionId: string, m: Membership): boolean => {
  if (m.status !== "approved") return false;
  let ccId = m.ccId;
  if (m.role === "crew" && m.crewId !== null) ccId = db.select({ ccId: crews.ccId }).from(crews).where(eq(crews.id, m.crewId)).get()?.ccId ?? null;
  if (m.role === "driver" && m.truckId !== null) ccId = db.select({ ccId: trucks.ccId }).from(trucks).where(eq(trucks.id, m.truckId)).get()?.ccId ?? null;
  if (m.role !== "admin" && ccId === null) return false;
  const name = userById(m.userId)?.name ?? null;
  db.update(sessions)
    .set({
      role: m.role,
      membershipId: m.id,
      crewId: m.role === "crew" ? m.crewId : null,
      truckId: m.role === "driver" ? m.truckId : null,
      ccId: m.role === "admin" ? null : ccId,
      displayName: name,
    })
    .where(eq(sessions.id, sessionId))
    .run();
  bus.checkScopes();
  return true;
};

/** Takes a user session out of its role, back to the access screen. */
export const clearRole = (sessionId: string): void => {
  db.update(sessions).set({ role: "none", membershipId: null, crewId: null, truckId: null, ccId: null }).where(eq(sessions.id, sessionId)).run();
  bus.checkScopes();
};

/**
 * Approved memberships the session may enter now. On an event day with a
 * command center, today's (and any without a day, such as admin); on any
 * other date every approved one in the active event, so the app is usable
 * before the event and in the demo.
 */
export const candidates = (userId: number, at = Date.now()): Membership[] => {
  const ev = activeEvent();
  if (!ev) return [];
  const approved = db
    .select()
    .from(memberships)
    .where(and(eq(memberships.userId, userId), eq(memberships.eventId, ev.id), eq(memberships.status, "approved")))
    .orderBy(desc(memberships.decidedAt), desc(memberships.id))
    .all();
  const today = currentDayId(ev.id, at);
  return today === null ? approved : approved.filter((m) => m.dayId === null || m.dayId === today);
};

export type Resolution = "entered" | "choose" | "request";

/** One candidate: in. Several: the chooser. None: the request screen. */
export const resolveSession = (sessionId: string, userId: number, at = Date.now()): Resolution => {
  const list = candidates(userId, at);
  if (list.length === 1 && enterMembership(sessionId, list[0]!)) return "entered";
  return list.length > 1 ? "choose" : "request";
};
// #endregion

// #region contacts
/**
 * Writes the user onto the thing the membership names: a red shirt becomes
 * the crew's lead (only when blank unless `replace`), a driver fills a blank
 * driver name and phone, a green shirt joins the CC's green shirt list.
 */
const applyContact = (m: Membership, user: User, mode: "fill" | "replace" | "add"): void => {
  const name = user.name;
  const phone = cleanPhone(user.phone);
  if (m.role === "crew" && m.crewId !== null && mode !== "add") {
    const crew = db.select().from(crews).where(eq(crews.id, m.crewId)).get();
    if (!crew) return;
    if (mode === "replace") {
      db.update(crews).set({ leadName: name, leadPhone: phone }).where(eq(crews.id, crew.id)).run();
    } else if (!crew.leadName?.trim() && !crew.leadPhone?.trim()) {
      db.update(crews).set({ leadName: name, leadPhone: phone }).where(eq(crews.id, crew.id)).run();
    }
  } else if (m.role === "driver" && m.truckId !== null) {
    const truck = db.select().from(trucks).where(eq(trucks.id, m.truckId)).get();
    if (!truck) return;
    db.update(trucks)
      .set({ driverName: truck.driverName?.trim() ? truck.driverName : name, driverPhone: truck.driverPhone?.trim() ? truck.driverPhone : phone })
      .where(eq(trucks.id, truck.id))
      .run();
  } else if (m.role === "green" && m.ccId !== null && name) {
    const digits = (v: string | null): string => (v ?? "").replace(/\D/g, "").slice(-10);
    const listed = db
      .select()
      .from(greenShirts)
      .where(eq(greenShirts.ccId, m.ccId))
      .all()
      .some((g) => (phone && digits(g.phone) === digits(phone)) || g.name.trim().toLowerCase() === name.toLowerCase());
    if (!listed) db.insert(greenShirts).values({ ccId: m.ccId, name, phone, roleLabel: null }).run();
  }
};
// #endregion

// #region targets
export type LinkKind = "crew" | "truck" | "cc";

interface Target {
  role: Role;
  eventId: number;
  dayId: number;
  ccId: number;
  crewId: number | null;
  truckId: number | null;
}

const eventOfDay = (dayId: number): number | null => db.select({ eventId: days.eventId }).from(days).where(eq(days.id, dayId)).get()?.eventId ?? null;

/** What a printed QR names: `/j/<crew token>`, `/t/<truck code>`, `/g/<green code>`. */
export const linkTarget = (kind: LinkKind, raw: string): Target | null => {
  if (kind === "crew") {
    const crew = db.select().from(crews).where(eq(crews.token, raw)).get();
    const eventId = crew ? eventOfDay(crew.dayId) : null;
    return crew && eventId !== null ? { role: "crew", eventId, dayId: crew.dayId, ccId: crew.ccId, crewId: crew.id, truckId: null } : null;
  }
  const code = raw.trim().toUpperCase();
  if (kind === "truck") {
    const truck = db.select().from(trucks).where(eq(trucks.code, code)).get();
    const eventId = truck ? eventOfDay(truck.dayId) : null;
    return truck && eventId !== null ? { role: "driver", eventId, dayId: truck.dayId, ccId: truck.ccId, crewId: null, truckId: truck.id } : null;
  }
  const green = db.select().from(greenCodes).where(eq(greenCodes.code, code)).get();
  const cc = green ? db.select().from(commandCenters).where(eq(commandCenters.id, green.ccId)).get() : undefined;
  const eventId = cc ? eventOfDay(cc.dayId) : null;
  return cc && eventId !== null ? { role: "green", eventId, dayId: cc.dayId, ccId: cc.id, crewId: null, truckId: null } : null;
};

/** "Crew 7, Ford, CC East" for the sign-in page while a scanned link waits. */
export const linkLabel = (kind: LinkKind, raw: string): string | null => {
  const t = linkTarget(kind, raw);
  if (!t) return null;
  const cc = db.select({ name: commandCenters.name }).from(commandCenters).where(eq(commandCenters.id, t.ccId)).get();
  const ccText = cc ? `CC ${cc.name}` : null;
  if (t.crewId !== null) {
    const row = db.select({ crew: crews, company: companies }).from(crews).leftJoin(companies, eq(companies.id, crews.companyId)).where(eq(crews.id, t.crewId)).get();
    return row ? [crewLabel(row.crew), row.company?.name, ccText].filter(Boolean).join(", ") : null;
  }
  if (t.truckId !== null) {
    const truck = db.select({ name: trucks.name }).from(trucks).where(eq(trucks.id, t.truckId)).get();
    return [truck?.name, ccText].filter(Boolean).join(", ");
  }
  return ["Green shirt", ccText].filter(Boolean).join(", ");
};

/** The user's row for exactly this role and place, whatever its status. */
const sameTarget = (userId: number, t: Target): Membership | undefined =>
  db
    .select()
    .from(memberships)
    .where(
      and(
        eq(memberships.userId, userId),
        eq(memberships.role, t.role),
        eq(memberships.dayId, t.dayId),
        eq(memberships.ccId, t.ccId),
        t.crewId !== null ? eq(memberships.crewId, t.crewId) : eq(memberships.role, t.role),
        t.truckId !== null ? eq(memberships.truckId, t.truckId) : eq(memberships.role, t.role),
      ),
    )
    .get();

const emitChanged = (m: Membership): void => {
  bus.emit("membership.changed", { ccId: m.ccId, dayId: m.dayId }, { membershipId: m.id, userId: m.userId, status: m.status });
};
// #endregion

// #region join by link
/**
 * A scanned QR after sign-in: an approved membership for that crew, truck or
 * CC, and the session moved into it. Scanning again reuses the same row; a
 * pending or denied request for the same place becomes approved.
 */
export const joinByLink = (userId: number, sessionId: string, kind: LinkKind, raw: string, now = Date.now()): Membership | null => {
  const t = linkTarget(kind, raw);
  const user = userById(userId);
  if (!t || !user) return null;
  const existing = sameTarget(userId, t);
  let m: Membership;
  if (existing) {
    m =
      existing.status === "approved"
        ? existing
        : db.update(memberships).set({ status: "approved", decidedAt: now, decidedByUserId: null, note: "QR" }).where(eq(memberships.id, existing.id)).returning().get();
  } else {
    m = db
      .insert(memberships)
      .values({ userId, eventId: t.eventId, role: t.role, dayId: t.dayId, ccId: t.ccId, crewId: t.crewId, truckId: t.truckId, status: "approved", requestedAt: now, decidedAt: now, note: "QR" })
      .returning()
      .get();
  }
  // Any other request still open for this role and day is answered by the scan.
  db.delete(memberships)
    .where(and(eq(memberships.userId, userId), eq(memberships.role, t.role), eq(memberships.dayId, t.dayId), eq(memberships.status, "pending"), ne(memberships.id, m.id)))
    .run();
  applyContact(m, user, "fill");
  enterMembership(sessionId, m);
  emitChanged(m);
  return m;
};
// #endregion

// #region requests
export interface AccessRequest {
  role: "crew" | "driver" | "green";
  dayId: number;
  ccId: number;
  crewId?: number | null;
  truckId?: number | null;
}

export type RequestResult = { ok: true; membership: Membership; created: boolean } | { ok: false; error: string };

/**
 * A request from the access screen. Checks that the day is in the active
 * event, the CC is on that day and the crew or truck is at that CC. Asking
 * again for the same place returns the same row; a new choice for the same
 * role and day replaces a request still pending, so a wrong pick is fixed by
 * picking again.
 */
export const requestAccess = (userId: number, input: AccessRequest, now = Date.now()): RequestResult => {
  const ev = activeEvent();
  if (!ev) return { ok: false, error: "No event" };
  const day = db.select().from(days).where(and(eq(days.id, input.dayId), eq(days.eventId, ev.id))).get();
  if (!day) return { ok: false, error: "Day not found" };
  const cc = db.select().from(commandCenters).where(and(eq(commandCenters.id, input.ccId), eq(commandCenters.dayId, day.id))).get();
  if (!cc) return { ok: false, error: "Command center not found" };
  let crewId: number | null = null;
  let truckId: number | null = null;
  if (input.role === "crew") {
    const crew = input.crewId ? db.select().from(crews).where(and(eq(crews.id, input.crewId), eq(crews.ccId, cc.id))).get() : undefined;
    if (!crew) return { ok: false, error: "Choose a crew" };
    crewId = crew.id;
  } else if (input.role === "driver") {
    const truck = input.truckId ? db.select().from(trucks).where(and(eq(trucks.id, input.truckId), eq(trucks.ccId, cc.id))).get() : undefined;
    if (!truck) return { ok: false, error: "Choose a truck" };
    truckId = truck.id;
  }
  const t: Target = { role: input.role, eventId: ev.id, dayId: day.id, ccId: cc.id, crewId, truckId };
  const existing = sameTarget(userId, t);
  if (existing && existing.status !== "denied") return { ok: true, membership: existing, created: false };
  db.delete(memberships)
    .where(and(eq(memberships.userId, userId), eq(memberships.role, t.role), eq(memberships.dayId, t.dayId), eq(memberships.status, "pending")))
    .run();
  const m = existing
    ? db.update(memberships).set({ status: "pending", requestedAt: now, decidedAt: null, decidedByUserId: null, note: null }).where(eq(memberships.id, existing.id)).returning().get()
    : db
        .insert(memberships)
        .values({ userId, eventId: ev.id, role: t.role, dayId: t.dayId, ccId: t.ccId, crewId, truckId, status: "pending", requestedAt: now })
        .returning()
        .get();
  emitChanged(m);
  const view = membershipViews([m])[0];
  if (view) pushToCcGreens(cc.id, { title: "Access request", body: requestLine(view), url: "/access", tag: `access-${m.id}` });
  return { ok: true, membership: m, created: true };
};

/** Withdraws the user's own pending request. */
export const cancelRequest = (userId: number, id: number): boolean => {
  const m = db.select().from(memberships).where(and(eq(memberships.id, id), eq(memberships.userId, userId), eq(memberships.status, "pending"))).get();
  if (!m) return false;
  db.delete(memberships).where(eq(memberships.id, m.id)).run();
  emitChanged({ ...m, status: "denied" });
  return true;
};

/** Green shirt sessions at the CC (code or user), for a new access request. */
const pushToCcGreens = (ccId: number, payload: { title: string; body: string; url: string; tag: string }): void => {
  const ids = db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.role, "green"), eq(sessions.ccId, ccId)))
    .all()
    .map((r) => r.id);
  void sendToSessions(ids, payload);
};
// #endregion

// #region decisions
export interface Decider {
  /** The deciding user, when the session has one. */
  userId: number | null;
  /** A green shirt decides for this CC only; null for admin. */
  ccId: number | null;
}

export type DecideResult =
  | { ok: true; membership: Membership }
  | { ok: false; code: "NOT_FOUND" | "CONFLICT" }
  /** Approving a red shirt for a crew that has a lead: ask Replace lead or Add. */
  | { ok: false; code: "LEAD_CHOICE"; lead: string };

/**
 * Approve or deny a pending request. A red shirt for a crew with a lead
 * needs `lead`: `replace` makes the requester the lead, `add` leaves the lead
 * alone. On approval, any of the user's sessions still waiting on the access
 * screen move into the membership at once.
 */
export const decide = (id: number, decision: "approve" | "deny", by: Decider, lead?: "replace" | "add", now = Date.now()): DecideResult => {
  const m = db.select().from(memberships).where(eq(memberships.id, id)).get();
  if (!m || (by.ccId !== null && m.ccId !== by.ccId)) return { ok: false, code: "NOT_FOUND" };
  if (m.status !== "pending") return { ok: false, code: "CONFLICT" };
  const user = userById(m.userId);
  if (!user) return { ok: false, code: "NOT_FOUND" };
  if (decision === "approve" && m.role === "crew" && !lead) {
    const view = membershipViews([m])[0];
    if (view?.crewLead) return { ok: false, code: "LEAD_CHOICE", lead: view.crewLead };
  }
  const status: MembershipStatus = decision === "approve" ? "approved" : "denied";
  const row = db.update(memberships).set({ status, decidedAt: now, decidedByUserId: by.userId }).where(eq(memberships.id, m.id)).returning().get();
  if (status === "approved") {
    applyContact(row, user, lead ?? "fill");
    const waiting = db
      .select({ id: sessions.id })
      .from(sessions)
      .where(and(eq(sessions.userId, user.id), eq(sessions.role, "none")))
      .all();
    for (const s of waiting) enterMembership(s.id, row);
  }
  emitChanged(row);
  return { ok: true, membership: row };
};

/** Pending requests for one CC, or every CC of the active event for admin. Oldest first. */
export const pendingRequests = (ccId: number | null): MembershipView[] => {
  const ev = activeEvent();
  if (!ev) return [];
  const rows = db
    .select()
    .from(memberships)
    .where(and(eq(memberships.eventId, ev.id), eq(memberships.status, "pending"), ccId !== null ? eq(memberships.ccId, ccId) : undefined))
    .orderBy(memberships.requestedAt)
    .all();
  return membershipViews(rows);
};

/** The latest decisions, newest first, for the lower half of the Access page. */
export const recentDecisions = (ccId: number | null, limit = 20): MembershipView[] => {
  const ev = activeEvent();
  if (!ev) return [];
  const rows = db
    .select()
    .from(memberships)
    .where(and(eq(memberships.eventId, ev.id), ne(memberships.status, "pending"), ccId !== null ? eq(memberships.ccId, ccId) : undefined))
    .orderBy(desc(memberships.decidedAt), desc(memberships.id))
    .limit(limit)
    .all();
  return membershipViews(rows);
};
// #endregion

// #region the user's own view
export const greenContacts = (ccId: number): Array<{ name: string; phone: string | null; roleLabel: string | null }> =>
  db
    .select({ name: greenShirts.name, phone: greenShirts.phone, roleLabel: greenShirts.roleLabel })
    .from(greenShirts)
    .where(eq(greenShirts.ccId, ccId))
    .orderBy(greenShirts.id)
    .all();

/** Everything the access screen shows a signed-in user. */
export const mine = (userId: number, at = Date.now()) => {
  const ev = activeEvent();
  const user = userById(userId);
  const rows = ev
    ? db
        .select()
        .from(memberships)
        .where(and(eq(memberships.userId, userId), eq(memberships.eventId, ev.id)))
        .orderBy(desc(memberships.requestedAt), desc(memberships.id))
        .all()
    : [];
  const views = membershipViews(rows);
  const open = new Set(candidates(userId, at).map((m) => m.id));
  return {
    user: user ? { name: user.name, phone: user.phone, email: user.email } : null,
    pending: views.filter((v) => v.status === "pending").map((v) => ({ ...v, greens: v.ccId !== null ? greenContacts(v.ccId) : [] })),
    approved: views.filter((v) => v.status === "approved" && open.has(v.id)),
    /** The newest row when it is a denial, so the screen shows it until the next request. */
    denied: views[0]?.status === "denied" ? views[0] : null,
  };
};

/** Days, CCs, companies, crews and trucks for the request form, in the active event. */
export const requestOptions = (at = Date.now()) => {
  const ev = activeEvent();
  if (!ev) return { event: null, defaultDayId: null, days: [] };
  const withCcs = dayIdsWithCcs(ev.id);
  const dayRows = db.select().from(days).where(eq(days.eventId, ev.id)).orderBy(days.sort, days.id).all().filter((d) => withCcs.has(d.id));
  const dayIds = dayRows.map((d) => d.id);
  const ccRows = dayIds.length ? db.select().from(commandCenters).where(inArray(commandCenters.dayId, dayIds)).orderBy(commandCenters.name).all() : [];
  const crewRows = dayIds.length
    ? db
        .select({ crew: crews, company: companies })
        .from(crews)
        .leftJoin(companies, eq(companies.id, crews.companyId))
        .where(inArray(crews.dayId, dayIds))
        .orderBy(crews.number)
        .all()
    : [];
  const truckRows = dayIds.length ? db.select().from(trucks).where(inArray(trucks.dayId, dayIds)).orderBy(trucks.name).all() : [];
  const today = currentDayId(ev.id, at);
  return {
    event: { id: ev.id, name: ev.name },
    defaultDayId: today ?? dayRows[0]?.id ?? null,
    days: dayRows.map((d) => ({
      id: d.id,
      label: d.label,
      date: d.date,
      ccs: ccRows
        .filter((c) => c.dayId === d.id)
        .map((c) => ({
          id: c.id,
          name: c.name,
          crews: crewRows
            .filter((r) => r.crew.ccId === c.id)
            .map((r) => ({ id: r.crew.id, name: crewLabel(r.crew), companyId: r.company?.id ?? null, companyName: r.company?.name ?? null })),
          trucks: truckRows.filter((t) => t.ccId === c.id).map((t) => ({ id: t.id, name: t.name })),
        })),
    })),
  };
};
// #endregion
