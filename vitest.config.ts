import { defineConfig } from "vitest/config"

// Vitest does not expose .env to tests; load it so APP_URL matches the running stack.
try {
  process.loadEnvFile()
} catch {
  // no .env file: fall back to the defaults below
}

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
    env: { APP_URL: process.env.APP_URL ?? "http://localhost:3000" },
  },
})
