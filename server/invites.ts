/**
 * Invite links (SPEC 26). An admin or a green shirt makes a link `/i/<token>`
 * for a role and scope; whoever opens it, once signed in, gets an approved
 * membership for it and lands in it. Admins invite to any role and scope,
 * greens to red shirt, driver or green shirt at their own CC and day. An invite
 * has an expiry, an optional use limit and can be revoked.
 */
import { and, desc, eq, or, sql } from "drizzle-orm";
import QRCode from "qrcode";
import { enterMembership, grantTarget, makeAdmin, placeLabel, ROLE_LABEL, detroitDate, type Target } from "./access.ts";
import { newInviteToken } from "./auth.ts";
import { config } from "./config.ts";
import { db } from "./db/index.ts";
import { commandCenters, crews, days, invites, trucks, users, type Invite, type Membership, type Role } from "./db/schema.ts";
import { activeEvent } from "./queries.ts";

const HOUR = 3_600_000;

/** `day`: the end of the invite's day in Detroit. */
export const EXPIRIES = ["day", "1d", "7d"] as const;
export type Expiry = (typeof EXPIRIES)[number];

export interface Inviter {
  userId: number;
  /** An admin session with an admin membership behind it. */
  admin: boolean;
  /** A green shirt's CC; null for admin. */
  ccId: number | null;
}

export interface InviteInput {
  role: Role;
  ccId?: number | null;
  crewId?: number | null;
  truckId?: number | null;
  name?: string | null;
  singleUse?: boolean;
  expiry?: Expiry;
}

export type InviteState = "active" | "used" | "expired" | "revoked";

export type CreateResult = { ok: true; invite: Invite } | { ok: false; code: "FORBIDDEN" | "BAD_REQUEST"; error: string };

/** The first moment after `date` (YYYY-MM-DD) in Detroit, as unix ms. */
export const endOfDetroitDay = (date: string): number => {
  const midnightUtc = Date.parse(`${date}T00:00:00Z`) + 24 * HOUR;
  for (const offset of [4, 5]) {
    const t = midnightUtc + offset * HOUR;
    if (detroitDate(t - 1) === date && detroitDate(t) !== date) return t;
  }
  return midnightUtc + 5 * HOUR;
};

const cleanName = (n: string | null | undefined): string | null => {
  const v = n?.trim().replace(/\s+/g, " ").slice(0, 60);
  return v ? v : null;
};

const uniqueToken = (): string => {
  for (;;) {
    const t = newInviteToken();
    if (!db.select({ id: invites.id }).from(invites).where(eq(invites.token, t)).get()) return t;
  }
};

/** Checks the inviter may hand out this role and scope, then stores the invite. */
export const createInvite = (by: Inviter, input: InviteInput, now = Date.now()): CreateResult => {
  if (!by.admin && by.ccId === null) return { ok: false, code: "FORBIDDEN", error: "Not allowed" };
  const name = cleanName(input.name);
  const maxUses = input.singleUse ? 1 : null;
  const base = { token: uniqueToken(), role: input.role, name, maxUses, uses: 0, createdByUserId: by.userId, createdAt: now };

  if (input.role === "admin") {
    if (!by.admin) return { ok: false, code: "FORBIDDEN", error: "Not allowed" };
    if (input.expiry === "day") return { ok: false, code: "BAD_REQUEST", error: "Choose an expiry" };
    const expiresAt = now + (input.expiry === "1d" ? 24 : 7 * 24) * HOUR;
    const invite = db.insert(invites).values({ ...base, eventId: null, dayId: null, ccId: null, crewId: null, truckId: null, expiresAt }).returning().get();
    return { ok: true, invite };
  }

  const ccId = input.ccId ?? by.ccId;
  if (ccId === null || ccId === undefined) return { ok: false, code: "BAD_REQUEST", error: "Choose a command center" };
  if (!by.admin && ccId !== by.ccId) return { ok: false, code: "FORBIDDEN", error: "Not allowed" };
  const cc = db.select().from(commandCenters).where(eq(commandCenters.id, ccId)).get();
  const day = cc ? db.select().from(days).where(eq(days.id, cc.dayId)).get() : undefined;
  const ev = activeEvent();
  if (!cc || !day || !ev || day.eventId !== ev.id) return { ok: false, code: "BAD_REQUEST", error: "Command center not found" };

  let crewId: number | null = null;
  let truckId: number | null = null;
  if (input.role === "crew") {
    const crew = input.crewId ? db.select().from(crews).where(and(eq(crews.id, input.crewId), eq(crews.ccId, cc.id))).get() : undefined;
    if (!crew) return { ok: false, code: "BAD_REQUEST", error: "Choose a crew" };
    crewId = crew.id;
  } else if (input.role === "driver") {
    const truck = input.truckId ? db.select().from(trucks).where(and(eq(trucks.id, input.truckId), eq(trucks.ccId, cc.id))).get() : undefined;
    if (!truck) return { ok: false, code: "BAD_REQUEST", error: "Choose a truck" };
    truckId = truck.id;
  }

  const expiry = input.expiry ?? "day";
  const expiresAt = expiry === "day" ? endOfDetroitDay(day.date) : now + (expiry === "1d" ? 24 : 7 * 24) * HOUR;
  if (expiresAt <= now) return { ok: false, code: "BAD_REQUEST", error: "Day over, choose 1 day or 7 days" };
  const invite = db
    .insert(invites)
    .values({ ...base, eventId: day.eventId, dayId: day.id, ccId: cc.id, crewId, truckId, expiresAt })
    .returning()
    .get();
  return { ok: true, invite };
};

export const stateOf = (i: Invite, now = Date.now()): InviteState => {
  if (i.revokedAt !== null) return "revoked";
  if (i.maxUses !== null && i.uses >= i.maxUses) return "used";
  if (i.expiresAt <= now) return "expired";
  return "active";
};

export const inviteByToken = (token: string): Invite | null => db.select().from(invites).where(eq(invites.token, token)).get() ?? null;

const targetOf = (i: Invite): Target | null =>
  i.role !== "admin" && i.eventId !== null && i.dayId !== null && i.ccId !== null
    ? { role: i.role, eventId: i.eventId, dayId: i.dayId, ccId: i.ccId, crewId: i.crewId, truckId: i.truckId }
    : null;

/** "Admin", "Red shirt, GM 2, General Motors, CC Webb", "Driver, Truck 1, CC East", "Green shirt, CC East". */
export const inviteLabel = (i: Invite): string => {
  const t = targetOf(i);
  const place = t ? placeLabel(t) : null;
  return [ROLE_LABEL[i.role], place].filter(Boolean).join(", ");
};

export type AcceptResult = { ok: true; membership: Membership } | { ok: false; state: InviteState | "unknown" };

/**
 * Opens an invite for a signed-in user: counts the use (refused when used up,
 * expired or revoked), grants the membership and moves the session into it.
 */
export const acceptInvite = (userId: number, sessionId: string, token: string, now = Date.now()): AcceptResult =>
  db.transaction((): AcceptResult => {
    const invite = inviteByToken(token);
    if (!invite) return { ok: false, state: "unknown" };
    const counted = db
      .update(invites)
      .set({ uses: sql`${invites.uses} + 1` })
      .where(
        and(
          eq(invites.id, invite.id),
          sql`${invites.revokedAt} IS NULL`,
          sql`${invites.expiresAt} > ${now}`,
          or(sql`${invites.maxUses} IS NULL`, sql`${invites.uses} < ${invites.maxUses}`),
        ),
      )
      .returning()
      .get();
    if (!counted) return { ok: false, state: stateOf(invite, now) };
    if (counted.role === "admin") {
      const m = makeAdmin(userId, counted.createdByUserId, "Invite", now);
      if (!m) return { ok: false, state: "unknown" };
      enterMembership(sessionId, m);
      return { ok: true, membership: m };
    }
    const t = targetOf(counted);
    const m = t ? grantTarget(userId, sessionId, t, "Invite", now) : null;
    return m ? { ok: true, membership: m } : { ok: false, state: "unknown" };
  });

export const inviteLink = (token: string): string => `${config.publicUrl}/i/${token}`;

export interface InviteView {
  id: number;
  role: Role;
  label: string;
  name: string | null;
  link: string;
  uses: number;
  maxUses: number | null;
  expiresAt: number;
  createdAt: number;
  createdBy: string | null;
  state: InviteState;
}

const viewOf = (i: Invite, names: Map<number, string | null>, now: number): InviteView => ({
  id: i.id,
  role: i.role,
  label: inviteLabel(i),
  name: i.name,
  link: inviteLink(i.token),
  uses: i.uses,
  maxUses: i.maxUses,
  expiresAt: i.expiresAt,
  createdAt: i.createdAt,
  createdBy: i.createdByUserId !== null ? (names.get(i.createdByUserId) ?? null) : null,
  state: stateOf(i, now),
});

/** A new invite as the Invite screen shows it, with its QR as SVG. */
export const createdView = async (i: Invite, now = Date.now()): Promise<InviteView & { qrSvg: string }> => {
  const creator = i.createdByUserId !== null ? db.select({ name: users.name }).from(users).where(eq(users.id, i.createdByUserId)).get() : undefined;
  const view = viewOf(i, new Map(i.createdByUserId !== null ? [[i.createdByUserId, creator?.name ?? null]] : []), now);
  return { ...view, qrSvg: await QRCode.toString(view.link, { type: "svg", margin: 1, errorCorrectionLevel: "M" }) };
};

/** Invites for the Invite screen, newest first: a green's CC, or for admin the active event's and every Admin invite. */
export const listInvites = (by: Inviter, now = Date.now()): InviteView[] => {
  const ev = activeEvent();
  const where = by.admin
    ? ev
      ? or(eq(invites.eventId, ev.id), eq(invites.role, "admin"))
      : eq(invites.role, "admin")
    : by.ccId !== null
      ? eq(invites.ccId, by.ccId)
      : sql`0`;
  const rows = db.select().from(invites).where(where).orderBy(desc(invites.createdAt), desc(invites.id)).limit(100).all();
  const names = new Map(db.select({ id: users.id, name: users.name }).from(users).all().map((u) => [u.id, u.name]));
  return rows.map((r) => viewOf(r, names, now));
};

/** Revokes an invite the inviter can see. False when it is not theirs to revoke. */
export const revokeInvite = (by: Inviter, id: number, now = Date.now()): boolean => {
  const i = db.select().from(invites).where(eq(invites.id, id)).get();
  if (!i) return false;
  if (!by.admin && (by.ccId === null || i.ccId !== by.ccId)) return false;
  if (i.revokedAt === null) db.update(invites).set({ revokedAt: now }).where(eq(invites.id, id)).run();
  return true;
};
