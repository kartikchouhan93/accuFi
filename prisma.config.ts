import { defineConfig } from "prisma/config"

// Prisma stops reading .env on its own once a config file exists, so load it here. The Docker image has no .env
// (its variables come from the compose file), hence the empty catch.
try {
  process.loadEnvFile()
} catch {
  // no .env file: DATABASE_URL must already be in the environment
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "bun prisma/seed.ts",
  },
})
