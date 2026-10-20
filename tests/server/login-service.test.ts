import { randomUUID } from "node:crypto"
import { afterAll, describe, expect, it } from "vitest"
import { prisma } from "@/server/db"
import { rateLimitKey } from "@/server/rate-limit"
import { authenticate } from "@/server/services/login-service"
import { createAccount } from "@/server/services/signup-service"

const emails: string[] = []
const ip = "192.0.2.10"
const freshEmail = () => {
  const email = `${randomUUID()}@login.test`
  emails.push(email)
  return email
}

afterAll(async () => {
  await prisma.rateLimitCounter.deleteMany({
    where: { key: { in: emails.map((e) => rateLimitKey("login", ip, e)) } },
  })
  const users = await prisma.user.findMany({ where: { email: { in: emails } }, select: { id: true } })
  const ids = users.map((u) => u.id)
  await prisma.ledgerNode.deleteMany({ where: { userId: { in: ids } } })
  await prisma.user.deleteMany({ where: { id: { in: ids } } })
  await prisma.$disconnect()
})

describe("authenticate", () => {
  it("returns the user id and email for the right password", async () => {
    const email = freshEmail()
    const { userId } = await createAccount({ email, password: "correct horse" })
    expect(await authenticate({ email, password: "correct horse", ip })).toEqual({ userId, email })
  })

  it("matches the email case-insensitively", async () => {
    const email = freshEmail()
    const { userId } = await createAccount({ email, password: "correct horse" })
    const result = await authenticate({ email: ` ${email.toUpperCase()} `, password: "correct horse", ip })
    expect(result?.userId).toBe(userId)
  })

  it("returns null for a wrong password", async () => {
    const email = freshEmail()
    await createAccount({ email, password: "correct horse" })
    expect(await authenticate({ email, password: "wrong horse", ip })).toBeNull()
  })

  it("returns null, not an error, for an unknown email", async () => {
    expect(await authenticate({ email: freshEmail(), password: "correct horse", ip })).toBeNull()
  })

  it("returns null for malformed input instead of throwing", async () => {
    expect(await authenticate({ email: "", password: "", ip })).toBeNull()
    expect(await authenticate({ email: undefined as unknown as string, password: 42 as unknown as string, ip })).toBeNull()
  })
})
