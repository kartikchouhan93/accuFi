import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { afterAll, describe, expect, it } from "vitest"
import { prisma } from "@/server/db"

// The migration that gives every EXISTING user an Opening Balance Contra node (new users get theirs from signup).
// `migrate deploy` already ran it against an empty test database, so it is exercised here by re-running its SQL
// against a user created without one: the way an account that predates the role looks. It runs inside a transaction
// that is always rolled back, and it is scoped to this test's two users: run against every user it would race with
// other test files creating and deleting theirs (an insert for a user deleted mid-statement fails the foreign key).

const SQL = readFileSync(
  new URL("../../prisma/migrations/20261020030100_seed_opening_balance_contra/migration.sql", import.meta.url),
  "utf8",
)

class Rollback extends Error {}

const emails: string[] = []
afterAll(async () => {
  await prisma.ledgerNode.deleteMany({ where: { user: { email: { in: emails } } } })
  await prisma.user.deleteMany({ where: { email: { in: emails } } })
  await prisma.$disconnect()
})

async function inRolledBackTransaction<T>(work: (tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]) => Promise<T>) {
  let result: T | undefined
  await prisma
    .$transaction(async (tx) => {
      result = await work(tx)
      throw new Rollback()
    })
    .catch((error) => {
      if (!(error instanceof Rollback)) throw error
    })
  return result as T
}

describe("seed_opening_balance_contra migration", () => {
  it("gives a user that has none an EXPENSE system node, and leaves a user that has one alone", async () => {
    const email = (label: string) => {
      const value = `${label}-${randomUUID()}@migration.test`
      emails.push(value)
      return value
    }
    const old = await prisma.user.create({ data: { email: email("old"), passwordHash: "x" } })
    await prisma.ledgerNode.create({
      data: { userId: old.id, kind: "INCOME_SOURCE", name: "Opening Balance", systemRole: "OPENING_BALANCE" },
    })
    const current = await prisma.user.create({ data: { email: email("current"), passwordHash: "x" } })
    const existing = await prisma.ledgerNode.create({
      data: { userId: current.id, kind: "EXPENSE", name: "Opening Balance Contra", systemRole: "OPENING_BALANCE_CONTRA" },
    })

    // The one change made to the migration's text: restrict the users it reads. Its NOT EXISTS logic is what runs.
    const scoped = SQL.replace('FROM "User" u\nWHERE', `FROM "User" u\nWHERE u."id" IN ('${old.id}', '${current.id}') AND`)
    expect(scoped).not.toBe(SQL)

    const { oldNodes, currentNodes } = await inRolledBackTransaction(async (tx) => {
      await tx.$executeRawUnsafe(scoped)
      await tx.$executeRawUnsafe(scoped) // idempotent: a second run adds nothing
      const contra = (userId: string) =>
        tx.ledgerNode.findMany({ where: { userId, systemRole: "OPENING_BALANCE_CONTRA" } })
      return { oldNodes: await contra(old.id), currentNodes: await contra(current.id) }
    })

    expect(oldNodes).toHaveLength(1)
    expect(oldNodes[0]).toMatchObject({ kind: "EXPENSE", name: "Opening Balance Contra", archivedAt: null, parentId: null })
    expect(currentNodes.map((n) => n.id)).toEqual([existing.id])
    // and it was rolled back: nothing leaked out of the test
    expect(await prisma.ledgerNode.count({ where: { userId: old.id, systemRole: "OPENING_BALANCE_CONTRA" } })).toBe(0)
  })
})
