import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { requestOptions } from "../access.ts";
import { isAdminSession } from "../auth.ts";
import { ROLES } from "../db/schema.ts";
import { createdView, createInvite, EXPIRIES, listInvites, revokeInvite, type Inviter } from "../invites.ts";
import { authedProcedure, router } from "../trpc.ts";

const id = z.number().int().positive();

/**
 * Admins (any role and scope) and green shirts signed in as users (red shirt,
 * driver or green shirt at their own CC and day). Code sessions have no user
 * to name as the inviter.
 */
const inviterProcedure = authedProcedure.use(({ ctx, next }) => {
  const s = ctx.session;
  if (s.userId === null) throw new TRPCError({ code: "FORBIDDEN", message: "Not allowed" });
  let inviter: Inviter;
  if (isAdminSession(s)) inviter = { userId: s.userId, admin: true, ccId: null };
  else if (s.role === "green" && s.ccId !== null) inviter = { userId: s.userId, admin: false, ccId: s.ccId };
  else throw new TRPCError({ code: "FORBIDDEN", message: "Not allowed" });
  return next({ ctx: { ...ctx, inviter } });
});

export const invitesRouter = router({
  /** What the Invite screen offers: every day and CC for admin, the green's own CC otherwise. */
  options: inviterProcedure.query(({ ctx }) => {
    const all = requestOptions();
    const { inviter } = ctx;
    if (inviter.admin) return { admin: true, ...all };
    const days = all.days.map((d) => ({ ...d, ccs: d.ccs.filter((c) => c.id === inviter.ccId) })).filter((d) => d.ccs.length > 0);
    return { admin: false, ...all, defaultDayId: days[0]?.id ?? null, days };
  }),

  list: inviterProcedure.query(({ ctx }) => listInvites(ctx.inviter)),

  create: inviterProcedure
    .input(
      z.object({
        role: z.enum(ROLES),
        ccId: id.nullish(),
        crewId: id.nullish(),
        truckId: id.nullish(),
        name: z.string().max(60).nullish(),
        singleUse: z.boolean().default(false),
        expiry: z.enum(EXPIRIES).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const r = createInvite(ctx.inviter, input);
      if (!r.ok) throw new TRPCError({ code: r.code, message: r.error });
      return createdView(r.invite);
    }),

  revoke: inviterProcedure.input(z.object({ id })).mutation(({ ctx, input }) => {
    if (!revokeInvite(ctx.inviter, input.id)) throw new TRPCError({ code: "NOT_FOUND", message: "Invite not found" });
    return { ok: true };
  }),
});
