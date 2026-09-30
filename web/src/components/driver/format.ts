import { duration } from "../../lib/format.ts";

const PLURAL: Record<string, [string, string]> = {
  case: ["case", "cases"],
  box: ["box", "boxes"],
  can: ["can", "cans"],
  roll: ["roll", "rolls"],
};

/** "2 cases", "1 can", "3" for items counted each. */
export const qtyWithUnit = (qty: number, unit: string): string => {
  const u = PLURAL[unit];
  return u ? `${qty} ${qty === 1 ? u[0] : u[1]}` : String(qty);
};

/** "cases" for a stock row's unit; empty for items counted each. */
export const unitPlural = (unit: string): string => PLURAL[unit]?.[1] ?? "";

/** "Water x2, Snacks x1", the same shape as the push body. */
export const itemsSummary = (items: ReadonlyArray<{ typeLabel: string; qty: number }>): string =>
  items.map((i) => `${i.typeLabel} x${i.qty}`).join(", ");

/** ETA from an absolute time: "4 min", "now", or null when the route has not placed the stop yet. */
export const etaText = (etaAt: number | null, now: number): string | null => (etaAt === null ? null : duration(etaAt - now));
