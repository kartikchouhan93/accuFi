import { defineConfig, devices } from "@playwright/test"

// The end-to-end suite is separate from Vitest (`bun run test:e2e`, not `bun run test`) because it boots a real server
// and a real browser. Like the Vitest suites it never touches the dev database: the server it starts and the fixtures
// that seed users both use the sibling `<dev database>_test` database (or TEST_DATABASE_URL).
// This file is type-checked by `next build` and the Docker build context excludes tests/, so it imports nothing from there.

try {
  process.loadEnvFile()
} catch {
  // no .env file: DATABASE_URL must already be in the environment
}

function testDatabaseUrl(): string {
  const explicit = process.env.TEST_DATABASE_URL
  const base = process.env.DATABASE_URL
  if (!explicit && !base) throw new Error("Set DATABASE_URL (or TEST_DATABASE_URL) so the test database can be located")
  const url = new URL((explicit ?? base) as string)
  // Idempotent: this file is evaluated again in every worker, after the line below has already pointed DATABASE_URL at
  // the test database, so a name that already ends in `_test` is left alone.
  if (!explicit && !url.pathname.endsWith("_test")) url.pathname = `${url.pathname}_test`
  if (!/^\/[^/]+_test$/.test(url.pathname)) {
    throw new Error(`Refusing to run e2e tests against "${url.pathname.slice(1)}": the database name must end in "_test"`)
  }
  return url.toString()
}

// Every worker re-reads this file, so the fixtures (which import the server code) see the same test database.
process.env.DATABASE_URL = testDatabaseUrl()

// Not APP_PORT: that port belongs to the Docker stack, which runs a build of whatever was last `compose up --build`
// and is pointed at the dev database. The suite starts its own `next dev` on a port of its own.
const port = Number(process.env.E2E_PORT ?? 3200)
const baseURL = `http://localhost:${port}`

export default defineConfig({
  testDir: "tests/e2e",
  testMatch: "**/*.spec.ts",
  globalSetup: "./tests/e2e/global-setup.ts",
  fullyParallel: true,
  // Each test signs in its own user, so tests do not share state; a server on `next dev` compiles routes on first hit.
  workers: process.env.CI ? 2 : 4,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL,
    trace: "retain-on-failure",
    // The installed Google Chrome, so `bunx playwright install` (a browser download) is not needed.
    channel: "chrome",
  },
  projects: [{ name: "chrome", use: { ...devices["Desktop Chrome"], channel: "chrome" } }],
  webServer: {
    command: `bunx next dev --port ${port}`,
    // /login rather than /api/health: it answers before the test database has been migrated (globalSetup runs after this).
    url: `${baseURL}/login`,
    // Never adopt a server that might be pointed at the dev database.
    reuseExistingServer: false,
    timeout: 120_000,
    // RECURRING_SWEEP off: a background sweep must not generate occurrences underneath a test that seeds its own rules.
    env: { DATABASE_URL: process.env.DATABASE_URL, AUTH_URL: baseURL, RECURRING_SWEEP: "off" },
  },
})
