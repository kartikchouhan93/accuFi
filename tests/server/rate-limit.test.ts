import { randomUUID } from "node:crypto"
import { afterAll, describe, expect, it } from "vitest"
import { prisma } from "@/server/db"
import { clearAttempts, consumeAttempt, isLimited, rateLimitKey, RATE_LIMIT } from "@/server/rate-limit"
import { authenticate, RateLimitedError } from "@/server/services/login-service"
import { createAccount } from "@/server/services/signup-service"

// Writes to the dedicated test database. Every test uses a random email and IP, so counters never collide.
const keys: string[] = []
const emails: string[] = []
const fresh = () => {
  const email = `${randomUUID()}@ratelimit.test`
  const ip = `203.0.113.${Math.floor(Math.random() * 250) + 1}`
  const key = rateLimitKey("login", ip, email)
  keys.push(key)
  emails.push(email)
  return { email, ip, key }
}

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
