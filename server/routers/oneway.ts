import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { onewayInBBox, type OnewayView } from "../oneway.ts";
import { authedProcedure, router } from "../trpc.ts";

/** Widest view a map may ask for, in degrees (about 15 km): zoom 15 on a wide laptop screen fits inside. */
const MAX_SPAN = 0.15;

export const onewayRouter = router({
  /**
   * Cached one-way streets in a map's view (SPEC 20), for every role with a
   * screen. Street directions are public map data, so no CC scope applies.
   */
  inView: authedProcedure
    .input(z.object({ w: z.number().min(-180).max(180), s: z.number().min(-90).max(90), e: z.number().min(-180).max(180), n: z.number().min(-90).max(90) }))
    .query(({ ctx, input }): OnewayView[] => {
      if (ctx.session.role === "none") throw new TRPCError({ code: "FORBIDDEN", message: "Not allowed" });
      if (input.e < input.w || input.n < input.s) throw new TRPCError({ code: "BAD_REQUEST", message: "Bad bounds" });
      if (input.e - input.w > MAX_SPAN || input.n - input.s > MAX_SPAN) return [];
      return onewayInBBox([input.w, input.s, input.e, input.n]);
    }),
});
