import { z } from "zod";
import { alleysIn, type AlleyLine } from "../alleys.ts";
import { authedProcedure, router } from "../trpc.ts";

/** Views wider than this get nothing, like the one-way arrows: a city of alleys is noise. */
const MAX_VIEW_DEG = 0.15;

export const alleysRouter = router({
  /** OpenStreetMap alley centrelines in a map's view (SPEC 24): a hint for Draw lot. Public map data, so no CC scope. */
  inView: authedProcedure.input(z.object({ w: z.number(), s: z.number(), e: z.number(), n: z.number() })).query(({ input }): AlleyLine[] => {
    if (input.e - input.w > MAX_VIEW_DEG || input.n - input.s > MAX_VIEW_DEG) return [];
    return alleysIn([input.w, input.s, input.e, input.n]);
  }),
});
