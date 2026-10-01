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
const PROD_CONFIG: FirebaseOptions | null = null;

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
