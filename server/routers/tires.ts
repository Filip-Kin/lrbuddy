import { z } from "zod";
import { addPile, deletePile, listPiles, movePile, setPileCount, type TireActor } from "../tires.ts";
import { ccProcedure, router } from "../trpc.ts";

const point = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) });

const actor = (ctx: TireActor): TireActor => ({ session: ctx.session, cc: ctx.cc, day: ctx.day, event: ctx.event, crew: ctx.crew, truck: ctx.truck });

/** Tire piles at the session's CC and day (SPEC 29). Any role reads; the rules per action live in `tires.ts`. */
export const tiresRouter = router({
  list: ccProcedure.query(({ ctx }) => listPiles(actor(ctx))),
  add: ccProcedure
    .input(point.extend({ count: z.number().int().min(1).max(999).nullish(), side: z.enum(["left", "right"]).nullish() }))
    .mutation(({ ctx, input }) => addPile(actor(ctx), input)),
  setCount: ccProcedure.input(z.object({ id: z.number().int(), count: z.number().int().min(1).max(999).nullable() })).mutation(({ ctx, input }) => setPileCount(actor(ctx), input.id, input.count)),
  move: ccProcedure.input(point.extend({ id: z.number().int() })).mutation(({ ctx, input }) => movePile(actor(ctx), input.id, input)),
  remove: ccProcedure.input(z.object({ id: z.number().int() })).mutation(({ ctx, input }) => deletePile(actor(ctx), input.id)),
});
