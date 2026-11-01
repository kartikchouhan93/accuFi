import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { calendarDate, toDbDate } from "@/domain/calendar-date"
import { prisma } from "@/server/db"
import { NotFoundError } from "@/server/repositories/errors"
import { updateNode } from "@/server/repositories/node-repository"
import {
  applyCounterpartToSimilar,
  confirmSuggestions,
  InvalidImportError,
  loadReview,
  REVIEW_PAGE_SIZE,
  updateRow,
} from "@/server/services/import-service"
import { createRegistry } from "../repositories/fixtures"

// The review screen and row-decision operations (design §6 stage 4), against the real database. "Today" is fixed
// (the house rule: nothing here depends on the real date).

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

/** A PENDING row on `line` of the batch, OUT from the account by default; `over` overrides any field. */
const row = (
  userId: string,
  batchId: string,
  line: number,
  over: Parameters<typeof registry.makeImportRow>[3] = {},
) =>
  registry.makeImportRow(userId, batchId, line, {
    status: "PENDING",
    direction: "OUT",
    amountPaise: 10_000n,
    occurredOn: toDbDate(calendarDate("2026-04-10")),
    description: "Row",
    descriptionKey: "row",
    ...over,
  })

describe("loadReview", () => {
  it("refuses a batch that is not STAGED", async () => {
    const w = await setup()
    const batch = await registry.makeBatch(w.user.id, w.bank.id, { status: "UPLOADED", fileBytes: null })
    await expect(loadReview(w.user.id, batch.id, { filter: "all", page: 1 })).rejects.toBeInstanceOf(InvalidImportError)
  })

  it("a foreign batch id is NotFoundError", async () => {
    const w = await setup()
    const foreign = await registry.makeBatch(b.user.id, b.bank.id)
    await expect(loadReview(w.user.id, foreign.id, { filter: "all", page: 1 })).rejects.toBeInstanceOf(NotFoundError)
  })

  it("filters by status and by duplicate flag", async () => {
    const w = await setup()
    const batch = await registry.makeBatch(w.user.id, w.bank.id)
    await row(w.user.id, batch.id, 1, { status: "PENDING" })
    await row(w.user.id, batch.id, 2, { status: "READY", counterpartNodeId: w.food.id })
    await row(w.user.id, batch.id, 3, { status: "SKIPPED" })
    await row(w.user.id, batch.id, 4, { status: "ERRORED", direction: null, amountPaise: null, occurredOn: null, errorReason: "bad" })
    await row(w.user.id, batch.id, 5, { status: "PENDING", duplicateOfTransactionId: w.tx.id })

    const all = await loadReview(w.user.id, batch.id, { filter: "all", page: 1 })
    expect(all.rows).toHaveLength(5)

    const pending = await loadReview(w.user.id, batch.id, { filter: "pending", page: 1 })
    expect(pending.rows.map((r) => r.line)).toEqual([1, 5])

    const ready = await loadReview(w.user.id, batch.id, { filter: "ready", page: 1 })
    expect(ready.rows.map((r) => r.line)).toEqual([2])

    const skipped = await loadReview(w.user.id, batch.id, { filter: "skipped", page: 1 })
    expect(skipped.rows.map((r) => r.line)).toEqual([3])

    const errors = await loadReview(w.user.id, batch.id, { filter: "errors", page: 1 })
    expect(errors.rows.map((r) => r.line)).toEqual([4])

    const duplicates = await loadReview(w.user.id, batch.id, { filter: "duplicates", page: 1 })
    expect(duplicates.rows.map((r) => r.line)).toEqual([5])
  })

  it("counts every status, duplicates and linked rows regardless of the active filter", async () => {
    const w = await setup()
    const rule = await registry.makeRule(w.user.id, w.bank.id, w.food.id, { amountPaise: 1_000n })
    const occurrence = await registry.makeOccurrence(w.user.id, rule.id, "2026-04-10")
    const batch = await registry.makeBatch(w.user.id, w.bank.id)
    await row(w.user.id, batch.id, 1, { status: "PENDING" })
    await row(w.user.id, batch.id, 2, { status: "PENDING", occurrenceId: occurrence.id })
    await row(w.user.id, batch.id, 3, { status: "READY", counterpartNodeId: w.food.id })
    await row(w.user.id, batch.id, 4, { status: "SKIPPED" })
    await row(w.user.id, batch.id, 5, { status: "ERRORED", direction: null, amountPaise: null, occurredOn: null, errorReason: "bad" })
    await row(w.user.id, batch.id, 6, { status: "PENDING", duplicateOfTransactionId: w.tx.id })

    const screen = await loadReview(w.user.id, batch.id, { filter: "ready", page: 1 })
    expect(screen.counts).toEqual({ pending: 3, ready: 1, skipped: 1, errored: 1, duplicates: 1, linked: 1 })
  })

  it("pages 51 rows into 2 pages and clamps an out-of-range page", async () => {
    const w = await setup()
    const batch = await registry.makeBatch(w.user.id, w.bank.id)
    for (let i = 1; i <= 51; i++) await row(w.user.id, batch.id, i)

    const first = await loadReview(w.user.id, batch.id, { filter: "all", page: 1 })
    expect(first.pageCount).toBe(2)
    expect(first.rows).toHaveLength(REVIEW_PAGE_SIZE)
    expect(first.page).toBe(1)

    const second = await loadReview(w.user.id, batch.id, { filter: "all", page: 2 })
    expect(second.rows).toHaveLength(1)
    expect(second.page).toBe(2)

    const clamped = await loadReview(w.user.id, batch.id, { filter: "all", page: 99 })
    expect(clamped.page).toBe(2)
    expect(clamped.rows).toHaveLength(1)

    const clampedLow = await loadReview(w.user.id, batch.id, { filter: "all", page: 0 })
    expect(clampedLow.page).toBe(1)
  })

  it("canCommit is true only with no PENDING row and at least one READY row", async () => {
    const w = await setup()
    const notAllDecided = await registry.makeBatch(w.user.id, w.bank.id)
    await row(w.user.id, notAllDecided.id, 1, { status: "PENDING" })
    await row(w.user.id, notAllDecided.id, 2, { status: "READY", counterpartNodeId: w.food.id })
    expect((await loadReview(w.user.id, notAllDecided.id, { filter: "all", page: 1 })).canCommit).toBe(false)

    const ready = await registry.makeBatch(w.user.id, w.bank.id)
    await row(w.user.id, ready.id, 1, { status: "READY", counterpartNodeId: w.food.id })
    await row(w.user.id, ready.id, 2, { status: "SKIPPED" })
    expect((await loadReview(w.user.id, ready.id, { filter: "all", page: 1 })).canCommit).toBe(true)

    const noneReady = await registry.makeBatch(w.user.id, w.bank.id)
    await row(w.user.id, noneReady.id, 1, { status: "SKIPPED" })
    expect((await loadReview(w.user.id, noneReady.id, { filter: "all", page: 1 })).canCommit).toBe(false)
  })

  it("the duplicate view carries the matched transaction's date, amount, note and other ledger name", async () => {
    const w = await setup()
    const batch = await registry.makeBatch(w.user.id, w.bank.id)
    await row(w.user.id, batch.id, 1, {
      status: "PENDING",
      duplicateOfTransactionId: w.tx.id,
      amountPaise: 500n,
      occurredOn: toDbDate(calendarDate("2026-04-01")),
    })
    const screen = await loadReview(w.user.id, batch.id, { filter: "all", page: 1 })
    expect(screen.rows[0].duplicate).toEqual({
      transactionId: w.tx.id,
      occurredAt: "2026-04-01",
      amountPaise: "500",
      note: "lunch",
      otherLedgerName: "Food",
    })
  })

  it("the occurrence view carries the rule name, due day and other ledger; ledgers exclude the account, system nodes, lot holders and archived ones", async () => {
    const w = await setup()
    const rule = await registry.makeRule(w.user.id, w.bank.id, w.food.id, { amountPaise: 1_000n, name: "Rent" })
    const occurrence = await registry.makeOccurrence(w.user.id, rule.id, "2026-04-10")
    const system = await registry.makeNode(w.user.id, "ASSET", "Opening Balance", { systemRole: "OPENING_BALANCE" })
    const investment = await registry.makeNode(w.user.id, "INVESTMENT", "Gold", { valuationMode: "LUMP" })
    const archived = await registry.makeNode(w.user.id, "EXPENSE", "Old Expense")
    await updateNode(w.user.id, archived.id, { archivedAt: new Date() })

    const batch = await registry.makeBatch(w.user.id, w.bank.id)
    await row(w.user.id, batch.id, 1, { status: "PENDING", occurrenceId: occurrence.id })
    const screen = await loadReview(w.user.id, batch.id, { filter: "all", page: 1 })
    expect(screen.rows[0].occurrence).toEqual({ id: occurrence.id, ruleName: "Rent", dueOn: "2026-04-10", otherNodeId: w.food.id })

    const ledgerIds = screen.ledgers.map((l) => l.id)
    expect(ledgerIds).toContain(w.food.id)
    expect(ledgerIds).not.toContain(w.bank.id) // the account itself
    expect(ledgerIds).not.toContain(system.id)
    expect(ledgerIds).not.toContain(investment.id)
    expect(ledgerIds).not.toContain(archived.id)
  })

  it("JSON.stringify of the screen never throws on a bigint", async () => {
    const w = await setup()
    const batch = await registry.makeBatch(w.user.id, w.bank.id)
    await row(w.user.id, batch.id, 1, { status: "PENDING", duplicateOfTransactionId: w.tx.id, counterpartNodeId: w.food.id })
    const screen = await loadReview(w.user.id, batch.id, { filter: "all", page: 1 })
    expect(() => JSON.stringify(screen)).not.toThrow()
  })
})

describe("updateRow", () => {
  it("choosing a legal counterpart keeps the row PENDING; IMPORT then readies it; SKIP and UNDO follow", async () => {
    const w = await setup()
    const batch = await registry.makeBatch(w.user.id, w.bank.id)
    const created = await row(w.user.id, batch.id, 1)

    const chosen = await updateRow(w.user.id, created.id, { counterpartNodeId: w.food.id })
    expect(chosen.status).toBe("PENDING")
    expect(chosen.counterpartNodeId).toBe(w.food.id)

    const imported = await updateRow(w.user.id, created.id, { decision: "IMPORT" })
    expect(imported.status).toBe("READY")
    expect(imported.counterpartNodeId).toBe(w.food.id)

    const skipped = await updateRow(w.user.id, created.id, { decision: "SKIP" })
    expect(skipped.status).toBe("SKIPPED")

    const undone = await updateRow(w.user.id, created.id, { decision: "UNDO" })
    expect(undone.status).toBe("PENDING")
  })

  it("IMPORT without a counterpart (and no linked occurrence) is refused", async () => {
    const w = await setup()
    const batch = await registry.makeBatch(w.user.id, w.bank.id)
    const created = await row(w.user.id, batch.id, 1)
    await expect(updateRow(w.user.id, created.id, { decision: "IMPORT" })).rejects.toMatchObject({
      name: "InvalidImportError",
      violations: [{ field: "counterpartNodeId" }],
    })
  })

  it("a duplicate-flagged row needs the explicit IMPORT decision to become READY", async () => {
    const w = await setup()
    const batch = await registry.makeBatch(w.user.id, w.bank.id)
    const created = await row(w.user.id, batch.id, 1, { counterpartNodeId: w.food.id, duplicateOfTransactionId: w.tx.id })
    const imported = await updateRow(w.user.id, created.id, { decision: "IMPORT" })
    expect(imported.status).toBe("READY")
  })

  it("refuses an illegal counterpart: an INCOME_SOURCE for an OUT row, a system ledger, an archived ledger, a lot holder and the account itself", async () => {
    const w = await setup()
    const batch = await registry.makeBatch(w.user.id, w.bank.id)
    const created = await row(w.user.id, batch.id, 1)
    const refused = (nodeId: string) =>
      expect(updateRow(w.user.id, created.id, { counterpartNodeId: nodeId })).rejects.toMatchObject({
        name: "InvalidImportError",
        violations: [{ field: "counterpartNodeId" }],
      })

    await refused(w.income.id) // INCOME_SOURCE is not a legal counterpart of an OUT row

    const system = await registry.makeNode(w.user.id, "EXPENSE", "System Expense", { systemRole: "OPENING_BALANCE_CONTRA" })
    await refused(system.id)

    const archived = await registry.makeNode(w.user.id, "EXPENSE", "Old Expense")
    await updateNode(w.user.id, archived.id, { archivedAt: new Date() })
    await refused(archived.id)

    const investment = await registry.makeNode(w.user.id, "INVESTMENT", "Gold", { valuationMode: "LUMP" })
    await refused(investment.id)

    await refused(w.bank.id) // the account itself
  })

  it("links the row's occurrence, taking its other ledger as the counterpart, and unlinking clears the link", async () => {
    const w = await setup()
    const rule = await registry.makeRule(w.user.id, w.bank.id, w.food.id, { amountPaise: 1_000n, name: "Rent" })
    const occurrence = await registry.makeOccurrence(w.user.id, rule.id, "2026-04-10")
    const batch = await registry.makeBatch(w.user.id, w.bank.id)
    const created = await row(w.user.id, batch.id, 1, { occurrenceId: occurrence.id })

    const linked = await updateRow(w.user.id, created.id, { occurrence: "LINK" })
    expect(linked.counterpartNodeId).toBe(w.food.id)
    expect(linked.status).toBe("PENDING")
    expect(linked.occurrence).toMatchObject({ id: occurrence.id })

    const unlinked = await updateRow(w.user.id, created.id, { occurrence: "UNLINK" })
    expect(unlinked.occurrence).toBeNull()
    expect(unlinked.counterpartNodeId).toBe(w.food.id) // UNLINK only clears the occurrence link
  })

  it("IMPORT alone derives the counterpart from a linked occurrence when the row has none stored yet", async () => {
    const w = await setup()
    const rule = await registry.makeRule(w.user.id, w.bank.id, w.food.id, { amountPaise: 1_000n, name: "Rent" })
    const occurrence = await registry.makeOccurrence(w.user.id, rule.id, "2026-04-10")
    const batch = await registry.makeBatch(w.user.id, w.bank.id)
    const created = await row(w.user.id, batch.id, 1, { occurrenceId: occurrence.id })

    const imported = await updateRow(w.user.id, created.id, { decision: "IMPORT" })
    expect(imported.status).toBe("READY")
    expect(imported.counterpartNodeId).toBe(w.food.id)
  })

  it("UNLINK combined with IMPORT in the same call does not derive a counterpart from the occurrence being removed", async () => {
    const w = await setup()
    const rule = await registry.makeRule(w.user.id, w.bank.id, w.food.id, { amountPaise: 1_000n, name: "Rent" })
    const occurrence = await registry.makeOccurrence(w.user.id, rule.id, "2026-04-10")
    const batch = await registry.makeBatch(w.user.id, w.bank.id)
    // Linked occurrence, but no stored counterpart yet: once unlinked there is nothing left to import with.
    const created = await row(w.user.id, batch.id, 1, { occurrenceId: occurrence.id })

    await expect(updateRow(w.user.id, created.id, { occurrence: "UNLINK", decision: "IMPORT" })).rejects.toMatchObject({
      name: "InvalidImportError",
      violations: [{ field: "counterpartNodeId" }],
    })

    // Refused atomically: nothing was written, so the occurrence link and PENDING status survive the rejected call.
    const unchanged = await updateRow(w.user.id, created.id, {})
    expect(unchanged.status).toBe("PENDING")
    expect(unchanged.counterpartNodeId).toBeNull()
    expect(unchanged.occurrence).toMatchObject({ id: occurrence.id })
  })

  it("occurrence LINK refuses a row with no linked occurrence", async () => {
    const w = await setup()
    const batch = await registry.makeBatch(w.user.id, w.bank.id)
    const created = await row(w.user.id, batch.id, 1)
    await expect(updateRow(w.user.id, created.id, { occurrence: "LINK" })).rejects.toBeInstanceOf(InvalidImportError)
  })

  it("review focus 3: a ledger archived after staging makes updateRow with it as counterpart refused, and it leaves the ledgers list", async () => {
    const w = await setup()
    const shop = await registry.makeNode(w.user.id, "EXPENSE", "Shop")
    const batch = await registry.makeBatch(w.user.id, w.bank.id)
    const created = await row(w.user.id, batch.id, 1)

    const before = await loadReview(w.user.id, batch.id, { filter: "all", page: 1 })
    expect(before.ledgers.map((l) => l.id)).toContain(shop.id)

    await updateNode(w.user.id, shop.id, { archivedAt: new Date() })

    await expect(updateRow(w.user.id, created.id, { counterpartNodeId: shop.id })).rejects.toMatchObject({
      name: "InvalidImportError",
      violations: [{ field: "counterpartNodeId" }],
    })
    const after = await loadReview(w.user.id, batch.id, { filter: "all", page: 1 })
    expect(after.ledgers.map((l) => l.id)).not.toContain(shop.id)
  })

  it("refuses an ERRORED row, a committed batch and a foreign row (not found for the foreign row)", async () => {
    const w = await setup()
    const batch = await registry.makeBatch(w.user.id, w.bank.id)
    const errored = await row(w.user.id, batch.id, 1, {
      status: "ERRORED",
      direction: null,
      amountPaise: null,
      occurredOn: null,
      errorReason: "bad date",
    })
    await expect(updateRow(w.user.id, errored.id, { decision: "SKIP" })).rejects.toBeInstanceOf(NotFoundError)

    const committedBatch = await registry.makeBatch(w.user.id, w.bank.id, { status: "COMMITTED" })
    const onCommittedBatch = await row(w.user.id, committedBatch.id, 1)
    await expect(updateRow(w.user.id, onCommittedBatch.id, { decision: "SKIP" })).rejects.toBeInstanceOf(NotFoundError)

    const foreign = await row(b.user.id, (await registry.makeBatch(b.user.id, b.bank.id)).id, 1)
    await expect(updateRow(w.user.id, foreign.id, { decision: "SKIP" })).rejects.toBeInstanceOf(NotFoundError)
  })

  it("two concurrent updateRow calls on one row do not corrupt it", async () => {
    const w = await setup()
    const batch = await registry.makeBatch(w.user.id, w.bank.id)
    const created = await row(w.user.id, batch.id, 1)

    const results = await Promise.allSettled([
      updateRow(w.user.id, created.id, { decision: "SKIP" }),
      updateRow(w.user.id, created.id, { decision: "UNDO" }),
    ])
    for (const result of results) {
      if (result.status === "rejected") expect(result.reason).toBeInstanceOf(NotFoundError)
    }
    expect(results.some((r) => r.status === "fulfilled")).toBe(true)

    const stored = await prisma.importRow.findUniqueOrThrow({ where: { id: created.id } })
    expect(["PENDING", "SKIPPED"]).toContain(stored.status)
  })
})

describe("applyCounterpartToSimilar", () => {
  it("changes exactly the matching PENDING rows with the same direction and description key, and skips an illegal one", async () => {
    const w = await setup()
    const batch = await registry.makeBatch(w.user.id, w.bank.id)
    const source = await row(w.user.id, batch.id, 1, { descriptionKey: "coffee shop", counterpartNodeId: w.food.id })
    const similar = await row(w.user.id, batch.id, 2, { descriptionKey: "coffee shop" })
    const otherKey = await row(w.user.id, batch.id, 3, { descriptionKey: "rent", counterpartNodeId: null })
    const notPending = await row(w.user.id, batch.id, 4, { descriptionKey: "coffee shop", status: "READY", counterpartNodeId: w.food.id })

    const changed = await applyCounterpartToSimilar(w.user.id, source.id)
    expect(changed).toBe(2) // the source row itself and `similar`

    const storedSimilar = await prisma.importRow.findUniqueOrThrow({ where: { id: similar.id } })
    expect(storedSimilar.counterpartNodeId).toBe(w.food.id)
    const storedOther = await prisma.importRow.findUniqueOrThrow({ where: { id: otherKey.id } })
    expect(storedOther.counterpartNodeId).toBeNull()
    const storedNotPending = await prisma.importRow.findUniqueOrThrow({ where: { id: notPending.id } })
    expect(storedNotPending.counterpartNodeId).toBe(w.food.id) // unchanged, already had it

    const archived = await registry.makeNode(w.user.id, "EXPENSE", "Old Expense")
    await updateNode(w.user.id, archived.id, { archivedAt: new Date() })
    const illegalSource = await row(w.user.id, batch.id, 5, { descriptionKey: "illegal", counterpartNodeId: archived.id })
    const illegalChanged = await applyCounterpartToSimilar(w.user.id, illegalSource.id)
    expect(illegalChanged).toBe(0)
  })

  it("a foreign row is NotFoundError", async () => {
    const w = await setup()
    const foreignBatch = await registry.makeBatch(b.user.id, b.bank.id)
    const foreign = await row(b.user.id, foreignBatch.id, 1)
    await expect(applyCounterpartToSimilar(w.user.id, foreign.id)).rejects.toBeInstanceOf(NotFoundError)
  })
})

describe("confirmSuggestions", () => {
  it("readies only PENDING rows that already have a counterpart and no duplicate flag", async () => {
    const w = await setup()
    const batch = await registry.makeBatch(w.user.id, w.bank.id)
    const prefilled = await row(w.user.id, batch.id, 1, { counterpartNodeId: w.food.id })
    const duplicateFlagged = await row(w.user.id, batch.id, 2, { counterpartNodeId: w.food.id, duplicateOfTransactionId: w.tx.id })
    const noCounterpart = await row(w.user.id, batch.id, 3)
    const alreadyReady = await row(w.user.id, batch.id, 4, { status: "READY", counterpartNodeId: w.food.id })

    const count = await confirmSuggestions(w.user.id, batch.id)
    expect(count).toBe(1)

    expect((await prisma.importRow.findUniqueOrThrow({ where: { id: prefilled.id } })).status).toBe("READY")
    expect((await prisma.importRow.findUniqueOrThrow({ where: { id: duplicateFlagged.id } })).status).toBe("PENDING")
    expect((await prisma.importRow.findUniqueOrThrow({ where: { id: noCounterpart.id } })).status).toBe("PENDING")
    expect((await prisma.importRow.findUniqueOrThrow({ where: { id: alreadyReady.id } })).status).toBe("READY")
  })

  it("a foreign batch id is NotFoundError", async () => {
    const w = await setup()
    const foreign = await registry.makeBatch(b.user.id, b.bank.id)
    await expect(confirmSuggestions(w.user.id, foreign.id)).rejects.toBeInstanceOf(NotFoundError)
  })
})
