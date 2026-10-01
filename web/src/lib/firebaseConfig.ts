import type { FirebaseOptions } from "firebase/app";

/**
 * The Firebase web config for this page, without loading the SDK (SPEC 18).
 *
 * Picked by hostname like FTA-Buddy's app/src/util/firebase.ts: the
 * production config goes in PROD_CONFIG once the project exists (the apiKey
 * is a client identifier, not a secret). Until then, and on any other host,
 * the build reads `VITE_FIREBASE_CONFIG` (the config object as JSON). With
 * `VITE_FIREBASE_EMULATOR` set and no config, the `demo-lrbuddy` project of
 * the local emulator in docker-compose.yml is used.
 */
const PROD_HOST = "lrbuddy.filipkin.com";
const PROD_CONFIG: FirebaseOptions | null = {
  apiKey: "AIzaSyBvjuv_mzHmZUhcj4Rf71-v77tcvKLr-PA",
  authDomain: "lrbuddy-filipkin.firebaseapp.com",
  projectId: "lrbuddy-filipkin",
  appId: "1:749282608874:web:b5a44249c4d04543087993",
  messagingSenderId: "749282608874",
  storageBucket: "lrbuddy-filipkin.firebasestorage.app"
};

const DEMO_CONFIG: FirebaseOptions = { apiKey: "demo-key", authDomain: "demo-lrbuddy.firebaseapp.com", projectId: "demo-lrbuddy" };

const fromEnv = (): FirebaseOptions | null => {
  const raw = import.meta.env.VITE_FIREBASE_CONFIG;
  if (typeof raw !== "string" || raw.trim() === "") return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && typeof (parsed as { apiKey?: unknown }).apiKey === "string") return parsed as FirebaseOptions;
  } catch {
    return null;
  }
  return null;
};

/** `http://127.0.0.1:9099` style URL of the Auth emulator, or null. */
export const emulatorUrl: string | null = (() => {
  const raw = import.meta.env.VITE_FIREBASE_EMULATOR;
  if (typeof raw !== "string" || raw.trim() === "") return null;
  return raw.startsWith("http") ? raw : `http://${raw}`;
})();

export const firebaseOptions: FirebaseOptions | null =
  (typeof window !== "undefined" && window.location.hostname === PROD_HOST ? PROD_CONFIG : null) ?? fromEnv() ?? (emulatorUrl ? DEMO_CONFIG : null);

/**
 * Google sign-in needs an OAuth client that only the Cloud console can create for
 * this project. Flip to true once the Google provider is enabled in Firebase Auth.
 */
export const googleEnabled = true;

/**
 * Flip to true once the OAuth client in GCP lists
 * https://lrbuddy.filipkin.com/__/auth/handler as a redirect URI. Then PROD_CONFIG.authDomain
 * becomes lrbuddy.filipkin.com (the server already proxies /__/auth/*), and the redirect flow
 * works inside the installed app.
 */
export const OWN_AUTH_DOMAIN = false;
