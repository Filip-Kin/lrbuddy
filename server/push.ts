import { eq, inArray } from "drizzle-orm";
import webpush from "web-push";
import { config } from "./config.ts";
import { db } from "./db/index.ts";
import { pushSubscriptions, sessions } from "./db/schema.ts";

export interface PushPayload {
  title: string;
  body: string;
  url: string;
  tag?: string;
}

let enabled = false;
if (config.vapidPublicKey && config.vapidPrivateKey) {
  try {
    webpush.setVapidDetails(config.vapidSubject, config.vapidPublicKey, config.vapidPrivateKey);
    enabled = true;
  } catch (err) {
    console.warn("[push] VAPID keys rejected, push disabled:", err instanceof Error ? err.message : String(err));
  }
}

export const pushEnabled = (): boolean => enabled;
export const vapidPublicKey = (): string | null => (enabled ? config.vapidPublicKey : null);

export const subscribe = (sessionId: string, sub: { endpoint: string; p256dh: string; auth: string }): void => {
  db.insert(pushSubscriptions)
    .values({ sessionId, endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth, createdAt: Date.now() })
    .onConflictDoUpdate({
      target: pushSubscriptions.endpoint,
      set: { sessionId, p256dh: sub.p256dh, auth: sub.auth, createdAt: Date.now() },
    })
    .run();
};

export const unsubscribe = (sessionId: string, endpoint: string): void => {
  const row = db.select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint)).get();
  if (row && row.sessionId === sessionId) db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, row.id)).run();
};

const statusOf = (err: unknown): number | null =>
  typeof err === "object" && err !== null && typeof (err as { statusCode?: unknown }).statusCode === "number"
    ? (err as { statusCode: number }).statusCode
    : null;

/** Sends to every subscription of the given sessions. Never throws. */
export const sendToSessions = async (sessionIds: readonly string[], payload: PushPayload): Promise<void> => {
  if (!enabled || sessionIds.length === 0) return;
  const subs = db
    .select()
    .from(pushSubscriptions)
    .where(inArray(pushSubscriptions.sessionId, [...sessionIds]))
    .all();
  const dead: number[] = [];
  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          JSON.stringify(payload),
          { TTL: 3600, topic: payload.tag?.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || undefined },
        );
      } catch (err) {
        const code = statusOf(err);
        if (code === 404 || code === 410) dead.push(s.id);
        else console.error("[push] send failed", code ?? "", err instanceof Error ? err.message : String(err));
      }
    }),
  );
  if (dead.length > 0) db.delete(pushSubscriptions).where(inArray(pushSubscriptions.id, dead)).run();
};

const sessionIdsWhere = (col: typeof sessions.crewId | typeof sessions.truckId | typeof sessions.ccId, id: number): string[] =>
  db.select({ id: sessions.id }).from(sessions).where(eq(col, id)).all().map((r) => r.id);

export const pushToCrew = (crewId: number, payload: PushPayload): void => {
  void sendToSessions(sessionIdsWhere(sessions.crewId, crewId), payload);
};

export const pushToTruck = (truckId: number, payload: PushPayload): void => {
  void sendToSessions(sessionIdsWhere(sessions.truckId, truckId), payload);
};

/** Every session scoped to the CC: its greens, drivers and crews. A CC belongs to one day. */
export const pushToCc = (ccId: number, payload: PushPayload): void => {
  void sendToSessions(sessionIdsWhere(sessions.ccId, ccId), payload);
};
