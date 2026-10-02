/**
 * Switch day, CC and role from the header (SPEC 27). The rules live here so the
 * tests can call them directly; `access.switchOptions` and `access.switchTo`
 * stay thin.
 *
 * What a user may pick:
 * - every approved membership in the active event (any day, not only today);
 * - an admin: every day, every CC, every role (green, driver of each truck, red shirt
 *   of any crew), with no membership row: the admin membership stands behind it;
 * - a green shirt at a CC: Driver for any truck of that CC on the spot, which
 *   writes an approved driver membership noted "self, green".
 * Anything else is an access request. A role held at a CC on one day shows on
 * the other days, at the CC with the same name, as a one-tap request.
 */
import { and, eq, inArray, ne, type SQL } from "drizzle-orm";
import { currentDayId, enterMembership, grantTarget, userById, type Target } from "./access.ts";
import { hasAdmin } from "./auth.ts";
import { bus } from "./bus.ts";
import { db } from "./db/index.ts";
import { commandCenters, crews, days, memberships, sessions, trucks, type Membership, type Session } from "./db/schema.ts";
import { crewLabel } from "./dispatch.ts";
import { activeEvent } from "./queries.ts";

// #region types
export type SwitchTarget = { role: "admin" } | { role: "green"; ccId: number } | { role: "driver"; truckId: number } | { role: "crew"; crewId: number };

/** Enter: held. Take: a green shirt takes a truck at the CC. Request: one tap sends an access request. Pending: asked, not decided. */
export type SwitchAction = "enter" | "take" | "request" | "pending";

export interface SwitchRequest {
  role: "green" | "driver" | "crew";
  dayId: number;
  ccId: number;
  crewId: number | null;
  truckId: number | null;
}

export interface SwitchRole {
  key: string;
  role: "green" | "driver" | "crew";
  /** "Green shirt", the truck's name or the crew's name. */
  name: string;
  action: SwitchAction;
  current: boolean;
  target: SwitchTarget;
  request: SwitchRequest | null;
}

export interface SwitchCc {
  id: number;
  name: string;
  letter: string | null;
  roles: SwitchRole[];
}

export interface SwitchDay {
  id: number;
  label: string;
  date: string;
  today: boolean;
  ccs: SwitchCc[];
}

export interface SwitchView {
  admin: { held: boolean; current: boolean };
  /** The day and CC the session is in, for the sheet's first pick. */
  current: { dayId: number; ccId: number } | null;
  /** Today first (when the event has a today), then in day order. */
  days: SwitchDay[];
}

export type SwitchResult = { ok: true; role: SwitchTarget["role"] } | { ok: false; code: "FORBIDDEN" | "NOT_FOUND" };
// #endregion

// #region options
const ORDER: Record<SwitchRole["role"], number> = { green: 0, driver: 1, crew: 2 };

/** The place a session is in, as the target the sheet would send for it. */
const currentKey = (s: Pick<Session, "role" | "ccId" | "truckId" | "crewId">): string | null => {
  if (s.role === "green" && s.ccId !== null) return `green:${s.ccId}`;
  if (s.role === "driver" && s.truckId !== null) return `driver:${s.truckId}`;
  if (s.role === "crew" && s.crewId !== null) return `crew:${s.crewId}`;
  return null;
};

export const switchOptions = (userId: number, session: Pick<Session, "role" | "ccId" | "truckId" | "crewId">, at = Date.now()): SwitchView => {
  const admin = hasAdmin(userId);
  const ev = activeEvent();
  const view: SwitchView = { admin: { held: admin, current: session.role === "admin" }, current: null, days: [] };
  if (!ev) return view;

  const dayRows = db.select().from(days).where(eq(days.eventId, ev.id)).orderBy(days.sort, days.id).all();
  const dayIds = dayRows.map((d) => d.id);
  const ccRows = dayIds.length ? db.select().from(commandCenters).where(inArray(commandCenters.dayId, dayIds)).orderBy(commandCenters.name, commandCenters.id).all() : [];
  const ccIds = ccRows.map((c) => c.id);
  const truckRows = ccIds.length ? db.select().from(trucks).where(inArray(trucks.ccId, ccIds)).orderBy(trucks.name, trucks.id).all() : [];
  const crewRows = ccIds.length ? db.select().from(crews).where(inArray(crews.ccId, ccIds)).orderBy(crews.number, crews.id).all() : [];
  const mine = db
    .select()
    .from(memberships)
    .where(and(eq(memberships.userId, userId), eq(memberships.eventId, ev.id), ne(memberships.status, "denied")))
    .all();

  const ccById = new Map(ccRows.map((c) => [c.id, c]));
  const truckById = new Map(truckRows.map((t) => [t.id, t]));
  const crewById = new Map(crewRows.map((c) => [c.id, c]));
  const keyOf = (m: Membership): string | null =>
    m.role === "green" && m.ccId !== null ? `green:${m.ccId}` : m.role === "driver" && m.truckId !== null ? `driver:${m.truckId}` : m.role === "crew" && m.crewId !== null ? `crew:${m.crewId}` : null;
  const held = new Map<string, Membership>();
  for (const m of mine) {
    const k = keyOf(m);
    if (!k) continue;
    const prev = held.get(k);
    if (!prev || (m.status === "approved" && prev.status !== "approved")) held.set(k, m);
  }
  const approved = mine.filter((m) => m.status === "approved");
  const greenAt = new Set(approved.filter((m) => m.role === "green" && m.ccId !== null).map((m) => m.ccId!));
  const here = currentKey(session);

  const today = currentDayId(ev.id, at);
  for (const d of dayRows) {
    const ccs: SwitchCc[] = [];
    for (const cc of ccRows.filter((c) => c.dayId === d.id)) {
      const roles = new Map<string, SwitchRole>();
      const add = (r: Omit<SwitchRole, "current">): void => {
        if (!roles.has(r.key)) roles.set(r.key, { ...r, current: r.key === here });
      };
      const ccTrucks = truckRows.filter((t) => t.ccId === cc.id);
      const ccCrews = crewRows.filter((c) => c.ccId === cc.id);
      const stateOf = (k: string): SwitchAction | null => {
        const m = held.get(k);
        return m ? (m.status === "approved" ? "enter" : "pending") : null;
      };
      // Green shirt
      const gk = `green:${cc.id}`;
      const gState = admin ? "enter" : stateOf(gk);
      if (gState) add({ key: gk, role: "green", name: "Green shirt", action: gState, target: { role: "green", ccId: cc.id }, request: null });
      // Drivers
      for (const t of ccTrucks) {
        const k = `driver:${t.id}`;
        const st = admin ? "enter" : stateOf(k);
        const action: SwitchAction | null = st === "enter" ? "enter" : greenAt.has(cc.id) ? "take" : st;
        if (action) add({ key: k, role: "driver", name: t.name, action, target: { role: "driver", truckId: t.id }, request: null });
      }
      // Red shirts
      for (const c of ccCrews) {
        const k = `crew:${c.id}`;
        const st = admin ? "enter" : stateOf(k);
        if (st) add({ key: k, role: "crew", name: crewLabel(c), action: st, target: { role: "crew", crewId: c.id }, request: null });
      }
      // The same role at the same CC name on another day: one tap asks for it here.
      if (!admin) {
        for (const m of approved) {
          if (m.dayId === d.id || m.ccId === null) continue;
          const theirs = ccById.get(m.ccId);
          if (!theirs || theirs.name.trim().toLowerCase() !== cc.name.trim().toLowerCase()) continue;
          const base = { dayId: d.id, ccId: cc.id };
          if (m.role === "green") {
            add({ key: gk, role: "green", name: "Green shirt", action: "request", target: { role: "green", ccId: cc.id }, request: { role: "green", ...base, crewId: null, truckId: null } });
          } else if (m.role === "driver" && m.truckId !== null) {
            const name = truckById.get(m.truckId)?.name;
            const t = ccTrucks.find((x) => x.name === name);
            if (t) add({ key: `driver:${t.id}`, role: "driver", name: t.name, action: "request", target: { role: "driver", truckId: t.id }, request: { role: "driver", ...base, crewId: null, truckId: t.id } });
          } else if (m.role === "crew" && m.crewId !== null) {
            const was = crewById.get(m.crewId);
            const c = was ? ccCrews.find((x) => crewLabel(x) === crewLabel(was)) : undefined;
            if (c) add({ key: `crew:${c.id}`, role: "crew", name: crewLabel(c), action: "request", target: { role: "crew", crewId: c.id }, request: { role: "crew", ...base, crewId: c.id, truckId: null } });
          }
        }
      }
      const list = [...roles.values()].sort((a, b) => ORDER[a.role] - ORDER[b.role]);
      if (list.some((r) => r.current)) view.current = { dayId: d.id, ccId: cc.id };
      if (list.length > 0 || admin) ccs.push({ id: cc.id, name: cc.name, letter: cc.letter, roles: list });
    }
    if (ccs.length > 0 || d.id === today) view.days.push({ id: d.id, label: d.label, date: d.date, today: d.id === today, ccs });
  }
  view.days.sort((a, b) => Number(b.today) - Number(a.today));
  return view;
};
// #endregion

// #region switch
/** Puts the session into a role an admin picked, with no membership row behind it. */
const enterAsAdmin = (sessionId: string, userId: number, role: "green" | "driver" | "crew", ccId: number, ids: { truckId?: number; crewId?: number }): void => {
  db.update(sessions)
    .set({ role, membershipId: null, ccId, truckId: ids.truckId ?? null, crewId: ids.crewId ?? null, displayName: userById(userId)?.name ?? null })
    .where(eq(sessions.id, sessionId))
    .run();
  bus.checkScopes();
};

const approvedRow = (userId: number, where: SQL | undefined): Membership | undefined =>
  db
    .select()
    .from(memberships)
    .where(and(eq(memberships.userId, userId), eq(memberships.status, "approved"), where))
    .get();

/** The CC row and its event, when it is in the active event. */
const ccInEvent = (ccId: number): { ccId: number; dayId: number; eventId: number } | null => {
  const ev = activeEvent();
  const cc = db.select().from(commandCenters).where(eq(commandCenters.id, ccId)).get();
  const day = cc ? db.select().from(days).where(eq(days.id, cc.dayId)).get() : undefined;
  return ev && cc && day && day.eventId === ev.id ? { ccId: cc.id, dayId: day.id, eventId: ev.id } : null;
};

/**
 * Signs the session into the picked role at once, by the rules at the top of
 * this file. The app shell follows `shared.me` without a reload.
 */
export const switchTo = (userId: number, sessionId: string, t: SwitchTarget, now = Date.now()): SwitchResult => {
  const admin = hasAdmin(userId);
  if (t.role === "admin") {
    const row = approvedRow(userId, eq(memberships.role, "admin"));
    if (!row || !enterMembership(sessionId, row)) return { ok: false, code: "FORBIDDEN" };
    return { ok: true, role: "admin" };
  }
  if (t.role === "green") {
    const place = ccInEvent(t.ccId);
    if (!place) return { ok: false, code: "NOT_FOUND" };
    const row = approvedRow(userId, and(eq(memberships.role, "green"), eq(memberships.ccId, t.ccId)));
    if (row && enterMembership(sessionId, row)) return { ok: true, role: "green" };
    if (!admin) return { ok: false, code: "FORBIDDEN" };
    enterAsAdmin(sessionId, userId, "green", t.ccId, {});
    return { ok: true, role: "green" };
  }
  if (t.role === "driver") {
    const truck = db.select().from(trucks).where(eq(trucks.id, t.truckId)).get();
    const place = truck ? ccInEvent(truck.ccId) : null;
    if (!truck || !place) return { ok: false, code: "NOT_FOUND" };
    const row = approvedRow(userId, and(eq(memberships.role, "driver"), eq(memberships.truckId, truck.id)));
    if (row && enterMembership(sessionId, row)) return { ok: true, role: "driver" };
    if (admin) {
      enterAsAdmin(sessionId, userId, "driver", truck.ccId, { truckId: truck.id });
      return { ok: true, role: "driver" };
    }
    const green = approvedRow(userId, and(eq(memberships.role, "green"), eq(memberships.ccId, truck.ccId)));
    if (!green) return { ok: false, code: "FORBIDDEN" };
    const target: Target = { role: "driver", eventId: place.eventId, dayId: place.dayId, ccId: truck.ccId, crewId: null, truckId: truck.id };
    return grantTarget(userId, sessionId, target, "self, green", now) ? { ok: true, role: "driver" } : { ok: false, code: "NOT_FOUND" };
  }
  const crew = db.select().from(crews).where(eq(crews.id, t.crewId)).get();
  if (!crew || !ccInEvent(crew.ccId)) return { ok: false, code: "NOT_FOUND" };
  const row = approvedRow(userId, and(eq(memberships.role, "crew"), eq(memberships.crewId, crew.id)));
  if (row && enterMembership(sessionId, row)) return { ok: true, role: "crew" };
  if (!admin) return { ok: false, code: "FORBIDDEN" };
  enterAsAdmin(sessionId, userId, "crew", crew.ccId, { crewId: crew.id });
  return { ok: true, role: "crew" };
};
// #endregion
