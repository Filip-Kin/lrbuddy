/**
 * Firebase ID tokens for the signin server. In emulator mode the Admin SDK accepts an unsigned
 * token (alg "none") and only asks the emulator whether the account exists; global-setup.ts
 * answers that. So a test signs a person in with one POST, the way the client does after the
 * SMS code, without the phone form (which needs the real Firebase client and reCAPTCHA).
 */
import type { BrowserContext } from "@playwright/test";

const b64 = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString("base64url");

export const idToken = (uid: string, claims: { phone?: string; name?: string; email?: string } = {}): string => {
  const project = process.env.E2E_FIREBASE_PROJECT ?? "demo-lrbuddy";
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: `https://securetoken.google.com/${project}`,
    aud: project,
    auth_time: now,
    user_id: uid,
    sub: uid,
    iat: now,
    exp: now + 3600,
    ...(claims.phone ? { phone_number: claims.phone } : {}),
    ...(claims.email ? { email: claims.email } : {}),
    ...(claims.name ? { name: claims.name } : {}),
    firebase: { identities: claims.phone ? { phone: [claims.phone] } : {}, sign_in_provider: claims.phone ? "phone" : "google.com" },
  };
  return `${b64({ alg: "none", typ: "JWT" })}.${b64(payload)}.`;
};

/** POST /auth/firebase on the context's cookies, as LoginPage does after the code; returns its state. */
export const firebaseSignIn = async (ctx: BrowserContext, base: string, uid: string, name: string, phone: string): Promise<string> => {
  const res = await ctx.request.post(`${base}/auth/firebase`, { data: { idToken: idToken(uid, { phone, name }), name } });
  if (res.status() !== 200) throw new Error(`/auth/firebase ${res.status()}: ${await res.text()}`);
  return ((await res.json()) as { state: string }).state;
};
