import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

// Vitest does not expose .env to tests; load it so APP_URL matches the running stack.
try {
  process.loadEnvFile()
} catch {
  // no .env file: fall back to the defaults below
}

// Vitest does not read the tsconfig `paths`; mirror `@/*` -> `./src/*` so tests can use the alias.
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
    env: { APP_URL: process.env.APP_URL ?? "http://localhost:3000" },
  },
})
