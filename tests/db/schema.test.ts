import { randomUUID } from "node:crypto"
import { afterAll, describe, expect, it } from "vitest"
import { Prisma } from "@prisma/client"
import { fromDbDate, toDbDate, calendarDate } from "@/domain/calendar-date"
import { prisma } from "@/server/db"

// These tests write to the dedicated test database (see vitest.config.ts and tests/db/global-setup.ts). Every test makes its
// own user with a random email, so tests, files and the two timezone passes never collide, and afterAll
// removes everything that was created so repeated runs leave no debris.

const createdUserIds: string[] = []

async function makeUser() {
  const user = await prisma.user.create({
    data: { email: `${randomUUID()}@schema.test`, passwordHash: "not-a-real-hash" },
  })
  createdUserIds.push(user.id)
  return user
}

/** A user with one ASSET node (the "from" side) and one EXPENSE node (the "to" side). */
async function makeUserWithNodes() {
  const user = await makeUser()
  const from = await prisma.ledgerNode.create({ data: { userId: user.id, kind: "ASSET", name: "Bank" } })
  const to = await prisma.ledgerNode.create({ data: { userId: user.id, kind: "EXPENSE", name: "Food" } })
  return { user, from, to }
}

afterAll(async () => {
  await prisma.transaction.deleteMany({ where: { userId: { in: createdUserIds } } })
  await prisma.transactionGroup.deleteMany({ where: { userId: { in: createdUserIds } } })
  // Children before parents: a node may reference a parent node.
  await prisma.ledgerNode.deleteMany({ where: { userId: { in: createdUserIds }, parentId: { not: null } } })
  await prisma.ledgerNode.deleteMany({ where: { userId: { in: createdUserIds } } })
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } })
  await prisma.$disconnect()
})

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002"
}

async function expectUniqueViolation(promise: Promise<unknown>) {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  )
  expect(isUniqueViolation(error), `expected a P2002 unique violation, got: ${String(error)}`).toBe(true)
}

describe("transaction amounts and dates", () => {
  it("stores and returns occurredAt as the same calendar day", async () => {
    const { user, from, to } = await makeUserWithNodes()
    const tx = await prisma.transaction.create({
      data: {
        userId: user.id,
        fromNodeId: from.id,
        toNodeId: to.id,
        amountPaise: 100n,
        occurredAt: toDbDate(calendarDate("2026-04-01")),
      },
    })
    const read = await prisma.transaction.findUniqueOrThrow({ where: { id: tx.id } })
    expect(fromDbDate(read.occurredAt)).toBe("2026-04-01")
  })

  it("stores amounts above Number.MAX_SAFE_INTEGER without loss", async () => {
    const { user, from, to } = await makeUserWithNodes()
    const amount = 9_007_199_254_740_993n // Number.MAX_SAFE_INTEGER + 2: not representable as a double
    expect(BigInt(Number(amount))).not.toBe(amount) // the premise: a float round-trip would corrupt this value
    const tx = await prisma.transaction.create({
      data: {
        userId: user.id,
        fromNodeId: from.id,
        toNodeId: to.id,
        amountPaise: amount,
        occurredAt: toDbDate(calendarDate("2026-04-01")),
      },
    })
    const read = await prisma.transaction.findUniqueOrThrow({ where: { id: tx.id } })
    expect(read.amountPaise).toBe(amount)
    expect(typeof read.amountPaise).toBe("bigint")
  })

  it("stores creditLimitPaise above Number.MAX_SAFE_INTEGER without loss", async () => {
    const user = await makeUser()
    const node = await prisma.ledgerNode.create({
      data: { userId: user.id, kind: "LIABILITY", name: "Card", creditLimitPaise: 9_007_199_254_740_993n },
    })
    const read = await prisma.ledgerNode.findUniqueOrThrow({ where: { id: node.id } })
    expect(read.creditLimitPaise).toBe(9_007_199_254_740_993n)
  })
})

describe("uniqueness", () => {
  const txData = (userId: string, fromNodeId: string, toNodeId: string, idempotencyKey: string | null) => ({
    userId,
    fromNodeId,
    toNodeId,
    amountPaise: 100n,
    occurredAt: toDbDate(calendarDate("2026-04-01")),
    idempotencyKey,
  })

  it("rejects two transactions with the same userId and idempotencyKey", async () => {
    const { user, from, to } = await makeUserWithNodes()
    await prisma.transaction.create({ data: txData(user.id, from.id, to.id, "key-1") })
    await expectUniqueViolation(prisma.transaction.create({ data: txData(user.id, from.id, to.id, "key-1") }))
  })

  it("allows the same idempotencyKey for different users", async () => {
    const a = await makeUserWithNodes()
    const b = await makeUserWithNodes()
    await prisma.transaction.create({ data: txData(a.user.id, a.from.id, a.to.id, "shared-key") })
    await expect(
      prisma.transaction.create({ data: txData(b.user.id, b.from.id, b.to.id, "shared-key") }),
    ).resolves.toBeDefined()
  })

  it("permits many transactions with a null idempotencyKey", async () => {
    const { user, from, to } = await makeUserWithNodes()
    await prisma.transaction.createMany({
      data: [
        txData(user.id, from.id, to.id, null),
        txData(user.id, from.id, to.id, null),
        txData(user.id, from.id, to.id, null),
      ],
    })
    expect(await prisma.transaction.count({ where: { userId: user.id, idempotencyKey: null } })).toBe(3)
  })

  it("rejects a second system node with the same role for one user", async () => {
    const user = await makeUser()
    const node = { userId: user.id, kind: "ASSET", name: "Opening Balance", systemRole: "OPENING_BALANCE" } as const
    await prisma.ledgerNode.create({ data: node })
    await expectUniqueViolation(prisma.ledgerNode.create({ data: node }))
  })

  it("allows the same system role for different users, and different roles for one user", async () => {
    const a = await makeUser()
    const b = await makeUser()
    const opening = (userId: string) =>
      prisma.ledgerNode.create({ data: { userId, kind: "ASSET", name: "Opening Balance", systemRole: "OPENING_BALANCE" } })
    await expect(opening(a.id)).resolves.toBeDefined()
    await expect(opening(b.id)).resolves.toBeDefined()
    await expect(
      prisma.ledgerNode.create({
        data: { userId: a.id, kind: "INCOME_SOURCE", name: "Realised Gain", systemRole: "REALISED_GAIN" },
      }),
    ).resolves.toBeDefined()
  })

  it("permits many ordinary nodes (null systemRole) for one user", async () => {
    const user = await makeUser()
    await prisma.ledgerNode.createMany({
      data: [
        { userId: user.id, kind: "ASSET", name: "HDFC" },
        { userId: user.id, kind: "ASSET", name: "SBI" },
        { userId: user.id, kind: "EXPENSE", name: "Food" },
      ],
    })
    expect(await prisma.ledgerNode.count({ where: { userId: user.id } })).toBe(3)
  })
})

describe("column types and defaults", () => {
  type Column = { table_name: string; column_name: string; data_type: string; column_default: string | null }

  async function columns(table: string): Promise<Column[]> {
    return prisma.$queryRaw<Column[]>`
      SELECT table_name, column_name, data_type, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ${table}`
  }

  it("makes occurredAt a DATE and the audit columns timestamptz", async () => {
    const tx = await columns("Transaction")
    const type = (name: string) => tx.find((c) => c.column_name === name)?.data_type
    expect(type("occurredAt")).toBe("date")
    expect(type("createdAt")).toBe("timestamp with time zone")
    expect(type("updatedAt")).toBe("timestamp with time zone")
    expect(type("deletedAt")).toBe("timestamp with time zone")
    expect(type("amountPaise")).toBe("bigint")
  })

  it("defaults every createdAt to the database clock on insert (EC-66)", async () => {
    // Prisma never sends createdAt (it is dbgenerated), so the column default is what stamps it.
    for (const table of ["User", "LedgerNode", "TransactionGroup", "Transaction"]) {
      const col = (await columns(table)).find((c) => c.column_name === "createdAt")
      expect(col?.column_default, `${table}.createdAt`).toMatch(/now\(\)|CURRENT_TIMESTAMP/i)
    }
  })

  // updatedAt is different: Prisma's @updatedAt supplies a value on create, so the column default never fires and
  // only a trigger can put the database clock on it. These tests insert real rows; the column_default is not evidence.
  describe("updatedAt on INSERT comes from the database clock (EC-66)", () => {
    it("overwrites the updatedAt that Prisma supplies on create", async () => {
      const { user, from, to } = await makeUserWithNodes()
      const tx = await prisma.transaction.create({
        data: {
          userId: user.id,
          fromNodeId: from.id,
          toNodeId: to.id,
          amountPaise: 100n,
          occurredAt: toDbDate(calendarDate("2026-04-01")),
          // Without this Prisma would send its own clock reading, which can land in the same millisecond as the
          // database's and hide the bug; a value that is plainly not now() cannot.
          updatedAt: new Date("2000-01-01T00:00:00Z"),
        },
      })
      // createdAt is stamped by the column default (database now()); in the same INSERT statement updatedAt must be
      // exactly that value, not what the application sent.
      const [row] = await prisma.$queryRaw<{ same: boolean }[]>`
        SELECT "updatedAt" = "createdAt" AS same FROM "Transaction" WHERE "id" = ${tx.id}`
      expect(row.same).toBe(true)
    })

    it("overwrites an updatedAt written by a raw INSERT, comparing against now() from the same statement", async () => {
      const { user, from, to } = await makeUserWithNodes()
      const id = randomUUID()
      // The column keeps milliseconds and now() has microseconds, so the comparison casts now() to the column's precision.
      const [row] = await prisma.$queryRaw<{ same: boolean }[]>`
        INSERT INTO "Transaction" ("id", "userId", "fromNodeId", "toNodeId", "amountPaise", "occurredAt", "updatedAt")
        VALUES (${id}, ${user.id}, ${from.id}, ${to.id}, 100, '2026-04-01', '2000-01-01T00:00:00Z')
        RETURNING ("updatedAt" = now()::timestamptz(3)) AS same`
      expect(row.same).toBe(true)
    })
  })

  describe("updatedAt on UPDATE comes from the database clock (EC-66)", () => {
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

    async function makeTransaction() {
      const { user, from, to } = await makeUserWithNodes()
      return prisma.transaction.create({
        data: {
          userId: user.id,
          fromNodeId: from.id,
          toNodeId: to.id,
          amountPaise: 100n,
          occurredAt: toDbDate(calendarDate("2026-04-01")),
        },
      })
    }

    it("ignores an updatedAt supplied by the application", async () => {
      const tx = await makeTransaction()
      await sleep(20)
      const updated = await prisma.transaction.update({
        where: { id: tx.id },
        data: { note: "edited", updatedAt: new Date("2000-01-01T00:00:00Z") },
      })
      expect(updated.updatedAt.getTime()).toBeGreaterThan(tx.updatedAt.getTime())
    })

    it("advances updatedAt for a raw-SQL update that does not mention it", async () => {
      const tx = await makeTransaction()
      await sleep(20)
      await prisma.$executeRaw`UPDATE "Transaction" SET "note" = 'raw' WHERE "id" = ${tx.id}`
      const read = await prisma.transaction.findUniqueOrThrow({ where: { id: tx.id } })
      expect(read.updatedAt.getTime()).toBeGreaterThan(tx.updatedAt.getTime())
      expect(read.createdAt.getTime()).toBe(tx.createdAt.getTime())
    })
  })

  it("indexes Transaction on (userId, occurredAt, id), the listing order, so keyset paging needs no sort", async () => {
    const indexes = await prisma.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'Transaction'`
    expect(indexes.map((i) => i.indexdef.replace(/^.*USING btree /, ""))).toContain('("userId", "occurredAt", id)')
  })

  it("has no stored balance or opening-balance column anywhere", async () => {
    for (const table of ["User", "LedgerNode", "TransactionGroup", "Transaction"]) {
      const names = (await columns(table)).map((c) => c.column_name.toLowerCase())
      expect(names.filter((n) => n.includes("balance")), table).toEqual([])
    }
  })
})
