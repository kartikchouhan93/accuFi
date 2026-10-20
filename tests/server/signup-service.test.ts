import { randomUUID } from "node:crypto"
import { afterAll, afterEach, describe, expect, it, vi } from "vitest"
import { prisma } from "@/server/db"
import { createAccount, EmailTakenError } from "@/server/services/signup-service"
import * as accountSeed from "@/server/services/account-seed"
import { InvalidTimezoneError } from "@/domain/timezone"
import { verifyPassword } from "@/server/password"

// Writes to the dedicated test database. Every test uses its own random email; afterAll removes what was created.
const emails: string[] = []
const freshEmail = () => {
  const email = `${randomUUID()}@signup.test`
  emails.push(email)
  return email
}

afterEach(() => {
  vi.restoreAllMocks()
})

afterAll(async () => {
  const users = await prisma.user.findMany({ where: { email: { in: emails } }, select: { id: true } })
  const ids = users.map((u) => u.id)
  await prisma.ledgerNode.deleteMany({ where: { userId: { in: ids } } })
  await prisma.user.deleteMany({ where: { id: { in: ids } } })
  await prisma.$disconnect()
})

describe("createAccount", () => {
  it("creates the four system nodes on signup", async () => {
    const { userId } = await createAccount({ email: freshEmail(), password: "correct horse" })
    const roles = (await prisma.ledgerNode.findMany({ where: { userId } })).map((n) => n.systemRole)
    expect(roles.filter(Boolean).sort()).toEqual(["OPENING_BALANCE", "OPENING_BALANCE_CONTRA", "REALISED_GAIN", "REALISED_LOSS"])
  })

  it("gives the system nodes the right kinds", async () => {
    const { userId } = await createAccount({ email: freshEmail(), password: "correct horse" })
    const nodes = await prisma.ledgerNode.findMany({ where: { userId, systemRole: { not: null } } })
    const kindOf = Object.fromEntries(nodes.map((n) => [n.systemRole, n.kind]))
    expect(kindOf).toEqual({
      OPENING_BALANCE: "INCOME_SOURCE",
      OPENING_BALANCE_CONTRA: "EXPENSE",
      REALISED_GAIN: "INCOME_SOURCE",
      REALISED_LOSS: "EXPENSE",
    })
  })

  it("seeds the starter expense ledgers, which are ordinary deletable nodes", async () => {
    const { userId } = await createAccount({ email: freshEmail(), password: "correct horse" })
    const starters = await prisma.ledgerNode.findMany({ where: { userId, systemRole: null } })
    expect(starters.map((n) => n.name).sort()).toEqual(
      ["Dining", "Groceries", "Health", "Rent", "Transport", "Utilities"],
    )
    expect(starters.every((n) => n.kind === "EXPENSE" && n.systemRole === null && n.archivedAt === null)).toBe(true)
  })

  it("seeds only the new user's own nodes, never another user's", async () => {
    const first = await createAccount({ email: freshEmail(), password: "correct horse" })
    const second = await createAccount({ email: freshEmail(), password: "correct horse" })
    const firstNodes = await prisma.ledgerNode.findMany({ where: { userId: first.userId } })
    const secondNodes = await prisma.ledgerNode.findMany({ where: { userId: second.userId } })
    expect(firstNodes).toHaveLength(10)
    expect(secondNodes).toHaveLength(10)
    const firstIds = new Set(firstNodes.map((n) => n.id))
    expect(secondNodes.some((n) => firstIds.has(n.id))).toBe(false)
  })

  it("rejects a duplicate email", async () => {
    const email = freshEmail()
    await createAccount({ email, password: "correct horse" })
    await expect(createAccount({ email, password: "another password" })).rejects.toThrow(EmailTakenError)
  })

  it("treats emails case-insensitively and ignores surrounding whitespace", async () => {
    const email = freshEmail()
    const { userId } = await createAccount({ email: `  ${email.toUpperCase()}  `, password: "correct horse" })
    const stored = await prisma.user.findUniqueOrThrow({ where: { id: userId } })
    expect(stored.email).toBe(email.toLowerCase())
    await expect(createAccount({ email, password: "correct horse" })).rejects.toThrow(EmailTakenError)
  })

  it("leaves no extra nodes behind when the email is taken", async () => {
    const email = freshEmail()
    const { userId } = await createAccount({ email, password: "correct horse" })
    await expect(createAccount({ email, password: "correct horse" })).rejects.toThrow(EmailTakenError)
    expect(await prisma.ledgerNode.count({ where: { userId } })).toBe(10)
    expect(await prisma.user.count({ where: { email: email.toLowerCase() } })).toBe(1)
  })

  it("never stores the plaintext password", async () => {
    const password = "correct horse battery staple"
    const { userId } = await createAccount({ email: freshEmail(), password })
    const stored = await prisma.user.findUniqueOrThrow({ where: { id: userId } })
    expect(stored.passwordHash).not.toContain(password)
    expect(stored.passwordHash.startsWith("$argon2id$")).toBe(true)
    expect(await verifyPassword(password, stored.passwordHash)).toBe(true)
    // and no other column of the row carries it either
    expect(JSON.stringify(stored)).not.toContain(password)
  })

  it("creates the account and its system nodes atomically", async () => {
    const email = freshEmail()
    // Seed one node for real, then fail: the user row and that node must both roll back.
    vi.spyOn(accountSeed, "seedAccountNodes").mockImplementationOnce(async (tx, userId) => {
      await tx.ledgerNode.create({
        data: { userId, kind: "INCOME_SOURCE", name: "Opening Balance", systemRole: "OPENING_BALANCE" },
      })
      throw new Error("seeding failed part-way")
    })
    await expect(createAccount({ email, password: "correct horse" })).rejects.toThrow("seeding failed part-way")
    expect(await prisma.user.count({ where: { email } })).toBe(0)
    expect(await prisma.ledgerNode.count({ where: { user: { email } } })).toBe(0)
  })

  it("defaults the timezone to a valid IANA zone", async () => {
    const { userId } = await createAccount({ email: freshEmail(), password: "correct horse" })
    const stored = await prisma.user.findUniqueOrThrow({ where: { id: userId } })
    expect(stored.timezone).toBe("Asia/Kolkata")
  })

  it("stores a supplied valid timezone", async () => {
    const { userId } = await createAccount({
      email: freshEmail(),
      password: "correct horse",
      timezone: "America/New_York",
    })
    const stored = await prisma.user.findUniqueOrThrow({ where: { id: userId } })
    expect(stored.timezone).toBe("America/New_York")
  })

  it("rejects a bogus timezone and leaves no user behind", async () => {
    const email = freshEmail()
    await expect(
      createAccount({ email, password: "correct horse", timezone: "Mars/Olympus_Mons" }),
    ).rejects.toThrow(InvalidTimezoneError)
    expect(await prisma.user.count({ where: { email } })).toBe(0)
  })

  it("rejects a malformed email or an unusable password before touching the database", async () => {
    await expect(createAccount({ email: "not-an-email", password: "correct horse" })).rejects.toThrow()
    await expect(createAccount({ email: freshEmail(), password: "short" })).rejects.toThrow()
    await expect(createAccount({ email: freshEmail(), password: "x".repeat(2000) })).rejects.toThrow()
  })
})
