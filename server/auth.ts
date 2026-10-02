import { timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { bus } from "./bus.ts";
import { config } from "./config.ts";
import { db } from "./db/index.ts";
import { crews, greenCodes, sessions, trucks, type Session, type SessionRole } from "./db/schema.ts";

export const COOKIE = "lrb_session";
/** A scanned QR link (`crew:<token>`, `truck:<code>`, `cc:<code>`) kept across the sign-in round trip. */
export const JOIN_COOKIE = "lrb_join";
const JOIN_MAX_AGE_S = 3600;
const MAX_AGE_S = 30 * 24 * 3600;
const TOUCH_EVERY_MS = 60_000;

// #region cookies
/**
 * A cookie value with a stray percent sign (another site's cookie, a tracker, a
 * hand-typed value) must not take the whole request down. decodeURIComponent
 * throws on it; keep the raw text instead.
 */
const safeDecode = (v: string): string => {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
};

export const parseCookies = (header: string | null): Record<string, string> => {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = safeDecode(v);
  }
  return out;
};

export const sessionIdFrom = (req: Request): string | null => parseCookies(req.headers.get("cookie"))[COOKIE] ?? null;

export const sessionCookie = (id: string): string =>
  [`${COOKIE}=${id}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${MAX_AGE_S}`, config.secureCookie ? "Secure" : ""]
    .filter(Boolean)
    .join("; ");

export const clearCookie = (): string =>
  [`${COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0", config.secureCookie ? "Secure" : ""]
    .filter(Boolean)
    .join("; ");
export const joinCookie = (value: string): string =>
  [`${JOIN_COOKIE}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${JOIN_MAX_AGE_S}`, config.secureCookie ? "Secure" : ""]
    .filter(Boolean)
    .join("; ");

export const clearJoinCookie = (): string =>
  [`${JOIN_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0", config.secureCookie ? "Secure" : ""].filter(Boolean).join("; ");
// #endregion

// #region sessions
export const getSession = (id: string | null): Session | null => {
  if (!id) return null;
  const s = db.select().from(sessions).where(eq(sessions.id, id)).get();
  if (!s) return null;
  const now = Date.now();
  if (now - s.lastUsedAt > TOUCH_EVERY_MS) {
    db.update(sessions).set({ lastUsedAt: now }).where(eq(sessions.id, id)).run();
    s.lastUsedAt = now;
  }
  return s;
};

interface NewSession {
  role: SessionRole;
  userId?: number | null;
  crewId?: number | null;
  truckId?: number | null;
  ccId?: number | null;
  displayName?: string | null;
  userAgent?: string | null;
}

export const createSession = (s: NewSession): Session => {
  const now = Date.now();
  return db
    .insert(sessions)
    .values({
      id: crypto.randomUUID(),
      role: s.role,
      userId: s.userId ?? null,
      crewId: s.crewId ?? null,
      truckId: s.truckId ?? null,
      ccId: s.ccId ?? null,
      displayName: s.displayName ?? null,
      createdAt: now,
      lastUsedAt: now,
      userAgent: s.userAgent?.slice(0, 300) ?? null,
    })
    .returning()
    .get();
};

export const deleteSession = (id: string | null): void => {
  if (!id) return;
  db.delete(sessions).where(eq(sessions.id, id)).run();
  // An open stream on this session ends now, not at its next reconnect.
  bus.checkScopes();
};
// #endregion

// #region login
const safeEqual = (a: string, b: string): boolean => {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
};

const cleanName = (n: string | null | undefined): string | null => {
  const v = n?.trim().slice(0, 60);
  return v ? v : null;
};

/**
 * The staff password, the only thing `POST /auth/login` takes (SPEC 4). Truck
 * codes, green codes and crew tokens sign in only through their QR links.
 */
export const loginWithPassword = (raw: string, userAgent: string | null, displayName?: string | null): Session | null => {
  const code = raw.trim();
  if (!code || !safeEqual(code, config.adminPassword)) return null;
  return createSession({ role: "admin", displayName: cleanName(displayName) ?? "Admin", userAgent });
};

/**
 * A scanned QR with Firebase off: `/t/<truck code>`, `/g/<green code>` or
 * `/j/<crew token>` signs in on the spot, each link only with its own kind.
 */
export const loginWithLink = (kind: "crew" | "truck" | "cc", raw: string, userAgent: string | null): Session | null => {
  if (kind === "crew") return joinWithToken(raw, userAgent);
  const code = raw.trim().toUpperCase();
  if (!code) return null;
  if (kind === "truck") {
    const truck = db.select().from(trucks).where(eq(trucks.code, code)).get();
    return truck ? createSession({ role: "driver", truckId: truck.id, ccId: truck.ccId, displayName: truck.driverName, userAgent }) : null;
  }
  const green = db.select().from(greenCodes).where(eq(greenCodes.code, code)).get();
  return green ? createSession({ role: "green", ccId: green.ccId, displayName: "Green shirt", userAgent }) : null;
};

export const joinWithToken = (token: string, userAgent: string | null, displayName?: string | null): Session | null => {
  const crew = db.select().from(crews).where(eq(crews.token, token)).get();
  if (!crew) return null;
  return createSession({ role: "crew", crewId: crew.id, ccId: crew.ccId, displayName: cleanName(displayName), userAgent });
};

/** Digits of a phone number, kept as typed when it has 7 to 15 of them; else null. */
export const cleanPhone = (v: string | null | undefined): string | null => {
  const s = v?.trim().slice(0, 40) ?? "";
  const digits = s.replace(/\D/g, "").length;
  return digits >= 7 && digits <= 15 ? s : null;
};

/**
 * Renames the session. Returns the stored name, or null when the session is
 * gone or the name is empty. For a crew session, `phone` (and the name) fill
 * the crew's red shirt contact when the crew has none yet, so an imported
 * number is never overwritten.
 */
export const setSessionName = (sessionId: string | null, displayName: string | null | undefined, phone?: string | null): string | null => {
  const name = cleanName(displayName);
  if (!sessionId || !name) return null;
  const row = db.update(sessions).set({ displayName: name }).where(eq(sessions.id, sessionId)).returning().get();
  if (!row) return null;
  const tel = cleanPhone(phone);
  if (row.role === "crew" && row.crewId !== null && tel) {
    const crew = db.select().from(crews).where(eq(crews.id, row.crewId)).get();
    if (crew && !crew.leadPhone?.trim()) {
      db.update(crews)
        .set({ leadPhone: tel, ...(crew.leadName?.trim() ? {} : { leadName: name }) })
        .where(eq(crews.id, crew.id))
        .run();
    }
  }
  return name;
};
// #endregion

// #region rate limit
const WINDOW_MS = 60_000;
const LIMIT = 20;
const hits = new Map<string, number[]>();

/** True when the IP is still under 20 login attempts in the last minute. */
export const allowLogin = (ip: string, now = Date.now()): boolean => {
  const list = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  if (list.length >= LIMIT) {
    hits.set(ip, list);
    return false;
  }
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) {
    for (const [k, v] of hits) if (v.every((t) => now - t >= WINDOW_MS)) hits.delete(k);
  }
  return true;
};
// #endregion

// #region codes
const URL_SAFE = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
/** No 0/O or 1/I, so a code read off paper types right. */
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const randomFrom = (alphabet: string, n: number): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  let s = "";
  for (const b of bytes) s += alphabet[b % alphabet.length];
  return s;
};

export const newCrewToken = (): string => randomFrom(URL_SAFE, 20);
export const newCode = (): string => randomFrom(CODE_CHARS, 6);

/** A 6 character code not used by any truck or green code. */
export const uniqueCode = (): string => {
  for (;;) {
    const c = newCode();
    const t = db.select({ id: trucks.id }).from(trucks).where(eq(trucks.code, c)).get();
    const g = db.select({ id: greenCodes.id }).from(greenCodes).where(eq(greenCodes.code, c)).get();
    if (!t && !g) return c;
  }
};
// #endregion
