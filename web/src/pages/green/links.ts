import type { NavLink } from "../../components/Nav.tsx";
import { trpc } from "../../lib/trpc.ts";

/**
 * Green routes are relative. A green shirt sees them at `/`; an admin sees
 * them nested under `/green` with `?cc=<id>`, so `base` and `search` are
 * prefixed and appended here.
 */
export const greenLinks = (base = "", search = ""): NavLink[] =>
  [
    { href: "/", label: "Map" },
    { href: "/flag", label: "Flag" },
    { href: "/requests", label: "Requests" },
    { href: "/photos", label: "Photos" },
    { href: "/crews", label: "Crews" },
    { href: "/trucks", label: "Trucks" },
    { href: "/broadcast", label: "Broadcast" },
    { href: "/stats", label: "Stats" },
    { href: "/access", label: "Access" },
  ].map((l) => ({ label: l.label, href: `${base}${l.href === "/" && base ? "" : l.href}${search}` }));

/** Green links with the pending access count on Access. */
export const useGreenLinks = (base = "", search = ""): NavLink[] => {
  const count = trpc.access.pendingCount.useQuery(undefined, { refetchInterval: 60_000 });
  return greenLinks(base, search).map((l) => (l.label === "Access" ? { ...l, badge: count.data ?? 0 } : l));
};
