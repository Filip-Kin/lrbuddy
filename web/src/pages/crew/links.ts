import type { NavLink } from "../../components/Nav.tsx";

/** In the entry chunk, so the nav paints before the crew screens arrive. */
export const crewLinks: NavLink[] = [
  { href: "/", label: "Map" },
  { href: "/request", label: "Request" },
  { href: "/requests", label: "Requests" },
  { href: "/lots", label: "Lots" },
  { href: "/cc", label: "Command center" },
  { href: "/settings", label: "Settings" },
];
