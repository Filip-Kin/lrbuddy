import { and, eq, ne } from "drizzle-orm";
import { db } from "./db/index.ts";
import { companies, crews, type Company } from "./db/schema.ts";

/**
 * Crew names (SPEC 19). One stored name per crew, `crews.name`, shown on every
 * screen, push, export and sheet: "<company short> <n>" ("GM 2", "ROCKET 1"),
 * where n counts the company's crews on that day, or "Crew <number>" for a crew
 * without a company. Migration 0008 backfilled existing rows with the same rule.
 */

type CompanyName = Pick<Company, "name" | "short">;

/** The abbreviation crews are named with: the company's short, else the first word of its name. */
export const shortOf = (c: CompanyName): string => c.short?.trim() || c.name.trim().split(/\s+/)[0] || c.name;

/** The name rule itself. `n` is the crew's place among its company's crews that day; `number` is the crew number. */
export const crewName = (company: CompanyName | null, n: number, number: number): string =>
  company ? `${shortOf(company)} ${n}` : `Crew ${number}`;

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The n of a name under a prefix ("GM 12" under "GM" is 12), else null. */
export const nameIndex = (name: string, prefix: string): number | null => {
  const m = new RegExp(`^${escape(prefix)} (\\d+)$`).exec(name.trim());
  return m ? Number(m[1]) : null;
};

/** True when `name` is what the rule would give a crew of this company (any n), so a company change may rename it. */
export const isRuleName = (name: string, company: CompanyName | null, number: number): boolean =>
  company ? nameIndex(name, shortOf(company)) !== null : name.trim() === `Crew ${number}`;

/**
 * The name a crew gets on joining a company on a day: one past the highest n
 * already used under the company's short that day, so names never repeat.
 */
export const nextCrewName = (input: { dayId: number; companyId: number | null; number: number; exceptCrewId?: number }): string => {
  const company = input.companyId === null ? null : (db.select().from(companies).where(eq(companies.id, input.companyId)).get() ?? null);
  if (!company) return crewName(null, 0, input.number);
  const prefix = shortOf(company);
  const rows = db
    .select({ name: crews.name })
    .from(crews)
    .where(input.exceptCrewId === undefined ? eq(crews.dayId, input.dayId) : and(eq(crews.dayId, input.dayId), ne(crews.id, input.exceptCrewId)))
    .all();
  const top = rows.reduce((m, r) => Math.max(m, nameIndex(r.name, prefix) ?? 0), 0);
  return crewName(company, top + 1, input.number);
};

/** After a company's name or short changes: crews named by the old prefix take the new one, same n. Custom names stay. */
export const renameCompanyCrews = (companyId: number, before: CompanyName, after: CompanyName): number => {
  const from = shortOf(before);
  const to = shortOf(after);
  if (from === to) return 0;
  let changed = 0;
  for (const c of db.select({ id: crews.id, name: crews.name }).from(crews).where(eq(crews.companyId, companyId)).all()) {
    const n = nameIndex(c.name, from);
    if (n === null) continue;
    db.update(crews).set({ name: `${to} ${n}` }).where(eq(crews.id, c.id)).run();
    changed++;
  }
  return changed;
};
