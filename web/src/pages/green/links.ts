import type { NavLink } from "../../components/Nav.tsx";
import { useMe } from "../../lib/session.ts";
import { trpc } from "../../lib/trpc.ts";

/**
 * Green routes are relative. A green shirt sees them at `/`; an admin sees
 * them nested under `/green` with `?cc=<id>`, so `base` and `search` are
 * prefixed and appended here.
 */
export const greenLinks = (base = "", search = ""): NavLink[] =>
  [
    { href: "/", label: "Map" },
    { href: "/wrap", label: "Wrap up" },
    { href: "/flag", label: "Flag" },
    { href: "/requests", label: "Requests" },
    { href: "/photos", label: "Photos" },
    { href: "/crews", label: "Crews" },
    { href: "/trucks", label: "Trucks" },
    { href: "/broadcast", label: "Broadcast" },
    { href: "/stats", label: "Stats" },
    { href: "/access", label: "Access" },
    { href: "/invite", label: "Invite" },
  ].map((l) => ({ label: l.label, href: `${base}${l.href === "/" && base ? "" : l.href}${search}` }));

/** Green links with the pending access count on Access. */
export const useGreenLinks = (base = "", search = ""): NavLink[] => {
  const count = trpc.access.pendingCount.useQuery(undefined, { refetchInterval: 60_000 });
  const me = useMe();
  // Invites name who made them: a green shirt signed in with a code has no user, so no Invite.
  const user = me.data !== undefined && "user" in me.data && me.data.user === true;
  return greenLinks(base, search)
    .filter((l) => l.label !== "Invite" || user)
    .map((l) => (l.label === "Access" ? { ...l, badge: count.data ?? 0 } : l));
};
