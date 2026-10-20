import { randomUUID } from "node:crypto"
import { afterAll, afterEach, describe, expect, it, vi } from "vitest"
import { prisma } from "@/server/db"
import { clientIp } from "@/server/client-ip"
import {
  accountKey,
  ACCOUNT_MAX_ATTEMPTS,
  clearAttempts,
  consumeAttempt,
  consumeSignupAttempt,
  ipKey,
  isLimited,
  rateLimitKey,
  RATE_LIMIT,
  SIGNUP_IP_MAX_ATTEMPTS,
  sweepExpired,
} from "@/server/rate-limit"
import { authenticate, RateLimitedError } from "@/server/services/login-service"
import { createAccount } from "@/server/services/signup-service"

// Writes to the dedicated test database. Every test uses a random email and IP, so counters never collide.
// The address is the same UUID that names the email, laid out as an IPv6 address (128 bits, 8 groups of 4 hex
// digits), so two tests can never draw the same address; a small random octet could, and one test would then
// find another's budget already spent.
const keys: string[] = []
const emails: string[] = []
const fresh = () => {
  const id = randomUUID()
  const email = `${id}@ratelimit.test`
  const ip = id.replaceAll("-", "").match(/.{4}/g)!.join(":")
  const key = rateLimitKey("login", ip, email)
  keys.push(key, accountKey(email), ipKey("signup", ip))
  emails.push(email)
  return { email, ip, key }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

afterAll(async () => {
  await prisma.rateLimitCounter.deleteMany({ where: { key: { in: keys } } })
  const users = await prisma.user.findMany({ where: { email: { in: emails } }, select: { id: true } })
  const ids = users.map((u) => u.id)
  await prisma.ledgerNode.deleteMany({ where: { userId: { in: ids } } })
  await prisma.user.deleteMany({ where: { id: { in: ids } } })
  await prisma.$disconnect()
})

describe("the fixed-window counter", () => {
  it("allows 10 attempts per window and refuses the eleventh", async () => {
    const { key } = fresh()
    expect(RATE_LIMIT).toMatchObject({ maxAttempts: 10, windowSeconds: 15 * 60 })
    for (let i = 1; i <= 10; i++) {
      expect((await consumeAttempt(key)).allowed, `attempt ${i}`).toBe(true)
    }
    const eleventh = await consumeAttempt(key)
    expect(eleventh.allowed).toBe(false)
    expect(eleventh.retryAfterSeconds).toBeGreaterThan(0)
    expect(eleventh.retryAfterSeconds).toBeLessThanOrEqual(15 * 60)
  })

  it("counts concurrent attempts exactly, without losing increments", async () => {
    const { key } = fresh()
    const results = await Promise.all(Array.from({ length: 25 }, () => consumeAttempt(key)))
    expect(results.filter((r) => r.allowed)).toHaveLength(10)
    expect(results.filter((r) => !r.allowed)).toHaveLength(15)
  })

  it("isLimited is true once the allowance is used up, and reading it consumes nothing", async () => {
    const { key } = fresh()
    for (let i = 0; i < 9; i++) await consumeAttempt(key)
    expect(await isLimited(key)).toBe(false) // one attempt still available
    expect(await isLimited(key)).toBe(false) // and asking did not use it
    expect((await consumeAttempt(key)).allowed).toBe(true) // the tenth
    expect(await isLimited(key)).toBe(true) // the eleventh would be refused
    expect(await isLimited(key)).toBe(true)
    const row = await prisma.rateLimitCounter.findUniqueOrThrow({ where: { key } })
    expect(row.count).toBe(10)
  })

  it("starts a new window once the old one has expired", async () => {
    const { key } = fresh()
    for (let i = 0; i < 11; i++) await consumeAttempt(key)
    expect(await isLimited(key)).toBe(true)
    await prisma.$executeRaw`UPDATE "RateLimitCounter" SET "windowStart" = now() - interval '16 minutes' WHERE key = ${key}`
    expect(await isLimited(key)).toBe(false)
    expect((await consumeAttempt(key)).allowed).toBe(true)
    const row = await prisma.rateLimitCounter.findUniqueOrThrow({ where: { key } })
    expect(row.count).toBe(1)
  })

  it("keeps separate counters per IP and per email", async () => {
    const a = fresh()
    for (let i = 0; i < 11; i++) await consumeAttempt(a.key)
    expect(await isLimited(a.key)).toBe(true)
    expect(await isLimited(rateLimitKey("login", a.ip, `other-${a.email}`))).toBe(false)
    expect(await isLimited(rateLimitKey("login", "198.51.100.1", a.email))).toBe(false)
    expect(await isLimited(rateLimitKey("signup", a.ip, a.email))).toBe(false)
  })

  it("normalises the email so changing its case does not buy fresh attempts", () => {
    expect(rateLimitKey("login", "1.2.3.4", "A@B.com")).toBe(rateLimitKey("login", "1.2.3.4", " a@b.COM "))
  })

  it("clearAttempts resets the counter", async () => {
    const { key } = fresh()
    for (let i = 0; i < 11; i++) await consumeAttempt(key)
    await clearAttempts(key)
    expect(await isLimited(key)).toBe(false)
    expect((await consumeAttempt(key)).allowed).toBe(true)
  })

  it("never stores the IP or email in the clear", async () => {
    const { key, ip, email } = fresh()
    await consumeAttempt(key)
    const rows = await prisma.rateLimitCounter.findMany({ where: { key } })
    expect(JSON.stringify(rows)).not.toContain(ip)
    expect(JSON.stringify(rows)).not.toContain(email)
  })
})

describe("login attempts are rate limited", () => {
  it("refuses the eleventh attempt, even with the right password", async () => {
    const { email, ip } = fresh()
    await createAccount({ email, password: "correct horse" })
    for (let i = 1; i <= 10; i++) {
      expect(await authenticate({ email, password: `wrong-${i}`, ip }), `attempt ${i}`).toBeNull()
    }
    await expect(authenticate({ email, password: "correct horse", ip })).rejects.toThrow(RateLimitedError)
  })

  it("clears the counter on a successful login", async () => {
    const { email, ip, key } = fresh()
    await createAccount({ email, password: "correct horse" })
    for (let i = 0; i < 9; i++) await authenticate({ email, password: "wrong", ip })
    expect(await authenticate({ email, password: "correct horse", ip })).not.toBeNull()
    const row = await prisma.rateLimitCounter.findUnique({ where: { key } })
    expect(row).toBeNull()
    // a full allowance is available again
    for (let i = 0; i < 10; i++) expect(await authenticate({ email, password: "wrong", ip })).toBeNull()
  })

  it("limits unknown emails exactly as it limits real ones, so the limit leaks nothing", async () => {
    const { email, ip } = fresh() // no account behind this email
    for (let i = 0; i < 10; i++) expect(await authenticate({ email, password: "whatever", ip })).toBeNull()
    await expect(authenticate({ email, password: "whatever", ip })).rejects.toThrow(RateLimitedError)
  })

  it("does not let one IP and email lock out the same account from another IP", async () => {
    const { email, ip } = fresh()
    await createAccount({ email, password: "correct horse" })
    for (let i = 0; i < 11; i++) await authenticate({ email, password: "wrong", ip }).catch(() => null)
    const other = await authenticate({ email, password: "correct horse", ip: "198.51.100.77" })
    expect(other).not.toBeNull()
    keys.push(rateLimitKey("login", "198.51.100.77", email))
  })
})

describe("the limit cannot be reset by anything the client sends", () => {
  it("a rotating X-Forwarded-For earns no fresh budget while no proxy is declared", async () => {
    vi.stubEnv("TRUSTED_PROXY_HOPS", "")
    const { email } = fresh()
    await createAccount({ email, password: "correct horse" })
    // The attacker sends a different forged address with every request.
    const attempt = (i: number, password: string) =>
      authenticate({ email, password, ip: clientIp(new Headers({ "x-forwarded-for": `198.51.100.${i}` })) })
    for (let i = 1; i <= 10; i++) expect(await attempt(i, `wrong-${i}`), `attempt ${i}`).toBeNull()
    await expect(attempt(11, "correct horse")).rejects.toThrow(RateLimitedError)
    await expect(attempt(12, "correct horse")).rejects.toThrow(RateLimitedError)
    keys.push(rateLimitKey("login", "unknown", email))
  })

  it("even behind a declared proxy, rotating source addresses cannot exceed the per-account budget", async () => {
    vi.stubEnv("TRUSTED_PROXY_HOPS", "1")
    const { email } = fresh()
    await createAccount({ email, password: "correct horse" })
    // A botnet: every attempt arrives from a different, genuinely distinct address.
    const attempt = (i: number, password: string) =>
      authenticate({ email, password, ip: clientIp(new Headers({ "x-forwarded-for": `198.51.100.${i % 250}, 10.1.${Math.floor(i / 250)}.${i % 250}` })) })
    for (let i = 1; i <= ACCOUNT_MAX_ATTEMPTS; i++) expect(await attempt(i, `wrong-${i}`), `attempt ${i}`).toBeNull()
    await expect(attempt(ACCOUNT_MAX_ATTEMPTS + 1, "correct horse")).rejects.toThrow(RateLimitedError)
    for (let i = 1; i <= ACCOUNT_MAX_ATTEMPTS + 1; i++) {
      keys.push(rateLimitKey("login", clientIp(new Headers({ "x-forwarded-for": `198.51.100.${i % 250}, 10.1.${Math.floor(i / 250)}.${i % 250}` })), email))
    }
  })

  it("a refused attempt does not burn the account budget", async () => {
    const { email, ip, key } = fresh()
    for (let i = 0; i < 10; i++) await authenticate({ email, password: "x", ip })
    for (let i = 0; i < 20; i++) await authenticate({ email, password: "x", ip }).catch(() => null)
    expect((await prisma.rateLimitCounter.findUniqueOrThrow({ where: { key: accountKey(email) } })).count).toBe(10)
    expect(await isLimited(key)).toBe(true)
  })

  it("a successful login clears the account budget as well", async () => {
    const { email, ip } = fresh()
    await createAccount({ email, password: "correct horse" })
    for (let i = 0; i < 5; i++) await authenticate({ email, password: "wrong", ip })
    expect(await authenticate({ email, password: "correct horse", ip })).not.toBeNull()
    expect(await prisma.rateLimitCounter.findUnique({ where: { key: accountKey(email) } })).toBeNull()
  })

  it("keys the account counter on the normalised email alone", () => {
    expect(accountKey("A@B.com")).toBe(accountKey(" a@b.COM "))
    expect(accountKey("a@b.com")).not.toBe(rateLimitKey("login", "unknown", "a@b.com"))
  })
})

describe("signup probing is bounded", () => {
  it("refuses a bulk probe of many distinct emails from one address", async () => {
    const { ip } = fresh()
    let allowed = 0
    for (let i = 0; i < SIGNUP_IP_MAX_ATTEMPTS + 5; i++) {
      const email = `${randomUUID()}@probe.test`
      keys.push(rateLimitKey("signup", ip, email))
      if ((await consumeSignupAttempt(ip, email)).allowed) allowed++
    }
    expect(allowed).toBe(SIGNUP_IP_MAX_ATTEMPTS)
  })

  it("still applies the per-email limit within the per-address allowance", async () => {
    const { ip, email } = fresh()
    let allowed = 0
    for (let i = 0; i < 12; i++) if ((await consumeSignupAttempt(ip, email)).allowed) allowed++
    expect(allowed).toBe(RATE_LIMIT.maxAttempts)
    keys.push(rateLimitKey("signup", ip, email))
  })
})

describe("expired counters are reclaimed", () => {
  it("sweepExpired deletes rows past their window and keeps live ones", async () => {
    const dead = fresh()
    const live = fresh()
    await consumeAttempt(dead.key)
    await consumeAttempt(live.key)
    await prisma.$executeRaw`UPDATE "RateLimitCounter" SET "windowStart" = now() - interval '16 minutes' WHERE key = ${dead.key}`
    await sweepExpired()
    expect(await prisma.rateLimitCounter.findUnique({ where: { key: dead.key } })).toBeNull()
    expect(await prisma.rateLimitCounter.findUnique({ where: { key: live.key } })).not.toBeNull()
  })

  it("consumeAttempt sweeps opportunistically, so unauthenticated probing cannot grow the table without bound", async () => {
    const dead = fresh()
    const trigger = fresh()
    await consumeAttempt(dead.key)
    await prisma.$executeRaw`UPDATE "RateLimitCounter" SET "windowStart" = now() - interval '16 minutes' WHERE key = ${dead.key}`
    vi.spyOn(Math, "random").mockReturnValue(0) // the sweep fires
    await consumeAttempt(trigger.key)
    expect(await prisma.rateLimitCounter.findUnique({ where: { key: dead.key } })).toBeNull()
  })

  it("does not sweep on every call", async () => {
    const dead = fresh()
    const trigger = fresh()
    await consumeAttempt(dead.key)
    await prisma.$executeRaw`UPDATE "RateLimitCounter" SET "windowStart" = now() - interval '16 minutes' WHERE key = ${dead.key}`
    vi.spyOn(Math, "random").mockReturnValue(0.999)
    await consumeAttempt(trigger.key)
    expect(await prisma.rateLimitCounter.findUnique({ where: { key: dead.key } })).not.toBeNull()
  })
})
