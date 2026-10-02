import { cert, getApps, initializeApp, type App } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

/**
 * Firebase ID-token verification (SPEC 18), after FTA-Buddy's
 * src/util/firebase-admin.ts.
 *
 * - `FIREBASE_AUTH_EMULATOR_HOST` set: the Admin SDK talks to the local Auth
 *   emulator and needs only a project id (`FIREBASE_PROJECT_ID`, default
 *   `demo-lrbuddy`, which is what docker-compose.yml starts).
 * - `FIREBASE_SERVICE_ACCOUNT` set: the service-account JSON on one line, as
 *   Coolify stores it. The project id comes from it.
 * - Neither: the server refuses to start (server/index.ts). There is no
 *   sign-in without Firebase.
 *
 * Tests swap the verifier with `setVerifier` instead of running the emulator.
 */

/** The claims LR Buddy reads from a verified ID token. */
export interface VerifiedToken {
  uid: string;
  phone: string | null;
  email: string | null;
  name: string | null;
}

type Verifier = (idToken: string) => Promise<VerifiedToken | null>;

const emulatorHost = (process.env.FIREBASE_AUTH_EMULATOR_HOST ?? "").trim();
const serviceAccount = (process.env.FIREBASE_SERVICE_ACCOUNT ?? "").trim();

let app: App | null = null;
let override: Verifier | null = null;

const projectIdFrom = (json: unknown): string | null =>
  typeof json === "object" && json !== null && typeof (json as { project_id?: unknown }).project_id === "string"
    ? (json as { project_id: string }).project_id
    : null;

const init = (): App | null => {
  if (app) return app;
  const existing = getApps()[0];
  if (existing) return (app = existing);
  const fallbackId = (process.env.FIREBASE_PROJECT_ID ?? "").trim() || "demo-lrbuddy";
  if (emulatorHost) {
    app = initializeApp({ projectId: fallbackId });
    console.log(`[firebase] Auth emulator at ${emulatorHost}, project ${fallbackId}`);
    return app;
  }
  if (serviceAccount) {
    const parsed: unknown = JSON.parse(serviceAccount);
    app = initializeApp({ credential: cert(parsed as Parameters<typeof cert>[0]), projectId: projectIdFrom(parsed) ?? fallbackId });
    return app;
  }
  return null;
};

/** True when the server can verify ID tokens: a service account or an emulator (or a test verifier). */
export const firebaseConfigured = (): boolean => override !== null || emulatorHost !== "" || serviceAccount !== "";

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);

const adminVerify: Verifier = async (idToken) => {
  const a = init();
  if (!a) return null;
  try {
    const t = await getAuth(a).verifyIdToken(idToken);
    return { uid: t.uid, phone: str(t.phone_number), email: str(t.email), name: str(t.name) };
  } catch {
    return null;
  }
};

/** Decoded claims of a valid, unexpired ID token for this project; null otherwise. */
export const verifyIdToken = (idToken: string): Promise<VerifiedToken | null> => (override ?? adminVerify)(idToken);

/** Tests only: replaces the Admin SDK check. `null` restores it. */
export const setVerifier = (v: Verifier | null): void => {
  override = v;
};
