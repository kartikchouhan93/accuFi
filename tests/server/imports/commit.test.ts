import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { calendarDate, fromDbDate, toDbDate } from "@/domain/calendar-date"
import { prisma } from "@/server/db"
import { NotFoundError } from "@/server/repositories/errors"
import { updateNode } from "@/server/repositories/node-repository"
import { findPending, updateRule } from "@/server/repositories/recurring-repository"
import * as importRepo from "@/server/repositories/import-repository"
import * as transactionRepo from "@/server/repositories/transaction-repository"
import { sumBalances } from "@/server/repositories/transaction-repository"
import {
  commitBatch,
  ImportNotReadyError,
  ImportRowsIllegalError,
  InvalidImportError,
  loadReview,
  updateRow,
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

  it("a linked row commits with the bank's date and amount, to its rule's ledger (which LINK stored as the row's own counterpart), and marks the occurrence POSTED; it leaves the recurring inbox", async () => {
    const w = await setup()
    const gym = await registry.makeNode(w.user.id, "EXPENSE", "Gym")
    const rule = await registry.makeRule(w.user.id, w.bank.id, gym.id, { amountPaise: 2_000n, name: "Gym" })
    const occurrence = await registry.makeOccurrence(w.user.id, rule.id, "2026-04-15")
    const batch = await registry.makeBatch(w.user.id, w.bank.id)
    // Exactly the state `updateRow({ occurrence: "LINK", decision: "IMPORT" })` leaves: the rule's ledger stored as the
    // row's own counterpart, alongside the link.
    const row = await readyRow(w.user.id, batch.id, 1, gym.id, {
      occurrenceId: occurrence.id,
      amountPaise: 2_050n,
      occurredOn: toDbDate(calendarDate("2026-04-16")),
      descriptionKey: "gym payment",
    })

    const summary = await commitBatch(w.user.id, batch.id)
    expect(summary.linked).toBe(1)

    const txn = await txnOf(row.id)
    expect(txn.toNodeId).toBe(gym.id)
    expect(txn.fromNodeId).toBe(w.bank.id)
    expect(txn.amountPaise).toBe(2_050n) // the bank's amount, not the rule's 2000
    expect(fromDbDate(txn.occurredAt)).toBe("2026-04-16") // the bank's date, not the rule's due day

    const updated = await prisma.recurringOccurrence.findUniqueOrThrow({ where: { id: occurrence.id } })
    expect(updated.status).toBe("POSTED")
    expect(updated.transactionId).toBe(txn.id)

    const inbox = await findPending(w.user.id)
    expect(inbox.map((o) => o.id)).not.toContain(occurrence.id)
  })

  it("final review C1: a linked row whose own stored ledger differs from its rule's is refused, naming the line, rather than silently posted to the rule's ledger; nothing is written and the occurrence stays PENDING", async () => {
    const w = await setup()
    const gym = await registry.makeNode(w.user.id, "EXPENSE", "Gym")
    const rule = await registry.makeRule(w.user.id, w.bank.id, gym.id, { amountPaise: 2_000n, name: "Gym" })
    const occurrence = await registry.makeOccurrence(w.user.id, rule.id, "2026-04-15")
    const batch = await registry.makeBatch(w.user.id, w.bank.id)
    const ok = await readyRow(w.user.id, batch.id, 1, w.food.id)
    // The review screen showed "-> Food" for this row (its stored counterpart) while it still carried a coincidental
    // occurrence match whose rule posts to Gym: a state `updateRow` no longer produces, built directly here. Before the
    // fix, commit silently posted it to Gym, consumed the occurrence and taught the rule table Gym.
    const diverged = await readyRow(w.user.id, batch.id, 2, w.food.id, {
      occurrenceId: occurrence.id,
      amountPaise: 2_050n,
      occurredOn: toDbDate(calendarDate("2026-04-16")),
      descriptionKey: "gym payment",
    })

    const error = await commitBatch(w.user.id, batch.id).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ImportRowsIllegalError)
    expect((error as ImportRowsIllegalError).rows).toEqual([{ line: 2, reason: expect.stringContaining("linked recurring entry") }])

    expect((await prisma.importBatch.findUniqueOrThrow({ where: { id: batch.id } })).status).toBe("STAGED")
    for (const id of [ok.id, diverged.id]) {
      const stored = await prisma.importRow.findUniqueOrThrow({ where: { id } })
      expect(stored.status).toBe("READY")
      expect(stored.transactionId).toBeNull()
    }
    expect(await prisma.transaction.count({ where: { userId: w.user.id, importBatchId: batch.id } })).toBe(0)
    expect((await prisma.recurringOccurrence.findUniqueOrThrow({ where: { id: occurrence.id } })).status).toBe("PENDING")
    expect(await prisma.counterpartRule.count({ where: { userId: w.user.id } })).toBe(0)
    expect(await balanceOf(w.user.id, gym.id)).toBe(0n)
  })

  it("final review C1: a rule re-pointed at another ledger after the row was linked is refused at commit, not followed", async () => {
    const w = await setup()
    const gym = await registry.makeNode(w.user.id, "EXPENSE", "Gym")
    const club = await registry.makeNode(w.user.id, "EXPENSE", "Club")
    const rule = await registry.makeRule(w.user.id, w.bank.id, gym.id, { amountPaise: 2_000n, name: "Gym" })
    const occurrence = await registry.makeOccurrence(w.user.id, rule.id, "2026-04-15")
    const batch = await registry.makeBatch(w.user.id, w.bank.id)
    await readyRow(w.user.id, batch.id, 1, gym.id, { occurrenceId: occurrence.id, amountPaise: 2_000n, occurredOn: toDbDate(calendarDate("2026-04-15")) })

    // Same account, same direction, a different ledger: the row was reviewed as "-> Gym".
    await updateRule(w.user.id, rule.id, 0, { fromNodeId: w.bank.id, toNodeId: club.id })

    const error = await commitBatch(w.user.id, batch.id).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ImportRowsIllegalError)
    expect((error as ImportRowsIllegalError).rows).toEqual([{ line: 1, reason: expect.any(String) }])
    expect(await prisma.transaction.count({ where: { userId: w.user.id, importBatchId: batch.id } })).toBe(0)
    expect(await balanceOf(w.user.id, club.id)).toBe(0n)
  })

  it("review focus (critical): a rule edited to no longer touch the account since staging refuses the whole commit, naming the line, and writes nothing", async () => {
    const w = await setup()
    const gym = await registry.makeNode(w.user.id, "EXPENSE", "Gym")
    const wallet = await registry.makeNode(w.user.id, "ASSET", "Wallet")
    const rule = await registry.makeRule(w.user.id, w.bank.id, gym.id, { amountPaise: 2_000n, name: "Gym" })
    const occurrence = await registry.makeOccurrence(w.user.id, rule.id, "2026-04-15")
    const batch = await registry.makeBatch(w.user.id, w.bank.id)
    const ok = await readyRow(w.user.id, batch.id, 1, w.food.id)
    const linked = await readyRow(w.user.id, batch.id, 2, w.food.id, {
      occurrenceId: occurrence.id,
      amountPaise: 2_050n,
      occurredOn: toDbDate(calendarDate("2026-04-16")),
      descriptionKey: "gym payment",
    })

    // The rule is edited after staging to no longer involve the batch's account at all (Wallet -> Gym instead of
    // Bank -> Gym), while the occurrence it drives stays PENDING and the row stays linked to it.
    await updateRule(w.user.id, rule.id, 0, { fromNodeId: wallet.id, toNodeId: gym.id })

    const error = await commitBatch(w.user.id, batch.id).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ImportRowsIllegalError)
    expect((error as ImportRowsIllegalError).rows).toEqual([{ line: 2, reason: expect.any(String) }])

    expect((await prisma.importBatch.findUniqueOrThrow({ where: { id: batch.id } })).status).toBe("STAGED")
    expect((await prisma.importRow.findUniqueOrThrow({ where: { id: ok.id } })).status).toBe("READY")
    expect((await prisma.importRow.findUniqueOrThrow({ where: { id: linked.id } })).status).toBe("READY")
    expect(await prisma.transaction.count({ where: { userId: w.user.id, importBatchId: batch.id } })).toBe(0)
    expect((await prisma.recurringOccurrence.findUniqueOrThrow({ where: { id: occurrence.id } })).status).toBe("PENDING")
    expect(await balanceOf(w.user.id, wallet.id)).toBe(0n)
  })

  it("review focus (critical): a rule edited so its direction relative to the account flips since staging refuses the whole commit, naming the line", async () => {
    const w = await setup()
    const gym = await registry.makeNode(w.user.id, "EXPENSE", "Gym")
    // A rule that pays the bank FROM gym (e.g. a refund) rather than paying gym from the bank: the rule still
    // touches the account, but on the opposite side, so its direction relative to the account has flipped.
    const rule = await registry.makeRule(w.user.id, w.bank.id, gym.id, { amountPaise: 2_000n, name: "Gym" })
    const occurrence = await registry.makeOccurrence(w.user.id, rule.id, "2026-04-15")
    const batch = await registry.makeBatch(w.user.id, w.bank.id)
    const linked = await readyRow(w.user.id, batch.id, 1, w.food.id, {
      direction: "OUT",
      occurrenceId: occurrence.id,
      amountPaise: 2_050n,
      occurredOn: toDbDate(calendarDate("2026-04-16")),
      descriptionKey: "gym payment",
    })

    await updateRule(w.user.id, rule.id, 0, { fromNodeId: gym.id, toNodeId: w.bank.id })

    const error = await commitBatch(w.user.id, batch.id).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ImportRowsIllegalError)
    expect((error as ImportRowsIllegalError).rows).toEqual([{ line: 1, reason: expect.any(String) }])
    expect((await prisma.importBatch.findUniqueOrThrow({ where: { id: batch.id } })).status).toBe("STAGED")
    expect((await prisma.importRow.findUniqueOrThrow({ where: { id: linked.id } })).status).toBe("READY")
    expect(await prisma.transaction.count({ where: { userId: w.user.id, importBatchId: batch.id } })).toBe(0)
    expect((await prisma.recurringOccurrence.findUniqueOrThrow({ where: { id: occurrence.id } })).status).toBe("PENDING")
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
    // A different day than the first batch's row: the same day and amount would (rightly) now be caught at commit as a
    // duplicate of the transaction the first batch just recorded.
    await readyRow(w.user.id, batch2.id, 1, gym.id, { descriptionKey: "coffee shop", occurredOn: toDbDate(calendarDate("2026-04-25")) })
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

  it("commits a batch of about 2,000 READY rows (the commit transaction's timeout override, and caching node lookups by id, both matter at this scale)", async () => {
    const w = await setup()
    const batch = await registry.makeBatch(w.user.id, w.bank.id)
    const ROW_COUNT = 2_000
    // Every row shares the same counterpart and description key: the point is to exercise the now-cached
    // requireNode lookup (one fetch for 2,000 rows naming the same counterpart, not 2,000) and to prove the
    // commit's whole single transaction - at IMPORT_MAX_ROWS's query shape - finishes inside its timeout override
    // rather than hitting Prisma's 5-second interactive-transaction default.
    await prisma.importRow.createMany({
      data: Array.from({ length: ROW_COUNT }, (_, i) => ({
        userId: w.user.id,
        batchId: batch.id,
        line: i + 1,
        raw: ["x"],
        status: "READY" as const,
        direction: "OUT" as const,
        amountPaise: 100n,
        occurredOn: toDbDate(calendarDate("2026-04-10")),
        description: `Row ${i}`,
        descriptionKey: "scale-test",
        counterpartNodeId: w.food.id,
      })),
    })

    const bankBefore = await balanceOf(w.user.id, w.bank.id)
    const upsertSpy = vi.spyOn(importRepo, "upsertRule")
    const summary = await commitBatch(w.user.id, batch.id)

    expect(summary.imported).toBe(ROW_COUNT)
    expect(summary.errored).toBe(0)
    expect(summary.skipped).toBe(0)
    expect(await prisma.transaction.count({ where: { userId: w.user.id, importBatchId: batch.id } })).toBe(ROW_COUNT)
    expect(await prisma.importRow.count({ where: { batchId: batch.id, status: "COMMITTED" } })).toBe(ROW_COUNT)
    expect((await prisma.importBatch.findUniqueOrThrow({ where: { id: batch.id } })).status).toBe("COMMITTED")
    expect(await balanceOf(w.user.id, w.bank.id)).toBe(bankBefore - BigInt(ROW_COUNT) * 100n)

    const rule = await prisma.counterpartRule.findUniqueOrThrow({
      where: { userId_direction_descriptionKey: { userId: w.user.id, direction: "OUT", descriptionKey: "scale-test" } },
    })
    expect(rule.nodeId).toBe(w.food.id)
    expect(rule.hits).toBe(ROW_COUNT) // every row still counts as a hit...
    expect(upsertSpy).toHaveBeenCalledTimes(1) // ...taught in one upsert for the one key, not one per row
    upsertSpy.mockRestore()
  }, 60_000)

  it("final review I12: teaches one rule per distinct key, the last row's ledger in file order winning and every row counted, exactly as row-by-row upserts would", async () => {
    const w = await setup()
    const gym = await registry.makeNode(w.user.id, "EXPENSE", "Gym")
    const batch = await registry.makeBatch(w.user.id, w.bank.id)
    const on = (day: string) => ({ occurredOn: toDbDate(calendarDate(day)) })
    await readyRow(w.user.id, batch.id, 1, w.food.id, { descriptionKey: "corner shop", ...on("2026-04-11") })
    await readyRow(w.user.id, batch.id, 2, w.food.id, { descriptionKey: "corner shop", ...on("2026-04-12") })
    await readyRow(w.user.id, batch.id, 3, gym.id, { descriptionKey: "corner shop", ...on("2026-04-13") })
    await readyRow(w.user.id, batch.id, 4, w.income.id, { direction: "IN", descriptionKey: "corner shop", ...on("2026-04-14") })
    await readyRow(w.user.id, batch.id, 5, w.food.id, { descriptionKey: "", ...on("2026-04-15") })

    const spy = vi.spyOn(importRepo, "upsertRule")
    await commitBatch(w.user.id, batch.id)
    expect(spy).toHaveBeenCalledTimes(2) // OUT "corner shop" and IN "corner shop"; the empty key teaches nothing
    spy.mockRestore()

    const rules = await prisma.counterpartRule.findMany({ where: { userId: w.user.id }, orderBy: { direction: "asc" } })
    expect(rules.map((r) => ({ direction: r.direction, key: r.descriptionKey, nodeId: r.nodeId, hits: r.hits }))).toEqual([
      { direction: "OUT", key: "corner shop", nodeId: gym.id, hits: 3 },
      { direction: "IN", key: "corner shop", nodeId: w.income.id, hits: 1 },
    ])
  })
})

describe("commitBatch re-checks duplicates against the ledger as it is now (final review C2)", () => {
  it("a transaction hand-entered after staging that duplicates a READY row refuses the whole commit, naming the line, writes no transaction, and sends that row back to review flagged against it", async () => {
    const w = await setup()
    const batch = await registry.makeBatch(w.user.id, w.bank.id)
    const clean = await readyRow(w.user.id, batch.id, 1, w.food.id, { amountPaise: 7_000n })
    const later = await readyRow(w.user.id, batch.id, 2, w.food.id, { amountPaise: 4_200n, occurredOn: toDbDate(calendarDate("2026-04-20")) })

    // After staging (no flag on either row), before commit: the same 42.00 is entered by hand a day later.
    const handEntered = await registry.makeTransaction(w.user.id, w.bank.id, w.food.id, { amountPaise: 4_200n, occurredAt: "2026-04-21" })
    const bankBefore = await balanceOf(w.user.id, w.bank.id)

    const error = await commitBatch(w.user.id, batch.id).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ImportRowsIllegalError)
    expect((error as ImportRowsIllegalError).rows).toEqual([{ line: 2, reason: expect.stringContaining("recorded since staging") }])

    // Nothing posted; the batch is still STAGED and its bytes kept; the clean row is untouched.
    expect(await prisma.transaction.count({ where: { userId: w.user.id, importBatchId: batch.id } })).toBe(0)
    expect(await balanceOf(w.user.id, w.bank.id)).toBe(bankBefore)
    const storedBatch = await prisma.importBatch.findUniqueOrThrow({ where: { id: batch.id } })
    expect(storedBatch.status).toBe("STAGED")
    expect(storedBatch.fileBytes).not.toBeNull()
    expect((await prisma.importRow.findUniqueOrThrow({ where: { id: clean.id } })).status).toBe("READY")

    // The duplicate row is recoverable, not stuck: PENDING again, flagged against the hand entry, and shown on the review
    // screen with the duplicate it matches, exactly as a staging-time duplicate would be.
    const flagged = await prisma.importRow.findUniqueOrThrow({ where: { id: later.id } })
    expect(flagged.status).toBe("PENDING")
    expect(flagged.duplicateOfTransactionId).toBe(handEntered.id)
    expect(flagged.counterpartNodeId).toBe(w.food.id)
    const review = await loadReview(w.user.id, batch.id, { filter: "duplicates", page: 1 })
    expect(review.rows.map((r) => r.line)).toEqual([2])
    expect(review.rows[0].duplicate).toMatchObject({ transactionId: handEntered.id, occurredAt: "2026-04-21", amountPaise: "4200" })
    expect(review.canCommit).toBe(false)

    // The person decides it as usual ("Skip as duplicate" here), and the next commit goes through with only the clean row.
    await updateRow(w.user.id, later.id, { decision: "SKIP" })
    const summary = await commitBatch(w.user.id, batch.id)
    expect(summary.imported).toBe(1)
    expect(summary.skipped).toBe(1)
    expect(await balanceOf(w.user.id, w.bank.id)).toBe(bankBefore - 7_000n)
  })

  it("two overlapping statements staged before either is committed: committing the second after the first refuses the overlap rather than posting it twice", async () => {
    const w = await setup()
    // Statement A (staged and committed first) and statement B overlap on one 99.00 line; neither saw the other at staging.
    const first = await registry.makeBatch(w.user.id, w.bank.id)
    await readyRow(w.user.id, first.id, 1, w.food.id, { amountPaise: 9_900n, occurredOn: toDbDate(calendarDate("2026-03-28")) })
    const second = await registry.makeBatch(w.user.id, w.bank.id)
    const overlap = await readyRow(w.user.id, second.id, 1, w.food.id, { amountPaise: 9_900n, occurredOn: toDbDate(calendarDate("2026-03-28")) })
    await readyRow(w.user.id, second.id, 2, w.food.id, { amountPaise: 1_100n, occurredOn: toDbDate(calendarDate("2026-04-02")) })

    await commitBatch(w.user.id, first.id)
    const posted = await txnOf((await prisma.importRow.findFirstOrThrow({ where: { batchId: first.id } })).id)

    const error = await commitBatch(w.user.id, second.id).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ImportRowsIllegalError)
    expect((error as ImportRowsIllegalError).rows).toEqual([{ line: 1, reason: expect.any(String) }])
    expect(await prisma.transaction.count({ where: { userId: w.user.id, importBatchId: second.id } })).toBe(0)
    expect(await prisma.transaction.count({ where: { userId: w.user.id, amountPaise: 9_900n, deletedAt: null } })).toBe(1)
    const flagged = await prisma.importRow.findUniqueOrThrow({ where: { id: overlap.id } })
    expect(flagged.status).toBe("PENDING")
    expect(flagged.duplicateOfTransactionId).toBe(posted.id)
  })

  it("final review R8: two different batches overlapping on the same account, committed concurrently, still catch the duplicate rather than both posting", async () => {
    const w = await setup()
    // Same scenario as the sequential test above, but both commits race each other instead of running one after the
    // other: without the account lock, each would run findDuplicatesSinceStaging before either had posted, see no
    // duplicate, and both would insert their own 99.00 transaction.
    const first = await registry.makeBatch(w.user.id, w.bank.id)
    const firstRow = await readyRow(w.user.id, first.id, 1, w.food.id, { amountPaise: 9_900n, occurredOn: toDbDate(calendarDate("2026-03-28")) })
    const second = await registry.makeBatch(w.user.id, w.bank.id)
    const secondRow = await readyRow(w.user.id, second.id, 1, w.food.id, { amountPaise: 9_900n, occurredOn: toDbDate(calendarDate("2026-03-28")) })

    const results = await Promise.allSettled([commitBatch(w.user.id, first.id), commitBatch(w.user.id, second.id)])
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected")
    expect(rejected).toHaveLength(1)
    expect(rejected[0].reason).toBeInstanceOf(ImportRowsIllegalError)

    // Exactly one transaction was posted for the 99.00 row, whichever batch won the race - never two.
    expect(await prisma.transaction.count({ where: { userId: w.user.id, amountPaise: 9_900n, deletedAt: null } })).toBe(1)
    const posted = await prisma.transaction.findFirstOrThrow({ where: { userId: w.user.id, amountPaise: 9_900n, deletedAt: null } })

    const [firstBatch, secondBatch] = await Promise.all([
      prisma.importBatch.findUniqueOrThrow({ where: { id: first.id } }),
      prisma.importBatch.findUniqueOrThrow({ where: { id: second.id } }),
    ])
    expect([firstBatch.status, secondBatch.status].sort()).toEqual(["COMMITTED", "STAGED"])

    // The loser's row is sent back to review, flagged against whichever row actually posted - not stuck refusing forever.
    const loserRowId = firstBatch.status === "STAGED" ? firstRow.id : secondRow.id
    const loserRow = await prisma.importRow.findUniqueOrThrow({ where: { id: loserRowId } })
    expect(loserRow.status).toBe("PENDING")
    expect(loserRow.duplicateOfTransactionId).toBe(posted.id)
  })

  it("does not re-refuse a row the person already chose to import anyway against a staging-time duplicate", async () => {
    const w = await setup()
    // Staging flagged this row against w.tx (500 paise, bank -> food, 2026-04-01) and the person chose "Import anyway":
    // READY with the flag kept. It still matches w.tx at commit, and must commit regardless.
    const batch = await registry.makeBatch(w.user.id, w.bank.id)
    const accepted = await registry.makeImportRow(w.user.id, batch.id, 1, {
      status: "PENDING",
      direction: "OUT",
      amountPaise: 500n,
      occurredOn: toDbDate(calendarDate("2026-04-01")),
      description: "Lunch again",
      descriptionKey: "lunch again",
      counterpartNodeId: w.food.id,
      duplicateOfTransactionId: w.tx.id,
    })
    const imported = await updateRow(w.user.id, accepted.id, { decision: "IMPORT" })
    expect(imported.status).toBe("READY")

    const summary = await commitBatch(w.user.id, batch.id)
    expect(summary.imported).toBe(1)
    expect((await prisma.importRow.findUniqueOrThrow({ where: { id: accepted.id } })).status).toBe("COMMITTED")
  })

  it("an unflagged READY row that matches nothing new commits normally, and a soft-deleted or other-account transaction is no match", async () => {
    const w = await setup()
    const wallet = await registry.makeNode(w.user.id, "ASSET", "Wallet")
    await registry.makeTransaction(w.user.id, w.bank.id, w.food.id, { amountPaise: 3_300n, occurredAt: "2026-04-10", deletedAt: new Date() })
    await registry.makeTransaction(w.user.id, wallet.id, w.food.id, { amountPaise: 3_300n, occurredAt: "2026-04-10" })
    const batch = await registry.makeBatch(w.user.id, w.bank.id)
    await readyRow(w.user.id, batch.id, 1, w.food.id, { amountPaise: 3_300n })
    const summary = await commitBatch(w.user.id, batch.id)
    expect(summary.imported).toBe(1)
  })
})

describe("row decisions serialize against a commit in flight (final review I4)", () => {
  /** Holds `commitBatch` inside its open transaction, just before it inserts, until `release()` is called. */
  function holdCommitBeforeInsert() {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    let reached!: () => void
    const inside = new Promise<void>((resolve) => (reached = resolve))
    const original = transactionRepo.insertTransactions
    const spy = vi.spyOn(transactionRepo, "insertTransactions").mockImplementationOnce(async (...args) => {
      reached()
      await gate
      return original(...args)
    })
    return { inside, release, restore: () => spy.mockRestore() }
  }

  it("a row readied while a commit of its batch is mid-flight waits for the commit and is then refused, never left READY in a COMMITTED batch", async () => {
    const w = await setup()
    const batch = await registry.makeBatch(w.user.id, w.bank.id)
    await readyRow(w.user.id, batch.id, 1, w.food.id)
    const skipped = await registry.makeImportRow(w.user.id, batch.id, 2, {
      status: "SKIPPED",
      direction: "OUT",
      amountPaise: 1_234n,
      occurredOn: toDbDate(calendarDate("2026-04-12")),
      counterpartNodeId: w.food.id,
    })

    const hold = holdCommitBeforeInsert()
    const committing = commitBatch(w.user.id, batch.id)
    await hold.inside // the commit holds the batch's lock and has already read which rows are READY
    const deciding = updateRow(w.user.id, skipped.id, { decision: "IMPORT" }).then(
      (view) => ({ ok: true as const, view }),
      (error: unknown) => ({ ok: false as const, error }),
    )
    // Give the decision every chance to slip in while the commit is held.
    await new Promise((resolve) => setTimeout(resolve, 300))
    hold.release()
    const summary = await committing
    hold.restore()
    const decided = await deciding

    expect(summary.imported).toBe(1)
    expect(decided.ok).toBe(false)
    if (!decided.ok) expect(decided.error).toBeInstanceOf(NotFoundError)
    expect((await prisma.importRow.findUniqueOrThrow({ where: { id: skipped.id } })).status).toBe("SKIPPED")
    expect(await prisma.importRow.count({ where: { batchId: batch.id, status: "READY" } })).toBe(0)
  })
})
