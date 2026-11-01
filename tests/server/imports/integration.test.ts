import { randomUUID } from "node:crypto"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { calendarDate, toDbDate } from "@/domain/calendar-date"
import { prisma } from "@/server/db"
import { commitBatch } from "@/server/services/import-service"
import { archiveLedgerNode, NodeInImportError, removeLedgerNode } from "@/server/services/node-service"
import { recordTransaction } from "@/server/services/transaction-service"
import { loadTransactionPage } from "@/server/services/transaction-list"
import { createRegistry } from "../repositories/fixtures"

// The integration points Task 8 wires up: ledger deletion refuses when an import names the ledger, the transaction
// list gets a `batch` filter, and TransactionView carries `importBatchId`. Against the real database. "Today" is fixed
// at 2026-05-01 in the default user timezone (Asia/Kolkata), per the house rule that nothing here depends on the real
// date.

const { requireUserId } = vi.hoisted(() => ({ requireUserId: vi.fn() }))
vi.mock("@/server/auth", () => ({ requireUserId, UnauthenticatedError: class UnauthenticatedError extends Error {} }))
const { revalidatePath } = vi.hoisted(() => ({ revalidatePath: vi.fn() }))
vi.mock("next/cache", () => ({ revalidatePath }))

const actions = await import("@/app/nodes/actions")

const registry = createRegistry()
afterAll(async () => {
  vi.useRealTimers()
  await registry.cleanup()
})
beforeEach(() => requireUserId.mockReset())
afterEach(() => vi.restoreAllMocks())

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

const MESSAGE = "An import uses this ledger. Discard the import, or archive the ledger instead."

describe("removeLedgerNode and imports", () => {
  it("refuses to delete the account an import batch names, in any status but DISCARDED, and leaves it in place", async () => {
    const w = await setup()
    for (const status of ["UPLOADED", "STAGED", "COMMITTED", "REVERSED"] as const) {
      const account = await registry.makeNode(w.user.id, "ASSET", `Account ${status}`)
      await registry.makeBatch(w.user.id, account.id, { status, fileBytes: status === "UPLOADED" ? undefined : null })
      const error = await removeLedgerNode(w.user.id, account.id).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(NodeInImportError)
      expect((error as Error).message).toBe(MESSAGE)
      expect(await prisma.ledgerNode.count({ where: { id: account.id } })).toBe(1)
    }
  })

  it("final review I9: a DISCARDED upload no longer blocks deleting its account forever: the ledger is deleted and the discarded batch goes with it", async () => {
    const w = await setup()
    const account = await registry.makeNode(w.user.id, "ASSET", "Closed account")
    const discarded = await registry.makeBatch(w.user.id, account.id, { status: "DISCARDED", fileBytes: null })
    await removeLedgerNode(w.user.id, account.id)
    expect(await prisma.ledgerNode.count({ where: { id: account.id } })).toBe(0)
    expect(await prisma.importBatch.count({ where: { id: discarded.id } })).toBe(0)
  })

  it("a ledger with both a discarded and a live batch is still refused, and the discarded one is kept with it", async () => {
    const w = await setup()
    const account = await registry.makeNode(w.user.id, "ASSET", "Busy account")
    const discarded = await registry.makeBatch(w.user.id, account.id, { status: "DISCARDED", fileBytes: null })
    await registry.makeBatch(w.user.id, account.id, { status: "STAGED" })
    await expect(removeLedgerNode(w.user.id, account.id)).rejects.toBeInstanceOf(NodeInImportError)
    expect(await prisma.importBatch.count({ where: { id: discarded.id } })).toBe(1)
  })

  it("refuses to delete a ledger a staged row chose as its counterpart", async () => {
    const w = await setup()
    const shop = await registry.makeNode(w.user.id, "EXPENSE", "Shop")
    const batch = await registry.makeBatch(w.user.id, w.bank.id)
    await readyRow(w.user.id, batch.id, 1, shop.id)
    const error = await removeLedgerNode(w.user.id, shop.id).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(NodeInImportError)
    expect((error as Error).message).toBe(MESSAGE)
    expect(await prisma.ledgerNode.count({ where: { id: shop.id } })).toBe(1)
  })

  it("answers ok:false with the exact message through the node action, deleting nothing", async () => {
    const w = await setup()
    requireUserId.mockResolvedValue(w.user.id)
    const account = await registry.makeNode(w.user.id, "ASSET", "Statement account")
    await registry.makeBatch(w.user.id, account.id, { status: "STAGED" })
    const result = await actions.removeNodeAction({ nodeId: account.id })
    expect(result).toEqual({ ok: false, error: { code: "invalid", message: MESSAGE } })
    expect(await prisma.ledgerNode.count({ where: { id: account.id } })).toBe(1)
  })

  it("deletes an unrelated ledger normally", async () => {
    const w = await setup()
    const scratch = await registry.makeNode(w.user.id, "EXPENSE", "Scratch")
    await removeLedgerNode(w.user.id, scratch.id)
    expect(await prisma.ledgerNode.count({ where: { id: scratch.id } })).toBe(0)
  })

  it("removes profiles and learned rules naming a ledger that is deleted; archiving it (unblocked by imports) still works", async () => {
    const w = await setup()
    const shop = await registry.makeNode(w.user.id, "EXPENSE", "Shop")
    await prisma.importProfile.create({ data: { userId: w.user.id, name: "My bank", nodeId: shop.id, settings: {} } })
    await prisma.counterpartRule.create({ data: { userId: w.user.id, direction: "OUT", descriptionKey: "shop", nodeId: shop.id } })

    const archived = await archiveLedgerNode(w.user.id, shop.id)
    expect(archived.node.archivedAt).not.toBeNull()
    expect(await prisma.importProfile.count({ where: { nodeId: shop.id } })).toBe(1) // archiving keeps them

    await removeLedgerNode(w.user.id, shop.id)
    expect(await prisma.ledgerNode.count({ where: { id: shop.id } })).toBe(0)
    expect(await prisma.importProfile.count({ where: { userId: w.user.id, nodeId: shop.id } })).toBe(0)
    expect(await prisma.counterpartRule.count({ where: { userId: w.user.id, nodeId: shop.id } })).toBe(0)
  })

  it("does not let another user's import block a delete", async () => {
    const w = await setup()
    const other = await setup()
    const shared = await registry.makeNode(other.user.id, "ASSET", "Their account")
    await registry.makeBatch(other.user.id, shared.id, { status: "STAGED" })
    const mine = await registry.makeNode(w.user.id, "ASSET", "My account")
    await removeLedgerNode(w.user.id, mine.id)
    expect(await prisma.ledgerNode.count({ where: { id: mine.id } })).toBe(0)
  })
})

describe("the transaction list's batch filter", () => {
  it("lists exactly the batch's transactions, and combines with node", async () => {
    const w = await setup()
    const batch = await registry.makeBatch(w.user.id, w.bank.id)
    await readyRow(w.user.id, batch.id, 1, w.food.id, { amountPaise: 1_000n })
    await readyRow(w.user.id, batch.id, 2, w.income.id, { direction: "IN", amountPaise: 500n })
    await commitBatch(w.user.id, batch.id)

    const other = await registry.makeBatch(w.user.id, w.bank.id)
    await readyRow(w.user.id, other.id, 1, w.food.id, { amountPaise: 2_000n })
    await commitBatch(w.user.id, other.id)

    await recordTransaction(w.user.id, {
      fromNodeId: w.bank.id,
      toNodeId: w.food.id,
      amount: 50n,
      occurredAt: calendarDate("2026-04-01"),
      idempotencyKey: randomUUID(),
    })

    const ids = (page: Awaited<ReturnType<typeof loadTransactionPage>>) =>
      page.entries.flatMap((e) => (e.kind === "single" ? [e.transaction.id] : e.legs.map((l) => l.id)))

    const page = await loadTransactionPage(w.user.id, { batch: batch.id })
    const stored = await prisma.transaction.findMany({ where: { userId: w.user.id, importBatchId: batch.id } })
    expect(ids(page).sort()).toEqual(stored.map((t) => t.id).sort())
    expect(ids(page)).toHaveLength(2)

    const combined = await loadTransactionPage(w.user.id, { batch: batch.id, node: [w.income.id] })
    expect(ids(combined)).toHaveLength(1) // only the IN leg of this batch touches w.income
  })
})

describe("TransactionView.importBatchId", () => {
  it("is set for an imported transaction and null for one entered by hand", async () => {
    const w = await setup()
    const batch = await registry.makeBatch(w.user.id, w.bank.id)
    await readyRow(w.user.id, batch.id, 1, w.food.id, { amountPaise: 1_000n })
    await commitBatch(w.user.id, batch.id)

    const page = await loadTransactionPage(w.user.id, { batch: batch.id })
    expect(page.entries).toHaveLength(1)
    const [entry] = page.entries
    expect(entry.kind).toBe("single")
    expect(entry.kind === "single" && entry.transaction.importBatchId).toBe(batch.id)

    const handView = await recordTransaction(w.user.id, {
      fromNodeId: w.bank.id,
      toNodeId: w.food.id,
      amount: 50n,
      occurredAt: calendarDate("2026-04-01"),
      idempotencyKey: randomUUID(),
    })
    expect(handView.importBatchId).toBeNull()
  })
})
