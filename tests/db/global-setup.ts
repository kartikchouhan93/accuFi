import { execFileSync } from "node:child_process"
import type { TestProject } from "vitest/node"

// Runs once per vitest invocation, before any test file. `prisma migrate deploy` creates the database
// if it is missing and applies pending migrations, so this is idempotent and safe to run twice in a row
// (the suite runs once per timezone, each in its own vitest process). The URL is the one vitest.config.ts
// gave the workers, so setup and tests always agree on which database they use.
export default function setup(project: TestProject) {
  const databaseUrl = project.config.env?.DATABASE_URL
  if (!databaseUrl) throw new Error("vitest.config.ts did not set a test DATABASE_URL")
  execFileSync("bunx", ["prisma", "migrate", "deploy"], {
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: "inherit",
  })
}
