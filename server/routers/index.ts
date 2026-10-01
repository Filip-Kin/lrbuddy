import { router } from "../trpc.ts";
import { accessRouter } from "./access.ts";
import { adminRouter } from "./admin.ts";
import { crewRouter } from "./crew.ts";
import { driverRouter } from "./driver.ts";
import { greenRouter } from "./green.ts";
import { onewayRouter } from "./oneway.ts";
import { alleysRouter } from "./alleys.ts";
import { planRouter } from "./plan.ts";
import { sharedRouter } from "./shared.ts";

export const appRouter = router({
  shared: sharedRouter,
  crew: crewRouter,
  driver: driverRouter,
  green: greenRouter,
  admin: adminRouter,
  plan: planRouter,
  access: accessRouter,
  oneway: onewayRouter,
  alleys: alleysRouter,
});

export type AppRouter = typeof appRouter;
