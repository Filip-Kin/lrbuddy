import type { NavLink } from "../../components/Nav.tsx";
import { trpc } from "../../lib/trpc.ts";

/** In the entry chunk, so the nav paints before the admin screens arrive. */
export const adminLinks: NavLink[] = [
  { href: "/admin", label: "Event" },
  { href: "/admin/companies", label: "Companies" },
  { href: "/admin/crews", label: "Crews" },
  { href: "/admin/lots", label: "Lots" },
  { href: "/admin/photos", label: "Photos" },
  { href: "/admin/catalog", label: "Catalog" },
  { href: "/plan/survey", label: "Plan" },
  { href: "/admin/export", label: "Export" },
  { href: "/admin/green", label: "Green view" },
  { href: "/admin/access", label: "Access" },
  { href: "/admin/client-errors", label: "Client errors" },
];

/** Admin links with the pending access count on Access. */
export const useAdminLinks = (): NavLink[] => {
  const count = trpc.access.adminPendingCount.useQuery(undefined, { refetchInterval: 60_000 });
  return adminLinks.map((l) => (l.href === "/admin/access" ? { ...l, badge: count.data ?? 0 } : l));
};
