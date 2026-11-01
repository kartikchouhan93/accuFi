import { afterAll, describe, expect, it } from "vitest"
import { calendarDate, toDbDate } from "@/domain/calendar-date"
import { NotFoundError } from "@/server/repositories/errors"
import { commitBatch, discardBatch, loadBatchList, loadBatchPage, loadNewImport, reverseBatch } from "@/server/services/import-service"
import { createRegistry } from "../repositories/fixtures"

// The list/new-import/batch-page loaders (Task 9), against the real database: reads only, nothing here writes or
// takes the batch's row lock.

const registry = createRegistry()
afterAll(registry.cleanup)

async function setup() {
  return registry.makeWorld()
}

const readyRow = (userId: string, batchId: string, line: number, counterpartNodeId: string) =>
  registry.makeImportRow(userId, batchId, line, {
    status: "READY",
    direction: "OUT",
    amountPaise: 10_000n,
    occurredOn: toDbDate(calendarDate("2026-04-10")),
    description: "Row",
    descriptionKey: "row",
    counterpartNodeId,
  })

describe("loadBatchList", () => {
  it("lists only the user's own batches, newest first, with the account's name", async () => {
    const w = await setup()
    const older = await registry.makeBatch(w.user.id, w.bank.id, { fileName: "jan.csv" })
    await new Promise((resolve) => setTimeout(resolve, 15))
    const newer = await registry.makeBatch(w.user.id, w.bank.id, { fileName: "feb.csv" })
    const stranger = await registry.makeUser()
    const theirs = await registry.makeNode(stranger.id, "ASSET", "Theirs")
    await registry.makeBatch(stranger.id, theirs.id)

    const list = await loadBatchList(w.user.id)
    expect(list.map((b) => b.id)).toEqual([newer.id, older.id])
    expect(list.every((b) => b.accountName === "Bank")).toBe(true)
  })
})

describe("loadNewImport", () => {
  it("lists only live asset and liability accounts, and the user's saved profiles", async () => {
    const w = await setup()
    const archivedBank = await registry.makeNode(w.user.id, "ASSET", "Old bank", { archivedAt: new Date() })
    const card = await registry.makeNode(w.user.id, "LIABILITY", "Card")
    await registry.makeNode(w.user.id, "INVESTMENT", "Gold")
    await registry.makeNode(w.user.id, "EXPENSE", "Food")

    const form = await loadNewImport(w.user.id)
    const names = form.accounts.map((a) => a.name).sort()
    expect(names).toEqual(["Bank", "Card"])
    expect(names).not.toContain(archivedBank.name)
    expect(form.accounts.find((a) => a.id === card.id)?.kind).toBe("LIABILITY")
    expect(form.profiles).toEqual([])
  })
})

describe("loadBatchPage", () => {
  it("answers no summary for a batch not yet committed", async () => {
    const w = await setup()
    const batch = await registry.makeBatch(w.user.id, w.bank.id, { status: "UPLOADED" })
    const page = await loadBatchPage(w.user.id, batch.id)
    expect(page.batch.id).toBe(batch.id)
    expect(page.summary).toBeNull()
  })

  it("answers the commit summary for a committed batch, and keeps it after a reversal", async () => {
    const w = await setup()
    const batch = await registry.makeBatch(w.user.id, w.bank.id, { status: "STAGED" })
    await readyRow(w.user.id, batch.id, 1, w.food.id)
    await commitBatch(w.user.id, batch.id)

    const committedPage = await loadBatchPage(w.user.id, batch.id)
    expect(committedPage.batch.status).toBe("COMMITTED")
    expect(committedPage.summary).toMatchObject({ imported: 1, totalOutPaise: "10000" })

    await reverseBatch(w.user.id, batch.id)
    const reversedPage = await loadBatchPage(w.user.id, batch.id)
    expect(reversedPage.batch.status).toBe("REVERSED")
    expect(reversedPage.summary).toMatchObject({ imported: 1, totalOutPaise: "10000" })
  })

  it("treats a discarded batch as gone, the same as a foreign one", async () => {
    const w = await setup()
    const batch = await registry.makeBatch(w.user.id, w.bank.id, { status: "UPLOADED" })
    await discardBatch(w.user.id, batch.id)
    await expect(loadBatchPage(w.user.id, batch.id)).rejects.toBeInstanceOf(NotFoundError)

    const stranger = await registry.makeUser()
    const theirs = await registry.makeNode(stranger.id, "ASSET", "Theirs")
    const theirBatch = await registry.makeBatch(stranger.id, theirs.id)
    await expect(loadBatchPage(w.user.id, theirBatch.id)).rejects.toBeInstanceOf(NotFoundError)
  })
})
