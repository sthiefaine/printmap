import { defineConfig, devices } from "@playwright/test";

const production =
  !!process.env.CI || process.env.PRINTMAP_TEST_PRODUCTION === "1";
const port = Number(process.env.PRINTMAP_TEST_PORT || 3100);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 90_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL,
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
  },
  webServer: {
    command: `npm run ${production ? "start" : "dev"} -- --hostname 127.0.0.1 --port ${port}`,
    url: baseURL,
    reuseExistingServer: !production,
    timeout: 120_000,
  },
});
