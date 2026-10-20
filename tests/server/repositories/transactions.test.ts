import { afterAll, describe, expect, it } from "vitest"
import { Prisma } from "@prisma/client"
import { calendarDate, fromDbDate } from "@/domain/calendar-date"
import { prisma } from "@/server/db"
import { DuplicateIdempotencyKeyError, InvalidCursorError, NotFoundError } from "@/server/repositories/errors"
import {
  findTransactionById,
  findTransactions,
  insertTransactions,
  MAX_PAGE_SIZE,
  softDeleteTransaction,
  sumBalances,
  undeleteTransaction,
  updateTransaction,
  VersionConflictError,
} from "@/server/repositories/transaction-repository"
import { inTransaction } from "@/server/repositories/unit-of-work"
import { createRegistry } from "./fixtures"

const registry = createRegistry()
afterAll(registry.cleanup)

async function setup() {
  const user = await registry.makeUser()
  const salary = await registry.makeNode(user.id, "INCOME_SOURCE", "Salary")
  const bank = await registry.makeNode(user.id, "ASSET", "Bank")
  const food = await registry.makeNode(user.id, "EXPENSE", "Food")
  const rent = await registry.makeNode(user.id, "EXPENSE", "Rent")
  return { user, salary, bank, food, rent }
}

const d = calendarDate

describe("insertTransactions", () => {
  it("inserts every draft, in order, with the stored day and amount", async () => {
    const { user, salary, bank, food } = await setup()
    const rows = await insertTransactions(user.id, [
      { fromNodeId: salary.id, toNodeId: bank.id, amountPaise: 9_007_199_254_740_993n, occurredAt: d("2026-04-30"), note: "pay", tags: ["a", "b"] },
      { fromNodeId: bank.id, toNodeId: food.id, amountPaise: 250n, occurredAt: d("2026-05-01") },
    ])
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ userId: user.id, amountPaise: 9_007_199_254_740_993n, note: "pay", tags: ["a", "b"], version: 0, deletedAt: null })
    expect(fromDbDate(rows[0].occurredAt)).toBe("2026-04-30")
    expect(rows[1]).toMatchObject({ note: null, tags: [], groupId: null })
  })

  it("returns an empty list for no drafts", async () => {
    const { user } = await setup()
    expect(await insertTransactions(user.id, [])).toEqual([])
  })

  it("puts every row of a call in the given group", async () => {
    const { user, salary, bank, food } = await setup()
    const group = await prisma.transactionGroup.create({ data: { userId: user.id, kind: "MANUAL_SPLIT" } })
    const rows = await insertTransactions(
      user.id,
      [
        { fromNodeId: salary.id, toNodeId: bank.id, amountPaise: 10n, occurredAt: d("2026-04-01") },
        { fromNodeId: bank.id, toNodeId: food.id, amountPaise: 5n, occurredAt: d("2026-04-01") },
      ],
      group.id,
    )
    expect(rows.every((r) => r.groupId === group.id)).toBe(true)
  })

  describe("idempotency keys", () => {
    async function withKey() {
      const ctx = await setup()
      const key = `key-${ctx.user.id}`
      const draft = { fromNodeId: ctx.salary.id, toNodeId: ctx.bank.id, amountPaise: 1n, occurredAt: d("2026-04-01") }
      const [first] = await insertTransactions(ctx.user.id, [{ ...draft, idempotencyKey: key, note: "original" }])
      return { ...ctx, key, draft, first }
    }

    it("throws DuplicateIdempotencyKeyError, carrying the existing row, on a repeated key", async () => {
      const { user, key, draft, first } = await withKey()
      const error = await insertTransactions(user.id, [{ ...draft, idempotencyKey: key, note: "retry" }]).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(DuplicateIdempotencyKeyError)
      expect((error as DuplicateIdempotencyKeyError).existing).toEqual(first)
      expect(await prisma.transaction.count({ where: { userId: user.id } })).toBe(1)
    })

    it("rolls the whole batch back when a later draft repeats a key", async () => {
      const { user, key, draft, first } = await withKey()
      const error = await insertTransactions(user.id, [
        { ...draft, note: "first" },
        { ...draft, idempotencyKey: key },
      ]).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(DuplicateIdempotencyKeyError)
      expect((error as DuplicateIdempotencyKeyError).existing.id).toBe(first.id)
      expect(await prisma.transaction.count({ where: { userId: user.id, note: "first" } })).toBe(0)
    })

    it("treats the same key under two users as unrelated, and never reveals the other user's row", async () => {
      const a = await withKey()
      const b = await setup()
      const [mine] = await insertTransactions(b.user.id, [
        { fromNodeId: b.salary.id, toNodeId: b.bank.id, amountPaise: 2n, occurredAt: d("2026-04-01"), idempotencyKey: a.key },
      ])
      expect(mine.userId).toBe(b.user.id)
      // and a repeat by b reports b's own row, not a's
      const error = await insertTransactions(b.user.id, [
        { fromNodeId: b.salary.id, toNodeId: b.bank.id, amountPaise: 3n, occurredAt: d("2026-04-01"), idempotencyKey: a.key },
      ]).catch((e: unknown) => e)
      expect((error as DuplicateIdempotencyKeyError).existing.id).toBe(mine.id)
    })

    it("rejects a key repeated within one batch as a plain error, not a Prisma one", async () => {
      const { user, draft } = await withKey()
      const error = await insertTransactions(user.id, [
        { ...draft, idempotencyKey: "same-in-batch" },
        { ...draft, idempotencyKey: "same-in-batch" },
      ]).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(Error)
      expect(error).not.toBeInstanceOf(Prisma.PrismaClientKnownRequestError)
      expect((error as Error).message).toMatch(/idempotency key/i)
      expect(await prisma.transaction.count({ where: { userId: user.id, idempotencyKey: "same-in-batch" } })).toBe(0)
    })
  })
})

describe("updateTransaction", () => {
  async function one() {
    const ctx = await setup()
    const [tx] = await insertTransactions(ctx.user.id, [
      { fromNodeId: ctx.bank.id, toNodeId: ctx.food.id, amountPaise: 100n, occurredAt: d("2026-04-01"), note: "lunch", tags: ["x"] },
    ])
    return { ...ctx, tx }
  }

  it("applies the change and increments the version", async () => {
    const { user, tx, rent } = await one()
    const updated = await updateTransaction(user.id, tx.id, { amountPaise: 150n, toNodeId: rent.id, occurredAt: d("2026-04-02"), note: null, tags: ["y"] }, 0)
    expect(updated).toMatchObject({ id: tx.id, amountPaise: 150n, toNodeId: rent.id, note: null, tags: ["y"], version: 1 })
    expect(fromDbDate(updated.occurredAt)).toBe("2026-04-02")
    expect(updated.fromNodeId).toBe(tx.fromNodeId) // untouched fields stay
  })

  it("leaves fields that are not given alone", async () => {
    const { user, tx } = await one()
    const updated = await updateTransaction(user.id, tx.id, { amountPaise: 1n }, 0)
    expect(updated).toMatchObject({ note: "lunch", tags: ["x"], amountPaise: 1n })
  })

  it("throws VersionConflictError carrying the current row when the version is stale", async () => {
    const { user, tx } = await one()
    await updateTransaction(user.id, tx.id, { note: "first writer" }, 0)
    const error = await updateTransaction(user.id, tx.id, { note: "second writer" }, 0).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(VersionConflictError)
    const current = (error as VersionConflictError).current
    expect(current).toMatchObject({ id: tx.id, note: "first writer", version: 1 })
    // and the losing write changed nothing
    expect(await findTransactionById(user.id, tx.id)).toMatchObject({ note: "first writer", version: 1 })
  })

  it("lets exactly one of two concurrent writers win", async () => {
    const { user, tx } = await one()
    const results = await Promise.allSettled([
      updateTransaction(user.id, tx.id, { note: "A" }, 0),
      updateTransaction(user.id, tx.id, { note: "B" }, 0),
    ])
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
    const loser = results.find((r) => r.status === "rejected")
    expect(loser?.status === "rejected" && loser.reason).toBeInstanceOf(VersionConflictError)
    expect((await findTransactionById(user.id, tx.id))?.version).toBe(1)
  })

  it("throws not-found for an unknown id and for a soft-deleted transaction", async () => {
    const { user, tx } = await one()
    await expect(updateTransaction(user.id, "nope", { note: "x" }, 0)).rejects.toBeInstanceOf(NotFoundError)
    await softDeleteTransaction(user.id, tx.id)
    await expect(updateTransaction(user.id, tx.id, { note: "x" }, tx.version)).rejects.toBeInstanceOf(NotFoundError)
  })
})

describe("softDeleteTransaction", () => {
  it("hides the row from lookups and listings but keeps it in the table", async () => {
    const { user, bank, food } = await setup()
    const [tx] = await insertTransactions(user.id, [{ fromNodeId: bank.id, toNodeId: food.id, amountPaise: 5n, occurredAt: d("2026-04-01") }])
    await softDeleteTransaction(user.id, tx.id)
    expect(await findTransactionById(user.id, tx.id)).toBeNull()
    expect((await findTransactions(user.id, {})).items).toEqual([])
    expect((await prisma.transaction.findUniqueOrThrow({ where: { id: tx.id } })).deletedAt).not.toBeNull()
  })

  it("throws not-found for an unknown id or one already deleted", async () => {
    const { user, bank, food } = await setup()
    const [tx] = await insertTransactions(user.id, [{ fromNodeId: bank.id, toNodeId: food.id, amountPaise: 5n, occurredAt: d("2026-04-01") }])
    await softDeleteTransaction(user.id, tx.id)
    await expect(softDeleteTransaction(user.id, tx.id)).rejects.toBeInstanceOf(NotFoundError)
    await expect(softDeleteTransaction(user.id, "nope")).rejects.toBeInstanceOf(NotFoundError)
  })
})

describe("undeleteTransaction", () => {
  it("brings a soft-deleted row back, bumps the version and returns it", async () => {
    const { user, bank, food } = await setup()
    const [tx] = await insertTransactions(user.id, [{ fromNodeId: bank.id, toNodeId: food.id, amountPaise: 5n, occurredAt: d("2026-04-01") }])
    await softDeleteTransaction(user.id, tx.id)
    const deletedVersion = (await prisma.transaction.findUniqueOrThrow({ where: { id: tx.id } })).version
    const restored = await undeleteTransaction(user.id, tx.id)
    expect(restored.deletedAt).toBeNull()
    expect(restored.version).toBe(deletedVersion + 1)
    expect((await findTransactionById(user.id, tx.id))?.id).toBe(tx.id)
  })

  it("throws not-found for an unknown id and for a row that is not deleted", async () => {
    const { user, bank, food } = await setup()
    const [tx] = await insertTransactions(user.id, [{ fromNodeId: bank.id, toNodeId: food.id, amountPaise: 5n, occurredAt: d("2026-04-01") }])
    await expect(undeleteTransaction(user.id, tx.id)).rejects.toBeInstanceOf(NotFoundError)
    await expect(undeleteTransaction(user.id, "nope")).rejects.toBeInstanceOf(NotFoundError)
  })

  it("commits or rolls back with the unit of work it is given", async () => {
    const { user, bank, food } = await setup()
    const [tx] = await insertTransactions(user.id, [{ fromNodeId: bank.id, toNodeId: food.id, amountPaise: 5n, occurredAt: d("2026-04-01") }])
    await softDeleteTransaction(user.id, tx.id)
    await expect(
      inTransaction(async (uow) => {
        await undeleteTransaction(user.id, tx.id, uow)
        throw new Error("abort")
      }),
    ).rejects.toThrow("abort")
    expect(await findTransactionById(user.id, tx.id)).toBeNull()
  })
})

describe("with a unit of work", () => {
  it("updateTransaction and sumBalances see the caller's uncommitted writes and roll back with it", async () => {
    const { user, bank, food } = await setup()
    const [tx] = await insertTransactions(user.id, [{ fromNodeId: bank.id, toNodeId: food.id, amountPaise: 5n, occurredAt: d("2026-04-01") }])
    const balanceOf = (rows: Awaited<ReturnType<typeof sumBalances>>, id: string) => rows.find((r) => r.nodeId === id)?.balance
    await expect(
      inTransaction(async (uow) => {
        await updateTransaction(user.id, tx.id, { amountPaise: 9n }, tx.version, uow)
        expect(balanceOf(await sumBalances(user.id, undefined, uow), food.id)).toBe(9n)
        expect(balanceOf(await sumBalances(user.id), food.id)).toBe(5n) // not visible outside until commit
        throw new Error("abort")
      }),
    ).rejects.toThrow("abort")
    expect((await prisma.transaction.findUniqueOrThrow({ where: { id: tx.id } })).amountPaise).toBe(5n)
  })
})

describe("findTransactions", () => {
  async function seeded() {
    const ctx = await setup()
    const { user, salary, bank, food, rent } = ctx
    const make = (from: string, to: string, amountPaise: bigint, occurredAt: string, note?: string, tags?: string[]) =>
      registry.makeTransaction(user.id, from, to, { amountPaise, occurredAt, note, tags })
    const t1 = await make(salary.id, bank.id, 100_000n, "2026-04-01", "April salary", ["income"])
    const t2 = await make(bank.id, food.id, 500n, "2026-04-10", "Lunch with Asha", ["food", "social"])
    const t3 = await make(bank.id, rent.id, 30_000n, "2026-04-15", "April rent", ["home"])
    const t4 = await make(bank.id, food.id, 700n, "2026-05-02", "Dinner", ["food"])
    return { ...ctx, t1, t2, t3, t4 }
  }
  const ids = async (userId: string, filter: Parameters<typeof findTransactions>[1]) =>
    (await findTransactions(userId, filter)).items.map((t) => t.id)

  it("lists newest first", async () => {
    const { user, t1, t2, t3, t4 } = await seeded()
    expect(await ids(user.id, {})).toEqual([t4.id, t3.id, t2.id, t1.id])
  })

  it("filters by node on either side", async () => {
    const { user, bank, food, rent, t1, t2, t3, t4 } = await seeded()
    expect(await ids(user.id, { nodeIds: [food.id] })).toEqual([t4.id, t2.id])
    expect(await ids(user.id, { nodeIds: [food.id, rent.id] })).toEqual([t4.id, t3.id, t2.id])
    expect((await ids(user.id, { nodeIds: [bank.id] })).sort()).toEqual([t1.id, t2.id, t3.id, t4.id].sort())
    expect(await ids(user.id, { nodeIds: [] })).toEqual([])
  })

  it("filters by inclusive date range", async () => {
    const { user, t2, t3 } = await seeded()
    expect(await ids(user.id, { from: d("2026-04-10"), to: d("2026-04-15") })).toEqual([t3.id, t2.id])
    expect(await ids(user.id, { from: d("2026-05-03") })).toEqual([])
  })

  it("filters by inclusive amount range", async () => {
    const { user, t2, t4 } = await seeded()
    expect(await ids(user.id, { minAmount: 500n, maxAmount: 700n })).toEqual([t4.id, t2.id])
    expect(await ids(user.id, { minAmount: 701n, maxAmount: 29_999n })).toEqual([])
  })

  it("filters by tags, requiring every tag given", async () => {
    const { user, t2, t4 } = await seeded()
    expect(await ids(user.id, { tags: ["food"] })).toEqual([t4.id, t2.id])
    expect(await ids(user.id, { tags: ["food", "social"] })).toEqual([t2.id])
    expect(await ids(user.id, { tags: ["food", "home"] })).toEqual([])
  })

  it("searches the note case-insensitively", async () => {
    const { user, t1, t3 } = await seeded()
    expect(await ids(user.id, { search: "APRIL" })).toEqual([t3.id, t1.id])
  })

  it("combines filters with AND", async () => {
    const { user, food, t2 } = await seeded()
    expect(await ids(user.id, { nodeIds: [food.id], tags: ["social"], from: d("2026-04-01"), to: d("2026-04-30"), search: "lunch" })).toEqual([t2.id])
  })

  it("rejects a cursor it did not issue", async () => {
    const { user } = await seeded()
    for (const bad of ["", "not-base64-json", Buffer.from("[1,2]").toString("base64url"), Buffer.from('["2026-13-45","x"]').toString("base64url")]) {
      await expect(findTransactions(user.id, {}, bad)).rejects.toBeInstanceOf(InvalidCursorError)
    }
  })

  it("clamps the page size to 1..MAX_PAGE_SIZE", async () => {
    const { user, bank, food } = await setup()
    // One more row than the cap, so a missing upper clamp would return all of them.
    await prisma.transaction.createMany({
      data: Array.from({ length: MAX_PAGE_SIZE + 1 }, () => ({
        userId: user.id,
        fromNodeId: bank.id,
        toNodeId: food.id,
        amountPaise: 1n,
        occurredAt: new Date(Date.UTC(2026, 3, 1)),
      })),
    })
    const huge = await findTransactions(user.id, {}, undefined, 1_000_000)
    expect(huge.items).toHaveLength(MAX_PAGE_SIZE)
    expect(huge.nextCursor).not.toBeNull()
    expect((await findTransactions(user.id, {}, undefined, 0)).items).toHaveLength(1)
    expect((await findTransactions(user.id, {}, undefined, -5)).items).toHaveLength(1)
    expect((await findTransactions(user.id, {}, undefined, Number.NaN)).items).toHaveLength(50)
  })

  describe("pagination", () => {
    // 23 rows over only 3 days, so most pages end in the middle of a day: the order has to rest on the id tie-break.
    async function crowded() {
      const { user, bank, food } = await setup()
      const days = ["2026-04-01", "2026-04-02", "2026-04-03"]
      const rows = []
      for (let i = 0; i < 23; i++) {
        rows.push(await registry.makeTransaction(user.id, bank.id, food.id, { occurredAt: days[i % 3], amountPaise: BigInt(i + 1) }))
      }
      return { user, rows }
    }

    async function walk(userId: string, limit: number, from?: string) {
      const seen: string[] = []
      let cursor = from
      let pages = 0
      do {
        const page = await findTransactions(userId, {}, cursor, limit)
        seen.push(...page.items.map((t) => t.id))
        cursor = page.nextCursor ?? undefined
        pages++
        expect(pages).toBeLessThan(100) // a cursor that never ends would otherwise hang the test
      } while (cursor !== undefined)
      return { seen, pages }
    }

    it("returns every row exactly once, with none duplicated or skipped, however the page size cuts the days", async () => {
      const { user, rows } = await crowded()
      for (const limit of [1, 2, 3, 4, 5, 7, 22, 23, 24, 50]) {
        const { seen } = await walk(user.id, limit)
        expect(new Set(seen).size, `limit ${limit}: duplicates`).toBe(seen.length)
        expect([...seen].sort(), `limit ${limit}: gaps`).toEqual(rows.map((r) => r.id).sort())
      }
    })

    it("keeps the (occurredAt desc, id desc) order across pages", async () => {
      const { user } = await crowded()
      const { seen } = await walk(user.id, 4)
      const byId = new Map((await prisma.transaction.findMany({ where: { userId: user.id } })).map((t) => [t.id, t]))
      const keys = seen.map((id) => `${fromDbDate(byId.get(id)!.occurredAt)}|${id}`)
      expect(keys).toEqual([...keys].sort().reverse())
    })

    it("ends with a null cursor exactly when the rows run out", async () => {
      const { user } = await crowded()
      expect((await findTransactions(user.id, {}, undefined, 23)).nextCursor).toBeNull() // a full last page
      expect((await findTransactions(user.id, {}, undefined, 22)).nextCursor).not.toBeNull()
      const { pages } = await walk(user.id, 10)
      expect(pages).toBe(3)
    })

    it("is not disturbed by a row deleted between pages", async () => {
      const { user, rows } = await crowded()
      const first = await findTransactions(user.id, {}, undefined, 5)
      const shown = new Set(first.items.map((t) => t.id))
      const notYetSeen = rows.find((r) => !shown.has(r.id))!
      await softDeleteTransaction(user.id, notYetSeen.id)
      const rest = await walk(user.id, 5, first.nextCursor ?? undefined)
      const all = [...shown, ...rest.seen]
      expect(all).toHaveLength(22)
      expect(all).not.toContain(notYetSeen.id)
      expect(new Set(all).size).toBe(22)
    })
  })
})
