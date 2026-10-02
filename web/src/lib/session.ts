import { getQueryKey } from "@trpc/react-query";
import { useState } from "react";
import { useLocation } from "wouter";
import { errorText } from "./errors.ts";
import { clearIdbStore } from "./idbStore.ts";
import { queryClient, setCcOverride, trpc, type RouterInputs, type RouterOutputs } from "./trpc.ts";
import { storageClear, storageGet, storageSet } from "./safe.ts";

export type Me = RouterOutputs["shared"]["me"];
export type Role = Me["role"];
export type SignedIn = Exclude<Me, { role: "anon" } | { role: "none" }>;
/** Signed in through Firebase, no role yet: the access screen. */
export type NoRole = Extract<Me, { role: "none" }>;

export const useMe = () => trpc.shared.me.useQuery(undefined, { staleTime: 60_000 });

export const isSignedIn = (me: Me | undefined): me is SignedIn => !!me && me.role !== "anon" && me.role !== "none";

export type FirebaseState = "entered" | "choose" | "request";
export type FirebaseResult = { ok: true; state: FirebaseState } | { ok: false; status: number; error: string };

/** Trades a Firebase ID token for a session (`POST /auth/firebase`). */
export const signInWithIdToken = async (idToken: string, name?: string): Promise<FirebaseResult> => {
  const res = await fetch("/auth/firebase", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(name ? { idToken, name } : { idToken }),
    credentials: "same-origin",
  });
  const body: unknown = await res.json().catch(() => null);
  if (res.ok && typeof body === "object" && body !== null && (body as { ok?: unknown }).ok === true) {
    return { ok: true, state: (body as { state: FirebaseState }).state };
  }
  const error = typeof body === "object" && body !== null && typeof (body as { error?: unknown }).error === "string" ? (body as { error: string }).error : "Sign-in failed";
  return { ok: false, status: res.status, error };
};

const signOutOfFirebase = async (): Promise<void> => {
  const { firebaseSignOut } = await import("./firebase.ts");
  await firebaseSignOut();
};

/** Leaving: the tab's state, the last role and the phone's copy of the map queries go. */
const forgetDevice = async (): Promise<void> => {
  storageClear("session");
  storageSet("local", "lrb.lastRole", null);
  await clearIdbStore().catch(() => undefined);
};

/**
 * Leaves the crew or truck. A signed-in user keeps the sign-in and lands on
 * the access screen; a code session ends and goes to the login page.
 */
export const leave = async (): Promise<void> => {
  const res = await fetch("/auth/leave", { method: "POST", credentials: "same-origin" }).catch(() => null);
  const body: unknown = await res?.json().catch(() => null);
  const signedOut = !(typeof body === "object" && body !== null && (body as { signedOut?: unknown }).signedOut === false);
  await forgetDevice();
  window.location.assign(signedOut ? "/login" : "/");
};

/**
 * Set by Sign out, cleared by the next sign-in the person makes on the form. While set, the sign-in
 * page does not sign a kept Firebase user straight back in (SPEC 27: Sign out lands on /login, never
 * in a role the server picks, such as admin).
 */
const SIGNED_OUT_KEY = "lrb.signedOut";
export const signedOut = (): boolean => storageGet("local", SIGNED_OUT_KEY) === "1";
export const clearSignedOut = (): void => storageSet("local", SIGNED_OUT_KEY, null);

/** Ends the session and the Firebase sign-in, and reloads onto the login page. */
export const logout = async (): Promise<void> => {
  storageSet("local", SIGNED_OUT_KEY, "1");
  await fetch("/auth/logout", { method: "POST", credentials: "same-origin" }).catch(() => undefined);
  await signOutOfFirebase().catch(() => undefined);
  await forgetDevice();
  window.location.assign("/login");
};

// #region switch (SPEC 27)
export type SwitchTarget = RouterInputs["access"]["switchTo"];

const ME_KEY = JSON.stringify(getQueryKey(trpc.shared.me)[0]);

/**
 * Signs this session into another day, CC or role from the scope chip, without
 * reloading the app shell: the server moves the session, `me` is read again
 * (the shell follows its role), the new role's home opens, and every other
 * answer is dropped so no screen draws the old place's data.
 */
export const useSwitchRole = () => {
  const utils = trpc.useUtils();
  const [, navigate] = useLocation();
  const mutation = trpc.access.switchTo.useMutation();
  const [error, setError] = useState<string | null>(null);
  const go = async (t: SwitchTarget): Promise<boolean> => {
    setError(null);
    try {
      const r = await mutation.mutateAsync(t);
      // An admin's green view CC belongs to the admin role only.
      setCcOverride(null);
      await utils.shared.me.refetch();
      navigate(r.role === "admin" ? "/admin" : "/");
      void queryClient.resetQueries({ predicate: (q) => JSON.stringify(q.queryKey[0]) !== ME_KEY });
      return true;
    } catch (err) {
      setError(errorText(err, "Not switched. Check signal and try again."));
      return false;
    }
  };
  return { go, busy: mutation.isPending, error };
};
// #endregion

/**
 * Names this device's session (`POST /auth/name`). A crew also sends a mobile
 * number, which becomes the red shirt's number when the crew has none.
 */
export const setDisplayName = async (displayName: string, phone?: string): Promise<boolean> => {
  const res = await fetch("/auth/name", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(phone ? { displayName, phone } : { displayName }),
    credentials: "same-origin",
  });
  return res.ok;
};
