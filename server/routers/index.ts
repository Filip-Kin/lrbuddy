import { router } from "../trpc.ts";
import { adminRouter } from "./admin.ts";
import { crewRouter } from "./crew.ts";
import { driverRouter } from "./driver.ts";
import { greenRouter } from "./green.ts";
import { sharedRouter } from "./shared.ts";

export const appRouter = router({
  shared: sharedRouter,
  crew: crewRouter,
  driver: driverRouter,
  green: greenRouter,
  admin: adminRouter,
});

export type AppRouter = typeof appRouter;
