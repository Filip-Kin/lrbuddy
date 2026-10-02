import { initializeApp } from "firebase/app";
import {
  browserLocalPersistence,
  connectAuthEmulator,
  getAuth,
  getRedirectResult,
  GoogleAuthProvider,
  RecaptchaVerifier,
  signInWithPhoneNumber,
  signInWithPopup,
  signInWithRedirect,
  signOut,
  type Auth,
  type ConfirmationResult,
} from "firebase/auth";
import { emulatorUrl, firebaseOptions } from "./firebaseConfig.ts";
import { mediaMatches } from "./safe.ts";

/**
 * Phone and Google sign-in (SPEC 18). Loaded on demand by the sign-in page and
 * sign-out, so the SDK stays out of the main bundle. The server never trusts
 * anything here but the ID token, which it verifies.
 */
let auth: Auth | null = null;

const getFirebaseAuth = (): Auth => {
  if (auth) return auth;
  if (!firebaseOptions) throw new Error("Firebase is not configured");
  const a = getAuth(initializeApp(firebaseOptions));
  if (emulatorUrl) connectAuthEmulator(a, emulatorUrl, { disableWarnings: true });
  // Survives reloads and the installed PWA restarting.
  void a.setPersistence(browserLocalPersistence).catch(() => undefined);
  a.useDeviceLanguage();
  auth = a;
  return a;
};

/** The persisted user's fresh ID token, or null when nobody is signed in to Firebase. */
export const currentIdToken = async (): Promise<string | null> => {
  const a = getFirebaseAuth();
  // A Google sign-in started with signInWithRedirect lands back here; this resolves it.
  await getRedirectResult(a).catch(() => null);
  await a.authStateReady();
  return a.currentUser ? a.currentUser.getIdToken().catch(() => null) : null;
};

/**
 * Installed apps and phones cannot run the popup flow: Android opens the popup
 * as a Custom Tab that never reports back. Those get the redirect flow, which
 * needs the auth handler on our own domain (server proxies /__/auth/*).
 */
const useRedirect = (): boolean =>
  mediaMatches("(display-mode: standalone)") || mediaMatches("(display-mode: fullscreen)") || mediaMatches("(pointer: coarse)");

let verifier: RecaptchaVerifier | null = null;

/**
 * Sends the SMS code. An invisible reCAPTCHA renders into `container` (an
 * empty element), fresh for every send because a used challenge cannot be
 * reused. The emulator skips the challenge.
 */
export const sendCode = async (phoneE164: string, container: HTMLElement): Promise<ConfirmationResult> => {
  const a = getFirebaseAuth();
  verifier?.clear();
  container.replaceChildren();
  verifier = new RecaptchaVerifier(a, container, { size: "invisible" });
  return signInWithPhoneNumber(a, phoneE164, verifier);
};

export const confirmCode = async (confirmation: ConfirmationResult, code: string): Promise<string> => {
  const cred = await confirmation.confirm(code);
  return cred.user.getIdToken();
};

export const googleSignIn = async (): Promise<string> => {
  const a = getFirebaseAuth();
  if (useRedirect()) {
    const { OWN_AUTH_DOMAIN } = await import("./firebaseConfig.ts");
    if (!OWN_AUTH_DOMAIN) throw Object.assign(new Error("google-unavailable-installed"), { code: "auth/google-unavailable-installed" });
    await signInWithRedirect(a, new GoogleAuthProvider());
    // The page navigates away; currentIdToken() finishes the sign-in on return.
    return new Promise<string>(() => undefined);
  }
  const cred = await signInWithPopup(a, new GoogleAuthProvider());
  return cred.user.getIdToken();
};

/**
 * Signs out of Firebase on this phone. Waits for the kept user to load first: sign-out runs on a
 * fresh page, and a sign-out before the stored user has loaded can leave that user behind.
 */
export const firebaseSignOut = async (): Promise<void> => {
  const a = getFirebaseAuth();
  await a.authStateReady().catch(() => undefined);
  await signOut(a).catch(() => undefined);
};

/** Firebase error code (`auth/invalid-verification-code`), or null. */
export const errorCode = (err: unknown): string | null =>
  typeof err === "object" && err !== null && typeof (err as { code?: unknown }).code === "string" ? (err as { code: string }).code : null;
