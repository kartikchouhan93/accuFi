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
  // Recurring tables first: their foreign keys to transactions and nodes are RESTRICT.
  await prisma.recurringOccurrence.deleteMany({ where: { userId: { in: createdUserIds } } })
  await prisma.recurringRule.deleteMany({ where: { userId: { in: createdUserIds } } })
  await prisma.lotConsumption.deleteMany({ where: { userId: { in: createdUserIds } } })
  await prisma.investmentLot.deleteMany({ where: { userId: { in: createdUserIds } } })
  await prisma.priceSnapshot.deleteMany({ where: { userId: { in: createdUserIds } } })
  await prisma.transaction.deleteMany({ where: { userId: { in: createdUserIds } } })
  await prisma.transactionGroup.deleteMany({ where: { userId: { in: createdUserIds } } })
  // Children before parents: a node may reference a parent node.
  await prisma.ledgerNode.deleteMany({ where: { userId: { in: createdUserIds }, parentId: { not: null } } })
  await prisma.ledgerNode.deleteMany({ where: { userId: { in: createdUserIds } } })
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } })
  await prisma.$disconnect()
})

/** A user with an INVESTMENT node, plus a helper that books a transaction into it from a bank node. */
async function makeInvestor() {
  const user = await makeUser()
  const bank = await prisma.ledgerNode.create({ data: { userId: user.id, kind: "ASSET", name: "Bank" } })
  const node = await prisma.ledgerNode.create({
    data: { userId: user.id, kind: "INVESTMENT", name: "Gold", valuationMode: "QUANTITY", unitLabel: "g" },
  })
  const buy = () =>
    prisma.transaction.create({
      data: {
        userId: user.id,
        fromNodeId: bank.id,
        toNodeId: node.id,
        amountPaise: 7_000_000n,
        occurredAt: toDbDate(calendarDate("2026-04-01")),
      },
    })
  const lotData = (transactionId: string, over: Partial<Prisma.InvestmentLotUncheckedCreateInput> = {}) => ({
    userId: user.id,
    nodeId: node.id,
    transactionId,
    quantity: new Prisma.Decimal("10"),
    costBasisPaise: 7_000_000n,
    acquiredAt: toDbDate(calendarDate("2026-04-01")),
    ...over,
  })
  const priceData = (over: Partial<Prisma.PriceSnapshotUncheckedCreateInput> = {}) => ({
    userId: user.id,
    nodeId: node.id,
    asOf: toDbDate(calendarDate("2026-04-01")),
    pricePerUnitPaise: 710_000n,
    ...over,
  })
  return { user, bank, node, buy, lotData, priceData }
}

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

// The CHECK constraints are the last line of defence: a zero or negative quantity, cost or price must never be stored,
// whatever the application layer does.
describe("investment lots, lot consumptions and price snapshots", () => {
  async function expectCheckViolation(promise: Promise<unknown>) {
    const error = await promise.then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(error, "expected the insert to be rejected").toBeDefined()
    expect(String(error)).toMatch(/check constraint/i)
  }

  it("stores a lot and reads back its quantity exactly, with acquiredAt as the same calendar day", async () => {
    const { buy, lotData } = await makeInvestor()
    const tx = await buy()
    const lot = await prisma.investmentLot.create({
      data: lotData(tx.id, { quantity: new Prisma.Decimal("10.123456"), costBasisPaise: 9_007_199_254_740_993n }),
    })
    const read = await prisma.investmentLot.findUniqueOrThrow({ where: { id: lot.id } })
    expect(read.quantity.toFixed(6)).toBe("10.123456")
    expect(read.costBasisPaise).toBe(9_007_199_254_740_993n)
    expect(fromDbDate(read.acquiredAt)).toBe("2026-04-01")
  })

  it("rejects a lot with a zero or negative quantity", async () => {
    const { buy, lotData } = await makeInvestor()
    await expectCheckViolation(prisma.investmentLot.create({ data: lotData((await buy()).id, { quantity: new Prisma.Decimal("0") }) }))
    await expectCheckViolation(prisma.investmentLot.create({ data: lotData((await buy()).id, { quantity: new Prisma.Decimal("-1") }) }))
  })

  it("rejects a lot with a zero or negative cost basis", async () => {
    const { buy, lotData } = await makeInvestor()
    await expectCheckViolation(prisma.investmentLot.create({ data: lotData((await buy()).id, { costBasisPaise: 0n }) }))
    await expectCheckViolation(prisma.investmentLot.create({ data: lotData((await buy()).id, { costBasisPaise: -1n }) }))
  })

  it("rejects a second lot for the same acquiring transaction", async () => {
    const { buy, lotData } = await makeInvestor()
    const tx = await buy()
    await prisma.investmentLot.create({ data: lotData(tx.id) })
    await expectUniqueViolation(prisma.investmentLot.create({ data: lotData(tx.id) }))
  })

  it("rejects a consumption with a zero or negative quantity or a negative cost basis, but accepts a zero basis", async () => {
    const { buy, lotData } = await makeInvestor()
    const lot = await prisma.investmentLot.create({ data: lotData((await buy()).id) })
    const consume = async (over: Partial<Prisma.LotConsumptionUncheckedCreateInput>) =>
      prisma.lotConsumption.create({
        data: {
          userId: lot.userId,
          lotId: lot.id,
          transactionId: (await buy()).id,
          quantity: new Prisma.Decimal("1"),
          costBasisPaise: 700_000n,
          ...over,
        },
      })
    await expectCheckViolation(consume({ quantity: new Prisma.Decimal("0") }))
    await expectCheckViolation(consume({ quantity: new Prisma.Decimal("-1") }))
    await expectCheckViolation(consume({ costBasisPaise: -1n }))
    // The allocator rounds a tiny partial take (1 of 3 units costing 1 paisa) to a 0-paise basis and Task 5 stores it.
    const zero = await consume({ costBasisPaise: 0n })
    expect(zero.costBasisPaise).toBe(0n)
  })

  it("rejects the same (lot, disposal transaction) consumption twice, but allows one disposal to consume two lots", async () => {
    const { buy, lotData, user } = await makeInvestor()
    const lotA = await prisma.investmentLot.create({ data: lotData((await buy()).id) })
    const lotB = await prisma.investmentLot.create({ data: lotData((await buy()).id) })
    const sale = await buy()
    const consume = (lotId: string) =>
      prisma.lotConsumption.create({
        data: { userId: user.id, lotId, transactionId: sale.id, quantity: new Prisma.Decimal("1"), costBasisPaise: 700_000n },
      })
    await consume(lotA.id)
    await expectUniqueViolation(consume(lotA.id))
    await expect(consume(lotB.id)).resolves.toBeDefined()
  })

  it("rejects two price snapshots for the same (node, asOf), and allows other days", async () => {
    const { priceData } = await makeInvestor()
    await prisma.priceSnapshot.create({ data: priceData() })
    await expectUniqueViolation(prisma.priceSnapshot.create({ data: priceData({ pricePerUnitPaise: 720_000n }) }))
    await expect(
      prisma.priceSnapshot.create({ data: priceData({ asOf: toDbDate(calendarDate("2026-04-02")) }) }),
    ).resolves.toBeDefined()
  })

  it("rejects a price snapshot with a zero or negative price", async () => {
    const { priceData } = await makeInvestor()
    await expectCheckViolation(prisma.priceSnapshot.create({ data: priceData({ pricePerUnitPaise: 0n }) }))
    await expectCheckViolation(prisma.priceSnapshot.create({ data: priceData({ pricePerUnitPaise: -5n }) }))
  })

  it("defaults a snapshot's source to MANUAL and its asOf to a calendar day", async () => {
    const { priceData } = await makeInvestor()
    const snap = await prisma.priceSnapshot.create({ data: priceData() })
    expect(snap.source).toBe("MANUAL")
    expect(fromDbDate(snap.asOf)).toBe("2026-04-01")
  })

  it("stamps a snapshot's updatedAt from the database clock on insert and on update (EC-66)", async () => {
    const { priceData } = await makeInvestor()
    const snap = await prisma.priceSnapshot.create({
      data: priceData({ updatedAt: new Date("2000-01-01T00:00:00Z") }),
    })
    const [row] = await prisma.$queryRaw<{ same: boolean }[]>`
      SELECT "updatedAt" = "createdAt" AS same FROM "PriceSnapshot" WHERE "id" = ${snap.id}`
    expect(row.same).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 20))
    const updated = await prisma.priceSnapshot.update({
      where: { id: snap.id },
      data: { pricePerUnitPaise: 720_000n, updatedAt: new Date("2000-01-01T00:00:00Z") },
    })
    expect(updated.updatedAt.getTime()).toBeGreaterThan(snap.updatedAt.getTime())
  })

  it("has no stored remaining-quantity column on lots (remaining is derived, spec §7.2)", async () => {
    const cols = await prisma.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'InvestmentLot'`
    expect(cols.length).toBeGreaterThan(0)
    expect(cols.map((c) => c.column_name.toLowerCase()).filter((n) => n.includes("remaining"))).toEqual([])
  })

  it("defaults createdAt on the three new tables to the database clock (EC-66)", async () => {
    for (const table of ["InvestmentLot", "LotConsumption", "PriceSnapshot"]) {
      const [col] = await prisma.$queryRaw<{ column_default: string | null }[]>`
        SELECT column_default FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ${table} AND column_name = 'createdAt'`
      expect(col?.column_default, `${table}.createdAt`).toMatch(/now\(\)|CURRENT_TIMESTAMP/i)
    }
  })
})

describe("recurring rules and occurrences", () => {
  async function expectCheckViolation(promise: Promise<unknown>) {
    const error = await promise.then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(error, "expected the insert to be rejected").toBeDefined()
    expect(String(error)).toMatch(/check constraint/i)
  }

  async function makeRuleWorld() {
    const { user, from, to } = await makeUserWithNodes()
    const ruleData = (over: Partial<Prisma.RecurringRuleUncheckedCreateInput> = {}) => ({
      userId: user.id,
      name: "Rent",
      fromNodeId: from.id,
      toNodeId: to.id,
      amountPaise: 1_500_000n,
      frequency: "MONTHLY" as const,
      startDate: toDbDate(calendarDate("2026-11-01")),
      nextDueOn: toDbDate(calendarDate("2026-11-01")),
      ...over,
    })
    return { user, from, to, ruleData }
  }

  it("stores a rule with its defaults, and reads its days back as the same calendar days", async () => {
    const { ruleData } = await makeRuleWorld()
    const rule = await prisma.recurringRule.create({ data: ruleData({ dayOfMonth: 31 }) })
    expect(rule.interval).toBe(1)
    expect(rule.autoPost).toBe(false)
    expect(rule.version).toBe(0)
    expect(rule.tags).toEqual([])
    expect(rule.pausedAt).toBeNull()
    expect(fromDbDate(rule.startDate)).toBe("2026-11-01")
  })

  it("rejects a rule with an interval below 1", async () => {
    const { ruleData } = await makeRuleWorld()
    await expectCheckViolation(prisma.recurringRule.create({ data: ruleData({ interval: 0 }) }))
  })

  it("accepts dayOfMonth 1 to 31 or null and rejects 0 and 32", async () => {
    const { ruleData } = await makeRuleWorld()
    await prisma.recurringRule.create({ data: ruleData({ dayOfMonth: 1 }) })
    await prisma.recurringRule.create({ data: ruleData({ dayOfMonth: 31 }) })
    await prisma.recurringRule.create({ data: ruleData({ dayOfMonth: null }) })
    await expectCheckViolation(prisma.recurringRule.create({ data: ruleData({ dayOfMonth: 32 }) }))
    await expectCheckViolation(prisma.recurringRule.create({ data: ruleData({ dayOfMonth: 0 }) }))
  })

  it("accepts dayOfWeek 1 to 7 or null and rejects 0 and 8", async () => {
    const { ruleData } = await makeRuleWorld()
    await prisma.recurringRule.create({ data: ruleData({ frequency: "WEEKLY", dayOfWeek: 1 }) })
    await prisma.recurringRule.create({ data: ruleData({ frequency: "WEEKLY", dayOfWeek: 7 }) })
    await expectCheckViolation(prisma.recurringRule.create({ data: ruleData({ dayOfWeek: 8 }) }))
    await expectCheckViolation(prisma.recurringRule.create({ data: ruleData({ dayOfWeek: 0 }) }))
  })

  it("rejects a rule with a zero or negative amount", async () => {
    const { ruleData } = await makeRuleWorld()
    await expectCheckViolation(prisma.recurringRule.create({ data: ruleData({ amountPaise: 0n }) }))
    await expectCheckViolation(prisma.recurringRule.create({ data: ruleData({ amountPaise: -1n }) }))
  })

  it("accepts an occurrenceLimit of 1 or null and rejects 0", async () => {
    const { ruleData } = await makeRuleWorld()
    await prisma.recurringRule.create({ data: ruleData({ occurrenceLimit: 1 }) })
    await prisma.recurringRule.create({ data: ruleData({ occurrenceLimit: null }) })
    await expectCheckViolation(prisma.recurringRule.create({ data: ruleData({ occurrenceLimit: 0 }) }))
  })

  it("rejects two rules with the same (user, idempotencyKey), and lets any number without a key coexist", async () => {
    const { ruleData } = await makeRuleWorld()
    await prisma.recurringRule.create({ data: ruleData({ idempotencyKey: "k1" }) })
    const error = await prisma.recurringRule.create({ data: ruleData({ idempotencyKey: "k1" }) }).catch((e: unknown) => e)
    expect(isUniqueViolation(error)).toBe(true)
    await prisma.recurringRule.create({ data: ruleData() })
    await prisma.recurringRule.create({ data: ruleData() })
    await prisma.recurringRule.create({ data: ruleData({ idempotencyKey: "k2" }) })
  })

  it("allows the same idempotencyKey for different users", async () => {
    const a = await makeRuleWorld()
    const b = await makeRuleWorld()
    await prisma.recurringRule.create({ data: a.ruleData({ idempotencyKey: "same" }) })
    await prisma.recurringRule.create({ data: b.ruleData({ idempotencyKey: "same" }) })
  })

  it("defaults an occurrence to PENDING and rejects a second one for the same (rule, dueOn)", async () => {
    const { user, ruleData } = await makeRuleWorld()
    const rule = await prisma.recurringRule.create({ data: ruleData() })
    const dueOn = toDbDate(calendarDate("2026-11-01"))
    const occ = await prisma.recurringOccurrence.create({ data: { userId: user.id, ruleId: rule.id, dueOn } })
    expect(occ.status).toBe("PENDING")
    expect(occ.transactionId).toBeNull()
    const error = await prisma.recurringOccurrence
      .create({ data: { userId: user.id, ruleId: rule.id, dueOn } })
      .catch((e: unknown) => e)
    expect(isUniqueViolation(error)).toBe(true)
    await prisma.recurringOccurrence.create({
      data: { userId: user.id, ruleId: rule.id, dueOn: toDbDate(calendarDate("2026-12-01")) },
    })
  })

  it("rejects two occurrences that became the same transaction", async () => {
    const { user, from, to, ruleData } = await makeRuleWorld()
    const rule = await prisma.recurringRule.create({ data: ruleData() })
    const tx = await prisma.transaction.create({
      data: {
        userId: user.id,
        fromNodeId: from.id,
        toNodeId: to.id,
        amountPaise: 1_500_000n,
        occurredAt: toDbDate(calendarDate("2026-11-01")),
      },
    })
    await prisma.recurringOccurrence.create({
      data: { userId: user.id, ruleId: rule.id, dueOn: toDbDate(calendarDate("2026-11-01")), transactionId: tx.id },
    })
    const error = await prisma.recurringOccurrence
      .create({
        data: { userId: user.id, ruleId: rule.id, dueOn: toDbDate(calendarDate("2026-12-01")), transactionId: tx.id },
      })
      .catch((e: unknown) => e)
    expect(isUniqueViolation(error)).toBe(true)
  })

  it("defaults createdAt on both new tables to the database clock (EC-66)", async () => {
    for (const table of ["RecurringRule", "RecurringOccurrence"]) {
      const [col] = await prisma.$queryRaw<{ column_default: string | null }[]>`
        SELECT column_default FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ${table} AND column_name = 'createdAt'`
      expect(col?.column_default, `${table}.createdAt`).toMatch(/now\(\)|CURRENT_TIMESTAMP/i)
    }
  })
})
