import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import {
  cancelRequest,
  candidates,
  decide,
  enterMembership,
  linkLabel,
  mine,
  pendingRequests,
  recentDecisions,
  requestAccess,
  requestOptions,
  type DecideResult,
  type LinkKind,
} from "../access.ts";
import { bus } from "../bus.ts";
import { inviteByToken, inviteLabel, stateOf } from "../invites.ts";
import { db } from "../db/index.ts";
import { sessions } from "../db/schema.ts";
import { adminProcedure, greenProcedure, publicProcedure, router, userProcedure } from "../trpc.ts";

const id = z.number().int().positive();

const decision = z.object({ id, decision: z.enum(["approve", "deny"]), lead: z.enum(["replace", "add"]).optional() });

/** A decision for the client: done, or the Replace lead / Add question. */
const decided = (r: DecideResult): { ok: true } | { ok: false; leadChoice: string } => {
  if (r.ok) return { ok: true };
  if (r.code === "LEAD_CHOICE") return { ok: false, leadChoice: r.lead };
  throw new TRPCError({ code: r.code, message: r.code === "CONFLICT" ? "Already decided" : "Request not found" });
};

const LINK = /^(crew|truck|cc|invite):([A-Za-z0-9_-]{4,64})$/;

export const accessRouter = router({
  /** The scanned link waiting for sign-in, as a label for the sign-in page. */
  link: publicProcedure.query(({ ctx }): { label: string } | null => {
    const m = LINK.exec(ctx.joinLink ?? "");
    if (!m) return null;
    if (m[1] === "invite") {
      const invite = inviteByToken(m[2]!);
      return invite && stateOf(invite) === "active" ? { label: inviteLabel(invite) } : null;
    }
    const label = linkLabel(m[1] as LinkKind, m[2]!);
    return label ? { label } : null;
  }),

  // #region the signed-in user
  mine: userProcedure.query(({ ctx }) => mine(ctx.user.id)),

  options: userProcedure.query(() => requestOptions()),

  request: userProcedure
    .input(
      z.union([
        z.object({ role: z.enum(["crew", "driver", "green"]), dayId: id, ccId: id, crewId: id.nullish(), truckId: id.nullish() }),
        z.object({ role: z.literal("admin") }),
      ]),
    )
    .mutation(({ ctx, input }) => {
      const r = requestAccess(ctx.user.id, input);
      if (!r.ok) throw new TRPCError({ code: "BAD_REQUEST", message: r.error });
      return { id: r.membership.id, status: r.membership.status };
    }),

  cancel: userProcedure.input(z.object({ id })).mutation(({ ctx, input }) => {
    if (!cancelRequest(ctx.user.id, input.id)) throw new TRPCError({ code: "NOT_FOUND", message: "Request not found" });
    return { ok: true };
  }),

  /** Moves this session into one of the user's approved memberships (the chooser). */
  enter: userProcedure.input(z.object({ id })).mutation(({ ctx, input }) => {
    // Only what the chooser offers: on an event day, today's memberships (SPEC 18).
    const m = candidates(ctx.user.id).find((c) => c.id === input.id);
    if (!m || !enterMembership(ctx.session.id, m)) throw new TRPCError({ code: "NOT_FOUND", message: "Access not found" });
    return { role: m.role };
  }),

  /**
   * The user's own requests changing: approved, denied, withdrawn, or created
   * by a QR scan on another phone. Ends with UNAUTHORIZED when the session goes.
   */
  onMine: userProcedure.subscription(async function* ({ ctx, signal }) {
    const userId = ctx.user.id;
    const sessionId = ctx.session.id;
    for await (const msg of bus.listen(signal)) {
      if (msg.type === "scope.check") {
        if (!db.select({ id: sessions.id }).from(sessions).where(eq(sessions.id, sessionId)).get()) {
          throw new TRPCError({ code: "UNAUTHORIZED", message: "Sign in" });
        }
        continue;
      }
      if (msg.type === "membership.changed" && msg.payload.userId === userId) {
        yield { membershipId: msg.payload.membershipId, status: msg.payload.status };
      }
    }
  }),
  // #endregion

  // #region green shirts: their CC
  pending: greenProcedure.query(({ ctx }) => ({ pending: pendingRequests(ctx.cc.id), recent: recentDecisions(ctx.cc.id) })),

  pendingCount: greenProcedure.query(({ ctx }) => pendingRequests(ctx.cc.id).length),

  decide: greenProcedure.input(decision).mutation(({ ctx, input }) =>
    decided(decide(input.id, input.decision, { userId: ctx.session.userId, ccId: ctx.cc.id, admin: false }, input.lead)),
  ),
  // #endregion

  // #region admin: every CC
  adminPending: adminProcedure.query(() => ({ pending: pendingRequests(null), recent: recentDecisions(null, 40) })),

  adminPendingCount: adminProcedure.query(() => pendingRequests(null).length),

  adminDecide: adminProcedure.input(decision).mutation(({ ctx, input }) =>
    decided(decide(input.id, input.decision, { userId: ctx.session.userId, ccId: null, admin: true }, input.lead)),
  ),
  // #endregion
});
