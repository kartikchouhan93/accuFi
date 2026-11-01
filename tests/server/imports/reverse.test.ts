import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { calendarDate, toDbDate } from "@/domain/calendar-date"
import { prisma } from "@/server/db"
import { NotFoundError } from "@/server/repositories/errors"
import { findPending } from "@/server/repositories/recurring-repository"
import { sumBalances } from "@/server/repositories/transaction-repository"
import { commitBatch, InvalidImportError, reverseBatch } from "@/server/services/import-service"
import { editTransaction } from "@/server/services/transaction-service"
import { createRegistry } from "../repositories/fixtures"

// reverseBatch (design §6 stage 5), against the real database. "Today" is fixed at 2026-05-01 in the default user
// timezone (Asia/Kolkata), per the house rule that nothing here depends on the real date.

const registry = createRegistry()
afterAll(async () => {
  vi.useRealTimers()
  await registry.cleanup()
})

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-05-01T06:00:00Z") })
})

async function setup() {
  return registry.makeWorld()
}

/** A READY row on `line`, OUT from the account to `counterpartNodeId` by default; `over` overrides any field. */
const readyRow = (
  userId: string,
  batchId: string,
  line: number,
  counterpartNodeId: string,
  over: Parameters<typeof registry.makeImportRow>[3] = {},
) =>
  registry.makeImportRow(userId, batchId, line, {
    status: "READY",
    direction: "OUT",
    amountPaise: 10_000n,
    occurredOn: toDbDate(calendarDate("2026-04-10")),
    description: "Row",
    descriptionKey: "row",
    counterpartNodeId,
    ...over,
  })

async function balanceOf(userId: string, nodeId: string): Promise<bigint> {
  const row = (await sumBalances(userId)).find((n) => n.nodeId === nodeId)
  return row?.balance ?? 0n
}

describe("reverseBatch", () => {
  it("after reversal, balances return exactly to their pre-commit values, to the paisa", async () => {
    const w = await setup()
    const batch = await registry.makeBatch(w.user.id, w.bank.id)
    await readyRow(w.user.id, batch.id, 1, w.food.id, { amountPaise: 2_357n })
    await readyRow(w.user.id, batch.id, 2, w.income.id, { direction: "IN", amountPaise: 913n })
    const bankBefore = await balanceOf(w.user.id, w.bank.id)
    const foodBefore = await balanceOf(w.user.id, w.food.id)

    await commitBatch(w.user.id, batch.id)
    expect(await balanceOf(w.user.id, w.bank.id)).not.toBe(bankBefore)

    const result = await reverseBatch(w.user.id, batch.id)
    expect(result).toEqual({ reversed: 2, reopened: 0 })
    expect(await balanceOf(w.user.id, w.bank.id)).toBe(bankBefore)
    expect(await balanceOf(w.user.id, w.food.id)).toBe(foodBefore)

    const batchRow = await prisma.importBatch.findUniqueOrThrow({ where: { id: batch.id } })
    expect(batchRow.status).toBe("REVERSED")
    expect(batchRow.reversedAt).not.toBeNull()
  })

  it("soft-deletes exactly the batch's own transactions, leaving a hand-entered transaction and another batch's transactions untouched", async () => {
    const w = await setup()
    const batch = await registry.makeBatch(w.user.id, w.bank.id)
    await readyRow(w.user.id, batch.id, 1, w.food.id, { amountPaise: 1_000n })
    await commitBatch(w.user.id, batch.id)

    const hand = await registry.makeTransaction(w.user.id, w.bank.id, w.food.id, { amountPaise: 300n, occurredAt: "2026-04-07" })
    const other = await registry.makeBatch(w.user.id, w.bank.id)
    await readyRow(w.user.id, other.id, 1, w.food.id, { amountPaise: 777n })
    await commitBatch(w.user.id, other.id)

    await reverseBatch(w.user.id, batch.id)

    const batchTxns = await prisma.transaction.findMany({ where: { userId: w.user.id, importBatchId: batch.id } })
    expect(batchTxns.length).toBeGreaterThan(0)
    expect(batchTxns.every((t) => t.deletedAt !== null)).toBe(true)

    const handStored = await prisma.transaction.findUniqueOrThrow({ where: { id: hand.id } })
    expect(handStored.deletedAt).toBeNull()

    const otherTxns = await prisma.transaction.findMany({ where: { userId: w.user.id, importBatchId: other.id } })
    expect(otherTxns.length).toBeGreaterThan(0)
    expect(otherTxns.every((t) => t.deletedAt === null)).toBe(true)

    const otherBatchRow = await prisma.importBatch.findUniqueOrThrow({ where: { id: other.id } })
    expect(otherBatchRow.status).toBe("COMMITTED")
  })

  it("a linked occurrence is PENDING again with no transaction, and appears in the inbox", async () => {
    const w = await setup()
    const gym = await registry.makeNode(w.user.id, "EXPENSE", "Gym")
    const rule = await registry.makeRule(w.user.id, w.bank.id, gym.id, { amountPaise: 2_000n })
    const occurrence = await registry.makeOccurrence(w.user.id, rule.id, "2026-04-15")
    const batch = await registry.makeBatch(w.user.id, w.bank.id)
    await readyRow(w.user.id, batch.id, 1, gym.id, { occurrenceId: occurrence.id, amountPaise: 2_000n })
    await commitBatch(w.user.id, batch.id)
    expect((await prisma.recurringOccurrence.findUniqueOrThrow({ where: { id: occurrence.id } })).status).toBe("POSTED")

    const result = await reverseBatch(w.user.id, batch.id)
    expect(result.reopened).toBe(1)

    const reopened = await prisma.recurringOccurrence.findUniqueOrThrow({ where: { id: occurrence.id } })
    expect(reopened.status).toBe("PENDING")
    expect(reopened.transactionId).toBeNull()

    const inbox = await findPending(w.user.id)
    expect(inbox.map((o) => o.id)).toContain(occurrence.id)
  })

  it("a second reversal of an already-REVERSED batch returns {0, 0} and changes nothing further", async () => {
    const w = await setup()
    const batch = await registry.makeBatch(w.user.id, w.bank.id)
    await readyRow(w.user.id, batch.id, 1, w.food.id)
    await commitBatch(w.user.id, batch.id)
    const first = await reverseBatch(w.user.id, batch.id)
    expect(first).toEqual({ reversed: 1, reopened: 0 })
    const second = await reverseBatch(w.user.id, batch.id)
    expect(second).toEqual({ reversed: 0, reopened: 0 })
  })

  it("refuses to reverse a STAGED or DISCARDED batch", async () => {
    const w = await setup()
    const staged = await registry.makeBatch(w.user.id, w.bank.id, { status: "STAGED" })
    await expect(reverseBatch(w.user.id, staged.id)).rejects.toBeInstanceOf(InvalidImportError)
    const discarded = await registry.makeBatch(w.user.id, w.bank.id, { status: "DISCARDED", fileBytes: null })
    await expect(reverseBatch(w.user.id, discarded.id)).rejects.toBeInstanceOf(InvalidImportError)
  })

  it("a transaction the user edited after import is still reversed", async () => {
    const w = await setup()
    const batch = await registry.makeBatch(w.user.id, w.bank.id)
    const row = await readyRow(w.user.id, batch.id, 1, w.food.id, { amountPaise: 1_000n })
    await commitBatch(w.user.id, batch.id)
    const stored = await prisma.importRow.findUniqueOrThrow({ where: { id: row.id } })
    if (!stored.transactionId) throw new Error("row has no transaction")
    const txn = await prisma.transaction.findUniqueOrThrow({ where: { id: stored.transactionId } })
    await editTransaction(w.user.id, txn.id, { amount: 1_500n }, txn.version)

    const result = await reverseBatch(w.user.id, batch.id)
    expect(result.reversed).toBe(1)
    const after = await prisma.transaction.findUniqueOrThrow({ where: { id: txn.id } })
    expect(after.deletedAt).not.toBeNull()
    expect(after.amountPaise).toBe(1_500n)
  })

  it("reversing is not blocked by blockNegative, even when it leaves the account negative", async () => {
    const w = await setup()
    const guarded = await registry.makeNode(w.user.id, "ASSET", "Guarded", { blockNegative: true })
    const batch = await registry.makeBatch(w.user.id, guarded.id)
    await readyRow(w.user.id, batch.id, 1, w.income.id, { direction: "IN", amountPaise: 1_000n })
    await commitBatch(w.user.id, batch.id)
    expect(await balanceOf(w.user.id, guarded.id)).toBe(1_000n)

    // Spend what the import brought in: reversing it now would take the guarded account negative.
    await registry.makeTransaction(w.user.id, guarded.id, w.food.id, { amountPaise: 1_000n, occurredAt: "2026-04-20" })
    expect(await balanceOf(w.user.id, guarded.id)).toBe(0n)

    const result = await reverseBatch(w.user.id, batch.id)
    expect(result.reversed).toBe(1)
    expect(await balanceOf(w.user.id, guarded.id)).toBe(-1_000n)
  })

  it("a foreign batch id is NotFoundError", async () => {
    const w = await setup()
    const other = await setup()
    const foreign = await registry.makeBatch(other.user.id, other.bank.id, { status: "COMMITTED", fileBytes: null })
    await expect(reverseBatch(w.user.id, foreign.id)).rejects.toBeInstanceOf(NotFoundError)
  })
})
