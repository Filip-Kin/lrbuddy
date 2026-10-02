import { defineConfig } from "@playwright/test";
import type { LaneOptions } from "./tests/e2e/support/fixtures.ts";

/**
 * End-to-end suite (`bun run e2e`). globalSetup builds the web bundle, seeds fresh temp databases
 * and starts the servers with the network faked; README "End-to-end tests" has the details.
 *
 * Two projects run the same specs: phone (390x844, touch) and laptop (1440x900). They share one
 * server, so each project works in its own lane of the seed (lane a: CC East, Truck 1, crews 1 to
 * 6; lane b: CC West, Truck 3, crews 7 to 12; tests/e2e/support/lanes.ts). Files run in parallel;
 * the tests inside a file run in order on one worker.
 */
export default defineConfig<LaneOptions>({
  testDir: "tests/e2e/specs",
  // Not *.spec.ts or *.test.ts: `bun test` would pick those up.
  testMatch: "**/*.e2e.ts",
  globalSetup: "./tests/e2e/support/global-setup.ts",
  fullyParallel: false,
  workers: Number(process.env.E2E_WORKERS ?? 6),
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  forbidOnly: true,
  reporter: [["list"], ["json", { outputFile: "tests/e2e/.results/report.json" }]],
  outputDir: "tests/e2e/.results/artifacts",
  use: {
    browserName: "chromium",
    launchOptions: {
      executablePath: "/usr/bin/chromium",
      args: ["--no-sandbox", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
    },
    deviceScaleFactor: 1,
    colorScheme: "light",
    timezoneId: "America/Detroit",
    locale: "en-US",
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "phone", use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, lane: "a" } },
    { name: "laptop", use: { viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false, lane: "b" } },
  ],
});
