import { createHash } from "node:crypto"
import { normaliseEmail } from "@/lib/email"
import { prisma } from "@/server/db"

// Fixed-window attempt counters for the auth endpoints (spec §9.5), kept in Postgres so they survive a restart.
// Both the arithmetic and the clock are the database's: one INSERT ... ON CONFLICT statement is atomic, so
// concurrent attempts cannot lose an increment, and app/DB clock skew cannot stretch a window.

export const RATE_LIMIT = { maxAttempts: 10, windowSeconds: 15 * 60 } as const

/**
 * The counter key for one scope ("login", "signup"), client IP and submitted email. Hashed so the table never
 * holds an address or an email in the clear; the email is normalised so changing its case buys no fresh attempts.
 */
export function rateLimitKey(scope: "login" | "signup", ip: string, email: string): string {
  return createHash("sha256").update([scope, ip, normaliseEmail(email)].join("\0")).digest("hex")
}

export type AttemptResult = { allowed: boolean; attempts: number; retryAfterSeconds: number }

/** Count one attempt against `key`. `allowed` is false once the window already holds more than the maximum. */
export async function consumeAttempt(key: string): Promise<AttemptResult> {
  const { windowSeconds, maxAttempts } = RATE_LIMIT
  const rows = await prisma.$queryRaw<{ count: number; retryAfter: number }[]>`
    INSERT INTO "RateLimitCounter" ("key", "windowStart", "count")
    VALUES (${key}, now(), 1)
    ON CONFLICT ("key") DO UPDATE SET
      "count" = CASE
        WHEN "RateLimitCounter"."windowStart" <= now() - make_interval(secs => ${windowSeconds}::double precision)
        THEN 1 ELSE "RateLimitCounter"."count" + 1 END,
      "windowStart" = CASE
        WHEN "RateLimitCounter"."windowStart" <= now() - make_interval(secs => ${windowSeconds}::double precision)
        THEN now() ELSE "RateLimitCounter"."windowStart" END
    RETURNING "count",
      GREATEST(1, CEIL(EXTRACT(EPOCH FROM ("windowStart" + make_interval(secs => ${windowSeconds}::double precision) - now()))))::int AS "retryAfter"`
  const { count, retryAfter } = rows[0]
  return { allowed: count <= maxAttempts, attempts: count, retryAfterSeconds: retryAfter }
}

/** True when `key` has used its whole allowance in the current window, so the next attempt would be refused.
 * Reads only: it does not use up an attempt. */
export async function isLimited(key: string): Promise<boolean> {
  const { windowSeconds, maxAttempts } = RATE_LIMIT
  const rows = await prisma.$queryRaw<{ limited: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM "RateLimitCounter"
      WHERE "key" = ${key}
        AND "windowStart" > now() - make_interval(secs => ${windowSeconds}::double precision)
        AND "count" >= ${maxAttempts}
    ) AS "limited"`
  return rows[0].limited
}

export async function clearAttempts(key: string): Promise<void> {
  await prisma.rateLimitCounter.deleteMany({ where: { key } })
}
