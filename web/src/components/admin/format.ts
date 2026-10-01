/** "Mon, Sep 28" for a YYYY-MM-DD day. The date is a calendar day, so no time zone shift. */
export const dayDate = (ymd: string): string => {
  const d = new Date(`${ymd}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return ymd;
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
};

/** "Sep 28 to Oct 3, 2026". */
export const dateRange = (first: string | null, last: string | null): string | null => {
  if (!first) return null;
  const f = new Date(`${first}T12:00:00Z`);
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", timeZone: "UTC" };
  if (!last || last === first) return f.toLocaleDateString("en-US", { ...opts, year: "numeric" });
  const l = new Date(`${last}T12:00:00Z`);
  return `${f.toLocaleDateString("en-US", opts)} to ${l.toLocaleDateString("en-US", { ...opts, year: "numeric" })}`;
};

/** "1 crew", "3 crews". */
export const plural = (n: number, one: string, many = `${one}s`): string => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** Digits and a leading plus, for comparing and dialling. */
export const phoneDigits = (p: string): string => p.replace(/[^\d+]/g, "");

/** "(313) 555-0142" for ten-digit US numbers, otherwise as typed. */
export const phoneText = (p: string): string => {
  const d = p.replace(/\D/g, "");
  const ten = d.length === 11 && d.startsWith("1") ? d.slice(1) : d;
  return ten.length === 10 ? `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}` : p;
};

export const PRIORITY_LABEL: Record<number, string> = { 1: "Low", 2: "Normal", 3: "Urgent" };
export const SOURCE_LABEL: Record<string, string> = { dlba: "Land Bank", parcel: "Vacant parcels", csv: "CSV", manual: "Added by hand", survey: "Survey", drawn: "Drawn" };
export const UNIT_LABEL: Record<string, string> = { case: "Case", box: "Box", can: "Can", each: "Each", roll: "Roll" };
