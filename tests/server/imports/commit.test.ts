import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { calendarDate, fromDbDate, toDbDate } from "@/domain/calendar-date"
import { prisma } from "@/server/db"
import { NotFoundError } from "@/server/repositories/errors"
import { updateNode } from "@/server/repositories/node-repository"
import { findPending } from "@/server/repositories/recurring-repository"
import * as transactionRepo from "@/server/repositories/transaction-repository"
import { sumBalances } from "@/server/repositories/transaction-repository"
import {
  commitBatch,
  ImportNotReadyError,
  ImportRowsIllegalError,
  InvalidImportError,
} from "@/server/services/import-service"
import { OverdraftBlockedError } from "@/server/services/transaction-service"
import { createRegistry } from "../repositories/fixtures"

// commitBatch (design §6 stage 5), against the real database. "Today" is fixed at 2026-05-01 in the default user
// timezone (Asia/Kolkata), per the house rule that nothing here depends on the real date.

const registry = createRegistry()
afterAll(async () => {
  vi.useRealTimers()
  await registry.cleanup()
})

type World = Awaited<ReturnType<typeof registry.makeWorld>>
let b: World
beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-05-01T06:00:00Z") })
  b = await registry.makeWorld()
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

async function txnOf(rowId: string) {
  const row = await prisma.importRow.findUniqueOrThrow({ where: { id: rowId } })
  if (!row.transactionId) throw new Error(`row ${rowId} has no transaction`)
  return prisma.transaction.findUniqueOrThrow({ where: { id: row.transactionId } })
}

describe("commitBatch", () => {
  it("commits every READY row into a transaction: from/to by direction, the row's amount and date, a trimmed note, the key import:<rowId> and both import ids; rows and the batch end COMMITTED with the file bytes gone, and balances move by exactly the totals", async () => {
    const w = await setup()
    const batch = await registry.makeBatch(w.user.id, w.bank.id, { fileBytes: new Uint8Array([1, 2, 3]) })
    const out = await readyRow(w.user.id, batch.id, 1, w.food.id, {
      amountPaise: 5_000n,
      occurredOn: toDbDate(calendarDate("2026-04-05")),
      description: "  Coffee shop  ",
    })
    const income = await readyRow(w.user.id, batch.id, 2, w.income.id, {
      direction: "IN",
      amountPaise: 3_000n,
      occurredOn: toDbDate(calendarDate("2026-04-06")),
      description: "Salary",
      descriptionKey: "salary",
    })

    const bankBefore = await balanceOf(w.user.id, w.bank.id)
    const summary = await commitBatch(w.user.id, batch.id)

    expect(summary.imported).toBe(2)
    expect(summary.skipped).toBe(0)
    expect(summary.errored).toBe(0)
    expect(summary.linked).toBe(0)
    expect(summary.firstDate).toBe("2026-04-05")
    expect(summary.lastDate).toBe("2026-04-06")
    expect(summary.totalOutPaise).toBe("5000")
    expect(summary.totalInPaise).toBe("3000")
    expect(summary.committedAt).toEqual(expect.any(String))

    const storedOut = await prisma.importRow.findUniqueOrThrow({ where: { id: out.id } })
    expect(storedOut.status).toBe("COMMITTED")
    expect(storedOut.transactionId).not.toBeNull()
    const txOut = await txnOf(out.id)
    expect(txOut.fromNodeId).toBe(w.bank.id)
    expect(txOut.toNodeId).toBe(w.food.id)
    expect(txOut.amountPaise).toBe(5_000n)
    expect(txOut.note).toBe("Coffee shop")
    expect(txOut.idempotencyKey).toBe(`import:${out.id}`)
    expect(txOut.importBatchId).toBe(batch.id)
    expect(txOut.importRowId).toBe(out.id)
    expect(fromDbDate(txOut.occurredAt)).toBe("2026-04-05")

    const txIn = await txnOf(income.id)
    expect(txIn.fromNodeId).toBe(w.income.id)
    expect(txIn.toNodeId).toBe(w.bank.id)
    expect(txIn.amountPaise).toBe(3_000n)

    const storedBatch = await prisma.importBatch.findUniqueOrThrow({ where: { id: batch.id } })
    expect(storedBatch.status).toBe("COMMITTED")
    expect(storedBatch.fileBytes).toBeNull()
    expect(storedBatch.committedAt).not.toBeNull()

    expect(await balanceOf(w.user.id, w.bank.id)).toBe(bankBefore - 5_000n + 3_000n)
  })

  it("writes nothing for SKIPPED or ERRORED rows", async () => {
    const w = await setup()
    const batch = await registry.makeBatch(w.user.id, w.bank.id)
    const skipped = await registry.makeImportRow(w.user.id, batch.id, 1, {
      status: "SKIPPED",
      direction: "OUT",
      amountPaise: 1_000n,
      occurredOn: toDbDate(calendarDate("2026-04-01")),
    })
    const errored = await registry.makeImportRow(w.user.id, batch.id, 2, {
      status: "ERRORED",
      errorReason: "bad date",
      direction: null,
      amountPaise: null,
      occurredOn: null,
    })
    await readyRow(w.user.id, batch.id, 3, w.food.id)

    const summary = await commitBatch(w.user.id, batch.id)
    expect(summary.imported).toBe(1)
    expect(summary.skipped).toBe(1)
    expect(summary.errored).toBe(1)

    const storedSkipped = await prisma.importRow.findUniqueOrThrow({ where: { id: skipped.id } })
    expect(storedSkipped.status).toBe("SKIPPED")
    expect(storedSkipped.transactionId).toBeNull()
    const storedErrored = await prisma.importRow.findUniqueOrThrow({ where: { id: errored.id } })
    expect(storedErrored.status).toBe("ERRORED")
    expect(storedErrored.transactionId).toBeNull()
    expect(await prisma.transaction.count({ where: { userId: w.user.id, importRowId: { in: [skipped.id, errored.id] } } })).toBe(0)
  })

  it("refuses with the count of PENDING rows remaining, and writes nothing", async () => {
    const w = await setup()
    const batch = await registry.makeBatch(w.user.id, w.bank.id)
    await registry.makeImportRow(w.user.id, batch.id, 1, {
      status: "PENDING",
      direction: "OUT",
      amountPaise: 1_000n,
      occurredOn: toDbDate(calendarDate("2026-04-01")),
    })
    await registry.makeImportRow(w.user.id, batch.id, 2, {
      status: "PENDING",
      direction: "OUT",
      amountPaise: 1_000n,
      occurredOn: toDbDate(calendarDate("2026-04-01")),
    })
    const ready = await readyRow(w.user.id, batch.id, 3, w.food.id)

    const error = await commitBatch(w.user.id, batch.id).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ImportNotReadyError)
    expect((error as ImportNotReadyError).pending).toBe(2)
    expect((await prisma.importBatch.findUniqueOrThrow({ where: { id: batch.id } })).status).toBe("STAGED")
    expect((await prisma.importRow.findUniqueOrThrow({ where: { id: ready.id } })).status).toBe("READY")
    expect(await prisma.transaction.count({ where: { userId: w.user.id, importBatchId: batch.id } })).toBe(0)
  })

  it("review focus 2: a row that fails between validation and insert leaves nothing written at all, the batch STAGED and reviewable, no rule changed and no occurrence posted", async () => {
    const w = await setup()
    const rule = await registry.makeRule(w.user.id, w.bank.id, w.food.id, { amountPaise: 1_000n })
    const occurrence = await registry.makeOccurrence(w.user.id, rule.id, "2026-04-10")
    const batch = await registry.makeBatch(w.user.id, w.bank.id)
    const first = await readyRow(w.user.id, batch.id, 1, w.food.id, { descriptionKey: "first" })
    const second = await readyRow(w.user.id, batch.id, 2, w.food.id, { occurrenceId: occurrence.id, descriptionKey: "second" })
    const third = await readyRow(w.user.id, batch.id, 3, w.food.id, { descriptionKey: "third" })

    // The third row fails after the first two have actually been inserted (within the same open database transaction,
    // since insertTransactions is given the commit's own uow): proves the whole commit is undone, not just the failing row.
    const original = transactionRepo.insertTransactions
    const spy = vi.spyOn(transactionRepo, "insertTransactions").mockImplementationOnce(async (userId, drafts, groupId, uow) => {
      await original(userId, drafts.slice(0, 2), groupId, uow)
      throw new Error("boom")
    })
    await expect(commitBatch(w.user.id, batch.id)).rejects.toThrow("boom")
    spy.mockRestore()

    const storedBatch = await prisma.importBatch.findUniqueOrThrow({ where: { id: batch.id } })
    expect(storedBatch.status).toBe("STAGED")
    expect(storedBatch.fileBytes).not.toBeNull()
    for (const row of [first, second, third]) {
      const stored = await prisma.importRow.findUniqueOrThrow({ where: { id: row.id } })
      expect(stored.status).toBe("READY")
      expect(stored.transactionId).toBeNull()
    }
    expect(await prisma.transaction.count({ where: { userId: w.user.id, importBatchId: batch.id } })).toBe(0)
    expect(await prisma.counterpartRule.count({ where: { userId: w.user.id } })).toBe(0)
    expect((await prisma.recurringOccurrence.findUniqueOrThrow({ where: { id: occurrence.id } })).status).toBe("PENDING")
  })

  it("committing twice returns the same summary and leaves exactly one set of transactions", async () => {
    const w = await setup()
    const batch = await registry.makeBatch(w.user.id, w.bank.id)
    await readyRow(w.user.id, batch.id, 1, w.food.id, { amountPaise: 2_000n })
    const first = await commitBatch(w.user.id, batch.id)
    const second = await commitBatch(w.user.id, batch.id)
    expect(second).toEqual(first)
    expect(await prisma.transaction.count({ where: { userId: w.user.id, importBatchId: batch.id } })).toBe(1)
  })

  it("two concurrent commits of the same batch produce exactly one set of transactions", async () => {
    const w = await setup()
    const batch = await registry.makeBatch(w.user.id, w.bank.id)
    await readyRow(w.user.id, batch.id, 1, w.food.id, { amountPaise: 2_000n })
    const [first, second] = await Promise.all([commitBatch(w.user.id, batch.id), commitBatch(w.user.id, batch.id)])
    expect(first).toEqual(second)
    expect(await prisma.transaction.count({ where: { userId: w.user.id, importBatchId: batch.id } })).toBe(1)
  })

  it("review focus 3: a counterpart archived since staging refuses the whole commit, naming the line, and writes nothing", async () => {
    const w = await setup()
    const batch = await registry.makeBatch(w.user.id, w.bank.id)
    const ok = await readyRow(w.user.id, batch.id, 1, w.food.id)
    const shop = await registry.makeNode(w.user.id, "EXPENSE", "Shop")
    await readyRow(w.user.id, batch.id, 2, shop.id)
    await updateNode(w.user.id, shop.id, { archivedAt: new Date() })

    const error = await commitBatch(w.user.id, batch.id).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ImportRowsIllegalError)
    expect((error as ImportRowsIllegalError).rows).toEqual([{ line: 2, reason: expect.any(String) }])
    expect((await prisma.importBatch.findUniqueOrThrow({ where: { id: batch.id } })).status).toBe("STAGED")
    expect((await prisma.importRow.findUniqueOrThrow({ where: { id: ok.id } })).status).toBe("READY")
    expect(await prisma.transaction.count({ where: { userId: w.user.id, importBatchId: batch.id } })).toBe(0)
  })

  it("review focus 3: a flow that is no longer legal refuses the whole commit, naming the line, and writes nothing", async () => {
    const w = await setup()
    const batch = await registry.makeBatch(w.user.id, w.bank.id)
    const ok = await readyRow(w.user.id, batch.id, 1, w.food.id)
    // ASSET -> INCOME_SOURCE is not a legal flow: a row that staged legally and was somehow left pointed this way
    // (a crafted state, since no screen in the product can produce it) must still be refused at commit, not written.
    await readyRow(w.user.id, batch.id, 2, w.income.id, { direction: "OUT" })

    const error = await commitBatch(w.user.id, batch.id).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ImportRowsIllegalError)
    expect((error as ImportRowsIllegalError).rows).toEqual([{ line: 2, reason: expect.any(String) }])
    expect((await prisma.importBatch.findUniqueOrThrow({ where: { id: batch.id } })).status).toBe("STAGED")
    expect((await prisma.importRow.findUniqueOrThrow({ where: { id: ok.id } })).status).toBe("READY")
    expect(await prisma.transaction.count({ where: { userId: w.user.id, importBatchId: batch.id } })).toBe(0)
  })

  it("review focus 3: a linked occurrence handled since staging refuses the whole commit, naming the line, and writes nothing", async () => {
    const w = await setup()
    const rule = await registry.makeRule(w.user.id, w.bank.id, w.food.id, { amountPaise: 1_000n })
    const occurrence = await registry.makeOccurrence(w.user.id, rule.id, "2026-04-10", { status: "DISMISSED", resolvedAt: new Date() })
    const batch = await registry.makeBatch(w.user.id, w.bank.id)
    const ok = await readyRow(w.user.id, batch.id, 1, w.food.id)
    await readyRow(w.user.id, batch.id, 2, w.food.id, { occurrenceId: occurrence.id })

    const error = await commitBatch(w.user.id, batch.id).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ImportRowsIllegalError)
    expect((error as ImportRowsIllegalError).rows).toEqual([{ line: 2, reason: expect.any(String) }])
    expect((await prisma.importBatch.findUniqueOrThrow({ where: { id: batch.id } })).status).toBe("STAGED")
    expect((await prisma.importRow.findUniqueOrThrow({ where: { id: ok.id } })).status).toBe("READY")
    expect(await prisma.transaction.count({ where: { userId: w.user.id, importBatchId: batch.id } })).toBe(0)
  })

  it("a blockNegative account that the batch would overdraw refuses and stays STAGED; one it does not overdraw succeeds", async () => {
    const w = await setup()
    const guarded = await registry.makeNode(w.user.id, "ASSET", "Guarded", { blockNegative: true })
    await registry.makeTransaction(w.user.id, w.income.id, guarded.id, { amountPaise: 1_000n, occurredAt: "2026-04-01" })

    const overBatch = await registry.makeBatch(w.user.id, guarded.id)
    await readyRow(w.user.id, overBatch.id, 1, w.food.id, { amountPaise: 2_000n })
    const error = await commitBatch(w.user.id, overBatch.id).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(OverdraftBlockedError)
    expect((await prisma.importBatch.findUniqueOrThrow({ where: { id: overBatch.id } })).status).toBe("STAGED")
    expect(await prisma.transaction.count({ where: { userId: w.user.id, importBatchId: overBatch.id } })).toBe(0)

    const okBatch = await registry.makeBatch(w.user.id, guarded.id)
    await readyRow(w.user.id, okBatch.id, 1, w.food.id, { amountPaise: 500n })
    await commitBatch(w.user.id, okBatch.id)
    expect((await prisma.importBatch.findUniqueOrThrow({ where: { id: okBatch.id } })).status).toBe("COMMITTED")
    expect(await balanceOf(w.user.id, guarded.id)).toBe(500n)
  })

  it("a linked row commits with the bank's date and amount, takes its counterpart from the rule (not the row's own stored counterpart), and marks the occurrence POSTED; it leaves the recurring inbox", async () => {
    const w = await setup()
    const gym = await registry.makeNode(w.user.id, "EXPENSE", "Gym")
    const rule = await registry.makeRule(w.user.id, w.bank.id, gym.id, { amountPaise: 2_000n, name: "Gym" })
    const occurrence = await registry.makeOccurrence(w.user.id, rule.id, "2026-04-15")
    const batch = await registry.makeBatch(w.user.id, w.bank.id)
    // Stored counterpart is deliberately wrong (w.food): commit must derive it from the rule, not trust this.
    const row = await readyRow(w.user.id, batch.id, 1, w.food.id, {
      occurrenceId: occurrence.id,
      amountPaise: 2_050n,
      occurredOn: toDbDate(calendarDate("2026-04-16")),
      descriptionKey: "gym payment",
    })

    const summary = await commitBatch(w.user.id, batch.id)
    expect(summary.linked).toBe(1)

    const txn = await txnOf(row.id)
    expect(txn.toNodeId).toBe(gym.id) // the rule's other ledger, not w.food
    expect(txn.fromNodeId).toBe(w.bank.id)
    expect(txn.amountPaise).toBe(2_050n) // the bank's amount, not the rule's 2000
    expect(fromDbDate(txn.occurredAt)).toBe("2026-04-16") // the bank's date, not the rule's due day

    const updated = await prisma.recurringOccurrence.findUniqueOrThrow({ where: { id: occurrence.id } })
    expect(updated.status).toBe("POSTED")
    expect(updated.transactionId).toBe(txn.id)

    const inbox = await findPending(w.user.id)
    expect(inbox.map((o) => o.id)).not.toContain(occurrence.id)
  })

  it("teaches a rule for each committed row's description key, and a changed choice replaces the node", async () => {
    const w = await setup()
    const batch = await registry.makeBatch(w.user.id, w.bank.id)
    await readyRow(w.user.id, batch.id, 1, w.food.id, { descriptionKey: "coffee shop" })
    await commitBatch(w.user.id, batch.id)
    const rule1 = await prisma.counterpartRule.findUniqueOrThrow({
      where: { userId_direction_descriptionKey: { userId: w.user.id, direction: "OUT", descriptionKey: "coffee shop" } },
    })
    expect(rule1.nodeId).toBe(w.food.id)
    expect(rule1.hits).toBe(1)

    const gym = await registry.makeNode(w.user.id, "EXPENSE", "Gym")
    const batch2 = await registry.makeBatch(w.user.id, w.bank.id)
    await readyRow(w.user.id, batch2.id, 1, gym.id, { descriptionKey: "coffee shop" })
    await commitBatch(w.user.id, batch2.id)
    const rule2 = await prisma.counterpartRule.findUniqueOrThrow({
      where: { userId_direction_descriptionKey: { userId: w.user.id, direction: "OUT", descriptionKey: "coffee shop" } },
    })
    expect(rule2.nodeId).toBe(gym.id)
    expect(rule2.hits).toBe(2)
  })

  it("refuses a batch that is not STAGED or COMMITTED", async () => {
    const w = await setup()
    for (const status of ["UPLOADED", "REVERSED", "DISCARDED"] as const) {
      const batch = await registry.makeBatch(w.user.id, w.bank.id, { status, fileBytes: null })
      await expect(commitBatch(w.user.id, batch.id)).rejects.toBeInstanceOf(InvalidImportError)
    }
  })

  it("a foreign batch id is NotFoundError, and nothing of another user's is committed", async () => {
    const w = await setup()
    const foreign = await registry.makeBatch(b.user.id, b.bank.id)
    await readyRow(b.user.id, foreign.id, 1, b.food.id)
    await expect(commitBatch(w.user.id, foreign.id)).rejects.toBeInstanceOf(NotFoundError)
    expect((await prisma.importBatch.findUniqueOrThrow({ where: { id: foreign.id } })).status).toBe("STAGED")
  })
})
