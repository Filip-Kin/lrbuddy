import { initializeApp } from "firebase/app";
import {
  browserLocalPersistence,
  connectAuthEmulator,
  getAuth,
  GoogleAuthProvider,
  RecaptchaVerifier,
  signInWithPhoneNumber,
  signInWithPopup,
  signOut,
  type Auth,
  type ConfirmationResult,
} from "firebase/auth";
import { emulatorUrl, firebaseOptions } from "./firebaseConfig.ts";

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
  await a.authStateReady();
  return a.currentUser ? a.currentUser.getIdToken().catch(() => null) : null;
};

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
  const cred = await signInWithPopup(getFirebaseAuth(), new GoogleAuthProvider());
  return cred.user.getIdToken();
};

export const firebaseSignOut = async (): Promise<void> => {
  await signOut(getFirebaseAuth()).catch(() => undefined);
};

/** Firebase error code (`auth/invalid-verification-code`), or null. */
export const errorCode = (err: unknown): string | null =>
  typeof err === "object" && err !== null && typeof (err as { code?: unknown }).code === "string" ? (err as { code: string }).code : null;
