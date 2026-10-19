import { createHash } from "node:crypto"
import { normaliseEmail } from "@/lib/email"
import { prisma } from "@/server/db"

// Fixed-window attempt counters for the auth endpoints (spec §9.5), kept in Postgres so they survive a restart.
// Both the arithmetic and the clock are the database's: one INSERT ... ON CONFLICT statement is atomic, so
// concurrent attempts cannot lose an increment, and app/DB clock skew cannot stretch a window.

export const RATE_LIMIT = { maxAttempts: 10, windowSeconds: 15 * 60 } as const

// A second, coarser ceiling on one account, keyed on the email alone. The IP in the finer key is only as trustworthy
// as the deployment, so nothing the client sends (headers, rotating addresses) may enlarge this budget. It is
// higher than the per-address limit so a user at a new address is not locked out by a handful of typos, at the
// cost that sustained guessing from many addresses can lock a victim out for up to one window.
// What actually locks an account depends on TRUSTED_PROXY_HOPS. At the shipped default (0) every client shares the
// address "unknown", so the per-(address, email) counter is effectively per-account and trips first, at
// RATE_LIMIT.maxAttempts (10). Only once a proxy is declared do addresses differ, and then 30 is the threshold.
export const ACCOUNT_MAX_ATTEMPTS = 30

// Signup answers "this email already exists", so it can be used to probe which addresses have accounts. The
// per-email key gives every probed address a fresh budget, so bulk probing is bounded by a per-address ceiling too.
// With no trusted proxy declared every client shares the address "unknown", which makes this effectively global.
export const SIGNUP_IP_MAX_ATTEMPTS = 30

// Expired counters are deleted on roughly this fraction of calls, so unauthenticated traffic that varies the email
// cannot grow the table beyond what one window's worth of requests inserts.
const SWEEP_PROBABILITY = 0.01

/**
 * The counter key for one scope ("login", "signup"), client IP and submitted email. Hashed so the table never
 * holds an address or an email in the clear; the email is normalised so changing its case buys no fresh attempts.
 */
export function rateLimitKey(scope: "login" | "signup", ip: string, email: string): string {
  return createHash("sha256").update([scope, ip, normaliseEmail(email)].join("\0")).digest("hex")
}

/** The per-account counter key: the normalised email only, never the address, so no client input can fork it. */
export function accountKey(email: string): string {
  return createHash("sha256").update(["account", normaliseEmail(email)].join("\0")).digest("hex")
}

/** A per-address counter key for one scope. */
export function ipKey(scope: "signup", ip: string): string {
  return createHash("sha256").update([`${scope}-ip`, ip].join("\0")).digest("hex")
}

export type AttemptResult = { allowed: boolean; attempts: number; retryAfterSeconds: number }

/** Delete every counter whose window has ended. */
export async function sweepExpired(): Promise<void> {
  await prisma.$executeRaw`
    DELETE FROM "RateLimitCounter"
    WHERE "windowStart" <= now() - make_interval(secs => ${RATE_LIMIT.windowSeconds}::double precision)`
}

/** Count one attempt against `key`. `allowed` is false once the window already holds more than `maxAttempts`. */
export async function consumeAttempt(key: string, maxAttempts: number = RATE_LIMIT.maxAttempts): Promise<AttemptResult> {
  const { windowSeconds } = RATE_LIMIT
  if (Math.random() < SWEEP_PROBABILITY) await sweepExpired().catch(() => undefined) // housekeeping must not fail a login
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
export async function isLimited(key: string, maxAttempts: number = RATE_LIMIT.maxAttempts): Promise<boolean> {
  const { windowSeconds } = RATE_LIMIT
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

/** One signup attempt: the per-address ceiling first (so a refused probe burns nothing else), then per address and email. */
export async function consumeSignupAttempt(ip: string, email: string): Promise<AttemptResult> {
  const perAddress = await consumeAttempt(ipKey("signup", ip), SIGNUP_IP_MAX_ATTEMPTS)
  if (!perAddress.allowed) return perAddress
  return consumeAttempt(rateLimitKey("signup", ip, email))
}
