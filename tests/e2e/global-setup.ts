import { execFileSync } from "node:child_process"

// Brings the test database up to date before the server starts. `prisma migrate deploy` creates the database if it is
// missing and is idempotent, exactly as in tests/db/global-setup.ts. DATABASE_URL is the test database (see
// playwright.config.ts), which every process of the run inherits.
export default function globalSetup() {
  execFileSync("bunx", ["prisma", "migrate", "deploy"], { env: process.env, stdio: "inherit" })
}
