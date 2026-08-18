import { defineConfig, devices } from "@playwright/test";

/**
 * Read environment variables from file.
 * https://github.com/motdotla/dotenv
 */
import dotenv from "dotenv";
import path from "path";
dotenv.config({ path: path.resolve(import.meta.dirname, "../../packages/database/.env.test") });
console.log("[playwright] E2E_AUTH_BYPASS =", JSON.stringify(process.env.E2E_AUTH_BYPASS));

/**
 * See https://playwright.dev/docs/test-configuration.
 */
export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  /* Run tests in files in parallel */
  fullyParallel: true,
  /* Fail the build on CI if you accidentally left test.only in the source code. */
  forbidOnly: !!process.env.CI,
  /* Retry on CI only */
  retries: process.env.CI ? 2 : 0,
  /* Opt out of parallel tests on CI. */
  //workers: process.env.CI ? 1 : undefined,
  workers: 1,
  /* Reporter to use. See https://playwright.dev/docs/test-reporters */
  reporter: "html",
  /* Shared settings for all the projects below. See https://playwright.dev/docs/api/class-testoptions. */
  use: {
    /* Base URL to use in actions like `await page.goto('')`. */
    baseURL: "http://localhost:5174",

    /* Collect trace when retrying the failed test. See https://playwright.dev/docs/trace-viewer */
    trace: "on-first-retry",
  },

  /* Configure projects for major browsers */
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },

    // {
    //   name: 'firefox',
    //   use: { ...devices['Desktop Firefox'] },
    // },

    // {
    //   name: 'webkit',
    //   use: { ...devices['Desktop Safari'] },
    // },

    /* Test against mobile viewports. */
    // {
    //   name: 'Mobile Chrome',
    //   use: { ...devices['Pixel 5'] },
    // },
    // {
    //   name: 'Mobile Safari',
    //   use: { ...devices['iPhone 12'] },
    // },

    /* Test against branded browsers. */
    // {
    //   name: 'Microsoft Edge',
    //   use: { ...devices['Desktop Edge'], channel: 'msedge' },
    // },
    // {
    //   name: 'Google Chrome',
    //   use: { ...devices['Desktop Chrome'], channel: 'chrome' },
    // },
  ],

  /* Run your local dev server before starting the tests */
  webServer: {
    command: "npm run dev -- --port 5174",
    url: "http://localhost:5174/health",
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      DATABASE_URL: process.env.DATABASE_URL!,
      SESSION_SECRET: process.env.SESSION_SECRET!,
      E2E_AUTH_BYPASS: process.env.E2E_AUTH_BYPASS!,
      // Tests must never touch the real ReserveCalifornia API: seeded facility
      // ids are fake, and background scans fire without a test awaiting them.
      RC_API_OFFLINE: "1",
      AUTH0_DOMAIN: process.env.AUTH0_DOMAIN ?? "test.auth0.com",
      AUTH0_CLIENT_ID: process.env.AUTH0_CLIENT_ID ?? "test-client-id",
      AUTH0_CLIENT_SECRET: process.env.AUTH0_CLIENT_SECRET ?? "test-client-secret",
      AUTH0_CALLBACK_URL: process.env.AUTH0_CALLBACK_URL ?? "http://localhost:5174/auth/callback",
      AUTH0_AUDIENCE: process.env.AUTH0_AUDIENCE ?? "https://test-api",
    },
  },
});
