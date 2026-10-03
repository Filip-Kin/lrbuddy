import { router } from "../trpc.ts";
import { assignmentsRouter, crewsRouter } from "./plan/assignments.ts";
import { blocksRouter } from "./plan/blocks.ts";
import { inventoryRouter } from "./plan/inventory.ts";
import { printRouter } from "./plan/print.ts";
import { parcelsRouter, surveyRouter } from "./plan/survey.ts";

/** Planning portal (SPEC 16). Admin only; every procedure works on the active event unless given another. */
export const planRouter = router({
  parcels: parcelsRouter,
  survey: surveyRouter,
  blocks: blocksRouter,
  assignments: assignmentsRouter,
  crews: crewsRouter,
  print: printRouter,
  inventory: inventoryRouter,
});
