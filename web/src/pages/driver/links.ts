import type { NavLink } from "../../components/Nav.tsx";

/** In the entry chunk, so the nav paints before the driver screens arrive. */
export const driverLinks: NavLink[] = [
  { href: "/", label: "Map" },
  { href: "/stock", label: "Stock" },
  { href: "/settings", label: "Settings" },
];
