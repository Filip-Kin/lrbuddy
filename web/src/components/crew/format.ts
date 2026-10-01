import { ago } from "../../lib/format.ts";
import type { RouterOutputs } from "../../lib/trpc.ts";

export type CrewRequest = RouterOutputs["crew"]["myRequests"][number];
export type CrewLot = RouterOutputs["crew"]["lots"][number];
export type Unit = CrewRequest["unit"];

const PLURAL: Record<Unit, [string, string]> = {
  case: ["case", "cases"],
  box: ["box", "boxes"],
  can: ["can", "cans"],
  roll: ["roll", "rolls"],
  each: ["", ""],
};

/** "2 cases", "1 box", "x3" for things counted one by one. */
export const qtyText = (qty: number, unit: Unit): string => {
  if (unit === "each") return `x${qty}`;
  const [one, many] = PLURAL[unit];
  return `${qty} ${qty === 1 ? one : many}`;
};

/** Stepper label for a unit: "Cases", "Boxes", or "Quantity". */
export const unitLabel = (unit: Unit): string => {
  if (unit === "each") return "Quantity";
  const many = PLURAL[unit][1];
  return many.charAt(0).toUpperCase() + many.slice(1);
};

export const ACTIVE = ["open", "assigned", "en_route"] as const;
export const isActive = (r: Pick<CrewRequest, "status">): boolean =>
  r.status === "open" || r.status === "assigned" || r.status === "en_route";

/** Crews may cancel only before the truck sets off (SPEC 7). */
export const crewCanCancel = (r: Pick<CrewRequest, "status">): boolean => r.status === "open" || r.status === "assigned";

/** "(313) 555-0142" for a US number, otherwise as entered. */
export const phoneText = (raw: string): string => {
  const d = raw.replace(/\D/g, "");
  const ten = d.length === 11 && d.startsWith("1") ? d.slice(1) : d;
  return ten.length === 10 ? `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}` : raw;
};

export { lotTitle } from "../../lib/format.ts";

/** "just now" under a minute, else "4 min ago". */
export const since = (at: number, now: number): string => (now - at < 60_000 ? "just now" : ago(at, now));
