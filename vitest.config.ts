import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

// Vitest does not expose .env to tests; load it so APP_URL matches the running stack.
try {
  process.loadEnvFile()
} catch {
  // no .env file: fall back to the defaults below
}

// Tests that touch Postgres never run against the dev database. They use a sibling database named
// `<dev database>_test` on the same server (or TEST_DATABASE_URL), created and migrated by
// tests/db/global-setup.ts. This lives here, not under tests/, because `next build` type-checks this file
// and the Docker build context excludes tests/.
function testDatabaseUrl(): string {
  const explicit = process.env.TEST_DATABASE_URL
  const base = process.env.DATABASE_URL
  if (!explicit && !base) {
    throw new Error("Set DATABASE_URL (or TEST_DATABASE_URL) so the test database can be located")
  }
  const url = new URL((explicit ?? base) as string)
  if (!explicit) url.pathname = `${url.pathname}_test`
  // Last line of defence: never hand a database that is not named `*_test` to a suite that writes to it.
  if (!/^\/[^/]+_test$/.test(url.pathname)) {
    throw new Error(`Refusing to run tests against "${url.pathname.slice(1)}": the database name must end in "_test"`)
  }
  return url.toString()
}

// Vitest does not read the tsconfig `paths`; mirror `@/*` -> `./src/*` so tests can use the alias.
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
    // Workers get DATABASE_URL pointing at the dedicated test database, never the dev one.
    env: { APP_URL: process.env.APP_URL ?? "http://localhost:3000", DATABASE_URL: testDatabaseUrl() },
    globalSetup: ["./tests/db/global-setup.ts"],
  },
})
