import { TRPCError } from "@trpc/server";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../db/index.ts";
import { inventoryCounts, inventoryItems } from "../../db/schema.ts";
import { adminProcedure, router } from "../../trpc.ts";

/** One item with its last two counts (SPEC 30). */
export interface InventoryRow {
  id: number;
  name: string;
  last: { count: number; at: number; by: string | null } | null;
  previous: { count: number; at: number } | null;
}

export const inventoryRows = (): InventoryRow[] =>
  db
    .select()
    .from(inventoryItems)
    .where(eq(inventoryItems.active, true))
    .orderBy(sql`lower(${inventoryItems.name})`)
    .all()
    .map((it) => {
      const two = db.select().from(inventoryCounts).where(eq(inventoryCounts.itemId, it.id)).orderBy(desc(inventoryCounts.countedAt), desc(inventoryCounts.id)).limit(2).all();
      const [a, b] = two;
      return {
        id: it.id,
        name: it.name,
        last: a ? { count: a.count, at: a.countedAt, by: a.countedBy } : null,
        previous: b ? { count: b.count, at: b.countedAt } : null,
      };
    });

const csvCell = (v: string | number | null): string => {
  const s = v === null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Every saved count, oldest first: item, count, when, who. */
export const inventoryCsv = (): string => {
  const rows = db
    .select({ name: inventoryItems.name, count: inventoryCounts.count, at: inventoryCounts.countedAt, by: inventoryCounts.countedBy })
    .from(inventoryCounts)
    .innerJoin(inventoryItems, eq(inventoryItems.id, inventoryCounts.itemId))
    .orderBy(inventoryCounts.countedAt, inventoryItems.name)
    .all();
  return ["item,count,counted_at,counted_by", ...rows.map((r) => [r.name, r.count, new Date(r.at).toISOString(), r.by].map(csvCell).join(","))].join("\n") + "\n";
};

const name = z.string().trim().min(1).max(80);

/** Inventory count sheet (SPEC 30), planning portal, admin only. */
export const inventoryRouter = router({
  list: adminProcedure.query(() => inventoryRows()),
  addItem: adminProcedure.input(z.object({ name })).mutation(({ input }) => {
    const same = db.select().from(inventoryItems).where(sql`lower(${inventoryItems.name}) = lower(${input.name})`).get();
    if (same) {
      if (same.active) throw new TRPCError({ code: "CONFLICT", message: "Already on the list" });
      db.update(inventoryItems).set({ active: true }).where(eq(inventoryItems.id, same.id)).run();
      return { id: same.id };
    }
    return { id: db.insert(inventoryItems).values({ name: input.name, createdAt: Date.now() }).returning().get().id };
  }),
  /** Off the list; its counts stay in the CSV. */
  removeItem: adminProcedure.input(z.object({ id: z.number().int() })).mutation(({ input }) => {
    db.update(inventoryItems).set({ active: false }).where(eq(inventoryItems.id, input.id)).run();
    return { id: input.id };
  }),
  saveCounts: adminProcedure
    .input(z.object({ counts: z.array(z.object({ itemId: z.number().int(), count: z.number().int().min(0).max(100_000) })).min(1).max(500) }))
    .mutation(({ ctx, input }) => {
      const at = Date.now();
      const by = ctx.session.displayName ?? null;
      db.transaction((tx) => {
        for (const c of input.counts) {
          const it = tx.select().from(inventoryItems).where(and(eq(inventoryItems.id, c.itemId), eq(inventoryItems.active, true))).get();
          if (!it) throw new TRPCError({ code: "NOT_FOUND", message: "Item not found" });
          tx.insert(inventoryCounts).values({ itemId: c.itemId, count: c.count, countedAt: at, countedBy: by }).run();
        }
      });
      return { saved: input.counts.length, at };
    }),
  csv: adminProcedure.query(() => inventoryCsv()),
});
