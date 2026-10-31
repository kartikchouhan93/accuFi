import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { calendarDate } from "@/domain/calendar-date"
import { prisma } from "@/server/db"
import * as repo from "@/server/repositories/budget-repository"
import { NotFoundError } from "@/server/repositories/errors"
import { inTransaction } from "@/server/repositories/unit-of-work"
import { createRegistry } from "./fixtures"

// The budget repository against the real database: what is stored and returned, what the user-scoped writes refuse, and
// the ledger lock that serialises creating and revising budgets on one ledger.

const registry = createRegistry()
afterAll(registry.cleanup)

type World = Awaited<ReturnType<typeof registry.makeWorld>>
let a: World
let b: World

beforeAll(async () => {
  a = await registry.makeWorld()
  b = await registry.makeWorld()
})

const m = (value: string) => calendarDate(value)

function data(over: Partial<repo.BudgetData> = {}): repo.BudgetData {
  return { nodeId: a.food.id, amountPaise: 500_000n, startMonth: m("2026-04-01"), endMonth: null, rollover: false, ...over }
}

async function expectNotFound(promise: Promise<unknown>, entity: NotFoundError["entity"]) {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  )
  expect(error, "expected NotFoundError").toBeInstanceOf(NotFoundError)
  expect((error as NotFoundError).entity).toBe(entity)
}

describe("insertBudget and the reads", () => {
  it("stores a budget for the caller and reads it back with paise as bigint and months as Date", async () => {
    const w = await registry.makeWorld()
    const row = await repo.insertBudget(w.user.id, data({ nodeId: w.food.id, endMonth: m("2026-09-01"), rollover: true }))
    expect(row.userId).toBe(w.user.id)
    expect(row.nodeId).toBe(w.food.id)
    expect(row.amountPaise).toBe(500_000n)
    expect(row.startMonth).toEqual(new Date("2026-04-01T00:00:00.000Z"))
    expect(row.endMonth).toEqual(new Date("2026-09-01T00:00:00.000Z"))
    expect(row.rollover).toBe(true)
    expect(await repo.findBudgetById(w.user.id, row.id)).toEqual(row)
    expect(await inTransaction((uow) => repo.findBudgetById(w.user.id, row.id, uow))).toEqual(row)
  })

  it("stores an open-ended budget with a null end month", async () => {
    const w = await registry.makeWorld()
    const row = await repo.insertBudget(w.user.id, data({ nodeId: w.food.id }))
    expect(row.endMonth).toBeNull()
    expect(row.rollover).toBe(false)
  })

  it("is not-found, and writes nothing, for another user's node", async () => {
    const before = await prisma.budget.count({ where: { userId: a.user.id } })
    await expectNotFound(repo.insertBudget(a.user.id, data({ nodeId: b.food.id })), "node")
    await expectNotFound(inTransaction((uow) => repo.insertBudget(a.user.id, data({ nodeId: b.food.id }), uow)), "node")
    expect(await prisma.budget.count({ where: { userId: a.user.id } })).toBe(before)
    expect(await prisma.budget.count({ where: { nodeId: b.food.id } })).toBe(0)
  })

  it("inserts inside the caller's transaction, which a rollback undoes", async () => {
    const w = await registry.makeWorld()
    await expect(
      inTransaction(async (uow) => {
        await repo.insertBudget(w.user.id, data({ nodeId: w.food.id }), uow)
        throw new Error("abort")
      }),
    ).rejects.toThrow("abort")
    expect(await repo.findBudgets(w.user.id)).toEqual([])
  })

  it("findBudgets lists by node id, then start month", async () => {
    const w = await registry.makeWorld()
    const rent = await registry.makeNode(w.user.id, "EXPENSE", "Rent")
    const rows = [
      await repo.insertBudget(w.user.id, data({ nodeId: w.food.id, startMonth: m("2026-06-01") })),
      await repo.insertBudget(w.user.id, data({ nodeId: rent.id, startMonth: m("2026-05-01") })),
      await repo.insertBudget(w.user.id, data({ nodeId: w.food.id, startMonth: m("2026-02-01"), endMonth: m("2026-03-01") })),
      await repo.insertBudget(w.user.id, data({ nodeId: rent.id, startMonth: m("2026-01-01"), endMonth: m("2026-04-01") })),
    ]
    const expected = [...rows].sort((x, y) => x.nodeId.localeCompare(y.nodeId) || x.startMonth.getTime() - y.startMonth.getTime())
    const listed = await repo.findBudgets(w.user.id)
    expect(listed.map((r) => r.id)).toEqual(expected.map((r) => r.id))
    expect(await inTransaction((uow) => repo.findBudgets(w.user.id, uow))).toEqual(listed)
  })

  it("findBudgetsForNode is per node and ascending by start month", async () => {
    const w = await registry.makeWorld()
    const rent = await registry.makeNode(w.user.id, "EXPENSE", "Rent")
    const late = await repo.insertBudget(w.user.id, data({ nodeId: w.food.id, startMonth: m("2026-08-01") }))
    const early = await repo.insertBudget(w.user.id, data({ nodeId: w.food.id, startMonth: m("2026-01-01"), endMonth: m("2026-07-01") }))
    await repo.insertBudget(w.user.id, data({ nodeId: rent.id, startMonth: m("2026-03-01") }))
    const forFood = await repo.findBudgetsForNode(w.user.id, w.food.id)
    expect(forFood.map((r) => r.id)).toEqual([early.id, late.id])
    expect(await inTransaction((uow) => repo.findBudgetsForNode(w.user.id, w.food.id, uow))).toEqual(forFood)
    expect(await repo.findBudgetsForNode(w.user.id, w.bank.id)).toEqual([])
  })

  it("findBudgetById is null for a missing id", async () => {
    expect(await repo.findBudgetById(a.user.id, "no-such-budget")).toBeNull()
  })
})

describe("updateBudget and deleteBudget", () => {
  it("changes only the named fields", async () => {
    const w = await registry.makeWorld()
    const row = await repo.insertBudget(w.user.id, data({ nodeId: w.food.id, endMonth: m("2026-09-01") }))
    const amountOnly = await repo.updateBudget(w.user.id, row.id, { amountPaise: 750_000n })
    expect(amountOnly).toMatchObject({ amountPaise: 750_000n, rollover: false, nodeId: w.food.id })
    expect(amountOnly.startMonth).toEqual(row.startMonth)
    expect(amountOnly.endMonth).toEqual(row.endMonth)

    const rolled = await repo.updateBudget(w.user.id, row.id, { rollover: true })
    expect(rolled).toMatchObject({ amountPaise: 750_000n, rollover: true })
    expect(rolled.endMonth).toEqual(row.endMonth)

    // null clears the end month; undefined leaves it alone
    const cleared = await repo.updateBudget(w.user.id, row.id, { endMonth: null })
    expect(cleared.endMonth).toBeNull()
    expect(cleared).toMatchObject({ amountPaise: 750_000n, rollover: true })
    const ended = await inTransaction((uow) => repo.updateBudget(w.user.id, row.id, { endMonth: m("2026-12-01") }, uow))
    expect(ended.endMonth).toEqual(new Date("2026-12-01T00:00:00.000Z"))
    expect(ended.startMonth).toEqual(row.startMonth)
    expect(ended.nodeId).toBe(w.food.id)
  })

  it("ignores keys that are not changeable, even when smuggled past the types", async () => {
    const w = await registry.makeWorld()
    const row = await repo.insertBudget(w.user.id, data({ nodeId: w.food.id }))
    const forged = { amountPaise: 1n, userId: b.user.id, nodeId: b.food.id } as Parameters<typeof repo.updateBudget>[2]
    const updated = await repo.updateBudget(w.user.id, row.id, forged)
    expect(updated.userId).toBe(w.user.id)
    expect(updated.nodeId).toBe(w.food.id)
    expect(updated.amountPaise).toBe(1n)
  })

  it("updating a foreign or missing id is not-found", async () => {
    const theirs = await repo.insertBudget(b.user.id, data({ nodeId: b.food.id }))
    await expectNotFound(repo.updateBudget(a.user.id, theirs.id, { amountPaise: 1n }), "budget")
    await expectNotFound(repo.updateBudget(a.user.id, "no-such-budget", { amountPaise: 1n }), "budget")
    expect(await prisma.budget.findUniqueOrThrow({ where: { id: theirs.id } })).toEqual(theirs)
  })

  it("deletes a budget, and a second delete is not-found", async () => {
    const w = await registry.makeWorld()
    const row = await repo.insertBudget(w.user.id, data({ nodeId: w.food.id }))
    await repo.deleteBudget(w.user.id, row.id)
    expect(await repo.findBudgetById(w.user.id, row.id)).toBeNull()
    await expectNotFound(repo.deleteBudget(w.user.id, row.id), "budget")
    const again = await repo.insertBudget(w.user.id, data({ nodeId: w.food.id }))
    await inTransaction((uow) => repo.deleteBudget(w.user.id, again.id, uow))
    expect(await repo.findBudgetById(w.user.id, again.id)).toBeNull()
  })

  it("deleting a foreign or missing id is not-found and removes nothing", async () => {
    const theirs = await repo.insertBudget(b.user.id, data({ nodeId: b.food.id }))
    await expectNotFound(repo.deleteBudget(a.user.id, theirs.id), "budget")
    await expectNotFound(repo.deleteBudget(a.user.id, "no-such-budget"), "budget")
    expect(await prisma.budget.findUniqueOrThrow({ where: { id: theirs.id } })).toEqual(theirs)
  })
})

describe("countBudgetsNaming", () => {
  it("counts the user's budgets on the node, however many", async () => {
    const w = await registry.makeWorld()
    expect(await repo.countBudgetsNaming(w.user.id, w.food.id)).toBe(0)
    await repo.insertBudget(w.user.id, data({ nodeId: w.food.id, startMonth: m("2026-01-01"), endMonth: m("2026-02-01") }))
    await repo.insertBudget(w.user.id, data({ nodeId: w.food.id, startMonth: m("2026-03-01") }))
    expect(await repo.countBudgetsNaming(w.user.id, w.food.id)).toBe(2)
    expect(await inTransaction((uow) => repo.countBudgetsNaming(w.user.id, w.food.id, uow))).toBe(2)
    expect(await repo.countBudgetsNaming(w.user.id, w.bank.id)).toBe(0)
  })
})

describe("lockLedger", () => {
  it("is true for the user's own node and false for another user's or an unknown one", async () => {
    expect(await inTransaction((uow) => repo.lockLedger(a.user.id, a.food.id, uow))).toBe(true)
    expect(await inTransaction((uow) => repo.lockLedger(a.user.id, b.food.id, uow))).toBe(false)
    expect(await inTransaction((uow) => repo.lockLedger(a.user.id, "no-such-node", uow))).toBe(false)
  })

  it("makes a second transaction wait until the first ends", async () => {
    const w = await registry.makeWorld()
    const order: string[] = []
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    let acquired!: () => void
    const firstHasLock = new Promise<void>((resolve) => (acquired = resolve))

    const first = inTransaction(async (uow) => {
      await repo.lockLedger(w.user.id, w.food.id, uow)
      acquired()
      await held
      order.push("first done")
    })
    await firstHasLock
    const second = inTransaction(async (uow) => {
      await repo.lockLedger(w.user.id, w.food.id, uow)
      order.push("second locked")
    })
    try {
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(order).toEqual([])
    } finally {
      release() // always: a failed assertion must not leave the first transaction held until Prisma's 5 s timeout
    }
    await Promise.all([first, second])
    expect(order).toEqual(["first done", "second locked"])
  })

  it("does not make a transaction on another ledger wait", async () => {
    const w = await registry.makeWorld()
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    let acquired!: () => void
    const firstHasLock = new Promise<void>((resolve) => (acquired = resolve))
    const first = inTransaction(async (uow) => {
      await repo.lockLedger(w.user.id, w.food.id, uow)
      acquired()
      await held
    })
    await firstHasLock
    try {
      expect(await inTransaction((uow) => repo.lockLedger(w.user.id, w.bank.id, uow))).toBe(true)
    } finally {
      release()
    }
    await first
  })
})
