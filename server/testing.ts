/**
 * Test helpers shared by the bun test files. Not imported by the app.
 */
import { createSession } from "./auth.ts";
import { db } from "./db/index.ts";
import { memberships, users, type Session } from "./db/schema.ts";

let serial = 0;

/**
 * An admin session as the app makes one (SPEC 26): a user with an approved
 * admin membership, and a session in that membership.
 */
export const adminSession = (displayName: string | null = "Admin"): Session => {
  serial += 1;
  const now = Date.now();
  const user = db
    .insert(users)
    .values({ firebaseUid: `test-admin-${process.pid}-${serial}-${now}`, name: displayName, createdAt: now, lastSeenAt: now })
    .returning()
    .get();
  db.insert(memberships).values({ userId: user.id, eventId: null, role: "admin", status: "approved", requestedAt: now, decidedAt: now }).run();
  return createSession({ role: "admin", userId: user.id, displayName });
};
