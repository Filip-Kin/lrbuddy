import { trpc, type RouterOutputs } from "./trpc.ts";

export type Me = RouterOutputs["shared"]["me"];
export type Role = Me["role"];
export type SignedIn = Exclude<Me, { role: "anon" }>;

export const useMe = () => trpc.shared.me.useQuery(undefined, { staleTime: 60_000 });

export const isSignedIn = (me: Me | undefined): me is SignedIn => !!me && me.role !== "anon";

export type LoginResult = { ok: true; role: Role } | { ok: false; error: string };

export const login = async (code: string, displayName?: string): Promise<LoginResult> => {
  const res = await fetch("/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(displayName ? { code, displayName } : { code }),
    credentials: "same-origin",
  });
  const body: unknown = await res.json().catch(() => null);
  if (res.ok && typeof body === "object" && body !== null && (body as { ok?: unknown }).ok === true) {
    return { ok: true, role: (body as { role: Role }).role };
  }
  if (res.status === 429) return { ok: false, error: "Too many tries" };
  return { ok: false, error: "Unknown code" };
};

/** Ends the session and reloads onto the login page. */
export const logout = async (): Promise<void> => {
  await fetch("/auth/logout", { method: "POST", credentials: "same-origin" }).catch(() => undefined);
  window.sessionStorage.clear();
  window.location.assign("/login");
};

/** Names this device's session (`POST /auth/name`). */
export const setDisplayName = async (displayName: string): Promise<boolean> => {
  const res = await fetch("/auth/name", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ displayName }),
    credentials: "same-origin",
  });
  return res.ok;
};
