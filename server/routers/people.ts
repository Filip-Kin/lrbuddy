import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { adminUserIds, makeAdmin, people, removeAdmin } from "../access.ts";
import { adminProcedure, router } from "../trpc.ts";

const id = z.number().int().positive();

/** `/admin/people` (SPEC 26): find users, Make admin, Remove admin. The last admin stays. */
export const peopleRouter = router({
  list: adminProcedure.input(z.object({ q: z.string().max(60).default("") })).query(({ input }) => ({ people: people(input.q), admins: adminUserIds().length })),

  makeAdmin: adminProcedure.input(z.object({ userId: id })).mutation(({ ctx, input }) => {
    if (!makeAdmin(input.userId, ctx.session.userId, "People")) throw new TRPCError({ code: "NOT_FOUND", message: "User not found" });
    return { ok: true };
  }),

  removeAdmin: adminProcedure.input(z.object({ userId: id })).mutation(({ input }) => {
    const r = removeAdmin(input.userId);
    if (!r.ok) throw new TRPCError({ code: r.error === "Last admin" ? "CONFLICT" : "NOT_FOUND", message: r.error });
    return { ok: true };
  }),
});
