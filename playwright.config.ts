import { defineConfig, devices } from "@playwright/test";
import { INVITE_CODE, STORAGE_STATE } from "./e2e/fixtures";

// End-to-end suite: a production build (`next build`, see README) served by
// `next start`, with TMDB replaced by e2e/tmdb-stub.mjs.
const PORT = 3100;
const TMDB_STUB_PORT = 3101;
const baseURL = `http://localhost:${PORT}`;

// The suite creates accounts and titles, so it only runs against a local
// database, never one named by .env.local.
const databaseUrl =
  process.env.E2E_DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/celluloid_e2e";
if (!["localhost", "127.0.0.1"].includes(new URL(databaseUrl).hostname)) {
  throw new Error("E2E_DATABASE_URL must name a database on localhost or 127.0.0.1.");
}

export default defineConfig({
  testDir: "e2e",
  // Serial: the specs after sign-up share its account, and Better Auth allows
  // 5 sign-ups a minute per IP. auth.spec.ts makes 2 per run.
  workers: 1,
  forbidOnly: !!process.env.CI,
  // In CI a failed test gets one retry, for a second trace, but a test that
  // only passes on its retry still fails the run.
  retries: process.env.CI ? 1 : 0,
  failOnFlakyTests: !!process.env.CI,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  expect: { timeout: 10_000 },
  use: {
    ...devices["Desktop Chrome"],
    baseURL,
    trace: "retain-on-failure",
  },
  projects: [
    { name: "auth", testMatch: /auth\.spec\.ts$/ },
    {
      name: "app",
      testIgnore: /auth\.spec\.ts$/,
      dependencies: ["auth"],
      use: { storageState: STORAGE_STATE },
    },
  ],
  webServer: [
    {
      command: "node e2e/tmdb-stub.mjs",
      port: TMDB_STUB_PORT,
      env: { TMDB_STUB_PORT: String(TMDB_STUB_PORT) },
      reuseExistingServer: !process.env.CI,
    },
    {
      command: `npx next start --port ${PORT}`,
      url: `${baseURL}/login`,
      reuseExistingServer: !process.env.CI,
      // Placeholders only. Values set here win over .env.local.
      env: {
        DATABASE_URL: databaseUrl,
        BETTER_AUTH_SECRET: "e2e-placeholder-secret-not-a-real-secret-0000",
        BETTER_AUTH_URL: baseURL,
        NEXT_PUBLIC_SITE_URL: baseURL,
        ENCRYPTION_KEY: "e2e-placeholder-encryption-key-not-real-0000",
        TMDB_ACCESS_TOKEN: "e2e-placeholder-tmdb-token-not-real-0000",
        TMDB_API_BASE_URL: `http://127.0.0.1:${TMDB_STUB_PORT}`,
        SIGNUP_INVITE_CODE: INVITE_CODE,
        // env.ts holds self-hosted `next start` to production rules: HTTPS
        // origins and a JWT-shaped TMDB token. This server is plain
        // http://localhost, so it runs as a Vercel preview deployment does,
        // with those checks relaxed. Only that production test (which
        // src/lib/tmdb.ts repeats for TMDB_API_BASE_URL) reads VERCEL.
        VERCEL: "1",
      },
    },
  ],
});
