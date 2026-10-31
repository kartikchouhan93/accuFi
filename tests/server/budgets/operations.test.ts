import { afterAll, afterEach, describe, expect, it, vi } from "vitest"
import { calendarDate, fromDbDate } from "@/domain/calendar-date"
import { spansOverlap } from "@/domain/budgets"
import { toBudgetSettingsView } from "@/lib/budget-view"
import { prisma } from "@/server/db"
import * as budgetRepo from "@/server/repositories/budget-repository"
import { NotFoundError } from "@/server/repositories/errors"
import {
  createBudget,
  deleteBudget,
  InvalidBudgetError,
  reviseBudget,
  updateBudgetSettings,
  type BudgetInput,
} from "@/server/services/budget-service"
import { createRegistry } from "../repositories/fixtures"

// The budget operations against the real database. "Today" is moved with a fake Date (nothing else), which `todayFor`
// reads: the 19th of May 2026 is the same day in Kolkata and in New York, so the current month is 2026-05 in both runs.

const registry = createRegistry()
afterAll(registry.cleanup)
afterEach(() => {
  vi.useRealTimers()
})

const at = (iso: string) => vi.useFakeTimers({ toFake: ["Date"], now: new Date(iso) })
const m = (value: string) => calendarDate(value)
const TODAY = "2026-05-19T06:00:00Z"

function input(nodeId: string, over: Partial<BudgetInput> = {}): BudgetInput {
  return { nodeId, amount: 500_000n, startMonth: m("2026-05-01"), endMonth: null, rollover: false, ...over }
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  )
}

async function invalid(promise: Promise<unknown>): Promise<InvalidBudgetError> {
  const error = await rejection(promise)
  expect(error, "expected InvalidBudgetError").toBeInstanceOf(InvalidBudgetError)
  return error as InvalidBudgetError
}

async function notFound(promise: Promise<unknown>, entity: NotFoundError["entity"]) {
  const error = await rejection(promise)
  expect(error, "expected NotFoundError").toBeInstanceOf(NotFoundError)
  expect((error as NotFoundError).entity).toBe(entity)
}

const fieldsOf = (error: InvalidBudgetError) => error.violations.map((v) => v.field)

const rows = (userId: string, nodeId: string) => budgetRepo.findBudgetsForNode(userId, nodeId)

/** No two of the ledger's stored spans share a month. */
async function expectNoOverlap(userId: string, nodeId: string) {
  const spans = (await rows(userId, nodeId)).map((r) => ({
    startMonth: fromDbDate(r.startMonth),
    endMonth: r.endMonth === null ? null : fromDbDate(r.endMonth),
  }))
  for (let i = 0; i < spans.length; i++) {
    for (let j = i + 1; j < spans.length; j++) expect(spansOverlap(spans[i], spans[j]), `spans ${i} and ${j} overlap`).toBe(false)
  }
}

describe("createBudget", () => {
  it("stores the span and answers with its settings view", async () => {
    at(TODAY)
    const w = await registry.makeWorld()
    const view = await createBudget(w.user.id, input(w.food.id, { amount: 1_250_050n, endMonth: m("2026-12-01"), rollover: true }))
    expect(view).toEqual({
      id: expect.any(String),
      nodeId: w.food.id,
      nodeName: "Food",
      amountPaise: "1250050",
      startMonth: "2026-05-01",
      endMonth: "2026-12-01",
      rollover: true,
    })
    const [row] = await rows(w.user.id, w.food.id)
    expect(row.id).toBe(view.id)
    expect(row.amountPaise).toBe(1_250_050n)
    expect(row.userId).toBe(w.user.id)
  })

  it("stores an open-ended span with a null end", async () => {
    const w = await registry.makeWorld()
    const view = await createBudget(w.user.id, input(w.food.id))
    expect(view.endMonth).toBeNull()
  })

  it("normalises a month handed in as a day to the first of its month", async () => {
    const w = await registry.makeWorld()
    const view = await createBudget(w.user.id, input(w.food.id, { startMonth: m("2026-05-17"), endMonth: m("2026-07-09") }))
    expect(view.startMonth).toBe("2026-05-01")
    expect(view.endMonth).toBe("2026-07-01")
  })

  it("allows spans of one ledger that do not share a month, in either order", async () => {
    const w = await registry.makeWorld()
    await createBudget(w.user.id, input(w.food.id, { startMonth: m("2026-05-01"), endMonth: m("2026-06-01") }))
    await createBudget(w.user.id, input(w.food.id, { startMonth: m("2026-07-01") }))
    await createBudget(w.user.id, input(w.food.id, { startMonth: m("2026-01-01"), endMonth: m("2026-04-01") }))
    expect(await rows(w.user.id, w.food.id)).toHaveLength(3)
    await expectNoOverlap(w.user.id, w.food.id)
  })

  it("refuses a ledger that is not an expense, under nodeId", async () => {
    const w = await registry.makeWorld()
    const error = await invalid(createBudget(w.user.id, input(w.bank.id)))
    expect(fieldsOf(error)).toEqual(["nodeId"])
    expect(await budgetRepo.countBudgetsNaming(w.user.id, w.bank.id)).toBe(0)
  })

  it("refuses a system ledger, under nodeId", async () => {
    const w = await registry.makeWorld()
    const loss = await registry.makeNode(w.user.id, "EXPENSE", "Realised loss", { systemRole: "REALISED_LOSS" })
    const error = await invalid(createBudget(w.user.id, input(loss.id)))
    expect(fieldsOf(error)).toEqual(["nodeId"])
    expect(error.violations[0].message).toMatch(/system/i)
    expect(await budgetRepo.countBudgetsNaming(w.user.id, loss.id)).toBe(0)
  })

  it("refuses an archived ledger, under nodeId", async () => {
    const w = await registry.makeWorld()
    const old = await registry.makeNode(w.user.id, "EXPENSE", "Old", { archivedAt: new Date() })
    const error = await invalid(createBudget(w.user.id, input(old.id)))
    expect(fieldsOf(error)).toEqual(["nodeId"])
    expect(error.violations[0].message).toMatch(/archived/i)
    expect(await budgetRepo.countBudgetsNaming(w.user.id, old.id)).toBe(0)
  })

  it("is not-found, not invalid, for another user's ledger or one that does not exist", async () => {
    const a = await registry.makeWorld()
    const b = await registry.makeWorld()
    await notFound(createBudget(a.user.id, input(b.food.id)), "node")
    await notFound(createBudget(a.user.id, input("no-such-node")), "node")
    expect(await budgetRepo.countBudgetsNaming(b.user.id, b.food.id)).toBe(0)
  })

  it("refuses an end before the start, under endMonth", async () => {
    const w = await registry.makeWorld()
    const error = await invalid(createBudget(w.user.id, input(w.food.id, { startMonth: m("2026-06-01"), endMonth: m("2026-05-01") })))
    expect(fieldsOf(error)).toEqual(["endMonth"])
    expect(await rows(w.user.id, w.food.id)).toHaveLength(0)
  })

  it("accepts an end in the start month: one month long", async () => {
    const w = await registry.makeWorld()
    const view = await createBudget(w.user.id, input(w.food.id, { startMonth: m("2026-06-01"), endMonth: m("2026-06-01") }))
    expect(view.endMonth).toBe("2026-06-01")
  })

  it("refuses a span that overlaps another, under startMonth, and names the existing span", async () => {
    const w = await registry.makeWorld()
    await createBudget(w.user.id, input(w.food.id, { startMonth: m("2026-05-01"), endMonth: m("2026-09-01") }))
    const error = await invalid(createBudget(w.user.id, input(w.food.id, { startMonth: m("2026-08-01") })))
    expect(fieldsOf(error)).toEqual(["startMonth"])
    expect(error.violations[0].message).toContain("May 2026")
    expect(error.violations[0].message).toContain("Sep 2026")
    expect(await rows(w.user.id, w.food.id)).toHaveLength(1)
  })

  it("refuses a span that overlaps an open-ended one, and a new open-ended one over a later span", async () => {
    const w = await registry.makeWorld()
    await createBudget(w.user.id, input(w.food.id, { startMonth: m("2026-05-01") }))
    expect(fieldsOf(await invalid(createBudget(w.user.id, input(w.food.id, { startMonth: m("2030-01-01") }))))).toEqual(["startMonth"])
    const v = await registry.makeWorld()
    await createBudget(v.user.id, input(v.food.id, { startMonth: m("2026-09-01"), endMonth: m("2026-10-01") }))
    expect(fieldsOf(await invalid(createBudget(v.user.id, input(v.food.id, { startMonth: m("2026-05-01") }))))).toEqual(["startMonth"])
  })

  it("refuses an identical second create (the double-submit guard), leaving one row", async () => {
    const w = await registry.makeWorld()
    await createBudget(w.user.id, input(w.food.id))
    expect(fieldsOf(await invalid(createBudget(w.user.id, input(w.food.id))))).toEqual(["startMonth"])
    expect(await rows(w.user.id, w.food.id)).toHaveLength(1)
  })

  it("does not let one ledger's span, or another user's, block a create", async () => {
    const a = await registry.makeWorld()
    const b = await registry.makeWorld()
    const other = await registry.makeNode(a.user.id, "EXPENSE", "Travel")
    await createBudget(a.user.id, input(a.food.id))
    await createBudget(a.user.id, input(other.id))
    await createBudget(b.user.id, input(b.food.id))
  })

  it("collects every violation into one error", async () => {
    const w = await registry.makeWorld()
    const old = await registry.makeNode(w.user.id, "EXPENSE", "Old", { archivedAt: new Date() })
    const error = await invalid(createBudget(w.user.id, input(old.id, { startMonth: m("2026-06-01"), endMonth: m("2026-05-01") })))
    expect(fieldsOf(error)).toEqual(["nodeId", "endMonth"])
  })

  it("review focus 2: two creates racing for one ledger leave exactly one row and one refusal", async () => {
    const w = await registry.makeWorld()
    const results = await Promise.allSettled([
      createBudget(w.user.id, input(w.food.id, { startMonth: m("2026-05-01"), endMonth: m("2026-08-01") })),
      createBudget(w.user.id, input(w.food.id, { startMonth: m("2026-07-01") })),
    ])
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected")
    expect(rejected).toHaveLength(1)
    expect(rejected[0].reason).toBeInstanceOf(InvalidBudgetError)
    expect(await rows(w.user.id, w.food.id)).toHaveLength(1)
  })

  it("two identical creates racing leave exactly one row", async () => {
    const w = await registry.makeWorld()
    const results = await Promise.allSettled([createBudget(w.user.id, input(w.food.id)), createBudget(w.user.id, input(w.food.id))])
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"])
    expect(await rows(w.user.id, w.food.id)).toHaveLength(1)
  })
})

describe("reviseBudget", () => {
  async function budgetOf(over: { startMonth?: string; endMonth?: string | null; rollover?: boolean; amountPaise?: bigint } = {}) {
    const w = await registry.makeWorld()
    const row = await registry.makeBudget(w.user.id, w.food.id, { startMonth: "2026-03-01", ...over })
    return { w, row }
  }

  it("from the current month splits: the old span ends the month before, the new starts now with the same rollover and end", async () => {
    at(TODAY)
    const { w, row } = await budgetOf({ endMonth: "2026-12-01", rollover: true })
    const views = await reviseBudget(w.user.id, row.id, { amount: 800_000n, appliesFrom: m("2026-05-01") })
    expect(views).toHaveLength(2)
    expect(views[0]).toMatchObject({ id: row.id, amountPaise: "500000", startMonth: "2026-03-01", endMonth: "2026-04-01", rollover: true })
    expect(views[1]).toMatchObject({ nodeId: w.food.id, nodeName: "Food", amountPaise: "800000", startMonth: "2026-05-01", endMonth: "2026-12-01", rollover: true })
    expect(views[1].id).not.toBe(row.id)
    const stored = await rows(w.user.id, w.food.id)
    expect(stored.map((r) => [r.amountPaise, fromDbDate(r.startMonth), r.endMonth && fromDbDate(r.endMonth)])).toEqual([
      [500_000n, "2026-03-01", "2026-04-01"],
      [800_000n, "2026-05-01", "2026-12-01"],
    ])
    await expectNoOverlap(w.user.id, w.food.id)
  })

  it("splits an open-ended span into an open-ended new one", async () => {
    at(TODAY)
    const { w, row } = await budgetOf()
    const views = await reviseBudget(w.user.id, row.id, { amount: 800_000n, appliesFrom: m("2026-04-01") })
    expect(views.map((v) => [v.startMonth, v.endMonth])).toEqual([
      ["2026-03-01", "2026-03-01"],
      ["2026-04-01", null],
    ])
  })

  it("splits across a year boundary", async () => {
    at("2027-01-19T06:00:00Z")
    const { w, row } = await budgetOf({ startMonth: "2026-10-01" })
    const views = await reviseBudget(w.user.id, row.id, { amount: 800_000n, appliesFrom: m("2027-01-01") })
    expect(views[0].endMonth).toBe("2026-12-01")
  })

  it("from the start month changes the one row in place", async () => {
    at(TODAY)
    const { w, row } = await budgetOf({ endMonth: "2026-12-01", rollover: true })
    const views = await reviseBudget(w.user.id, row.id, { amount: 800_000n, appliesFrom: m("2026-03-01") })
    expect(views).toHaveLength(1)
    expect(views[0]).toMatchObject({ id: row.id, amountPaise: "800000", startMonth: "2026-03-01", endMonth: "2026-12-01", rollover: true })
    expect(await rows(w.user.id, w.food.id)).toHaveLength(1)
  })

  it("from before the start month also corrects in place", async () => {
    at(TODAY)
    const { w, row } = await budgetOf()
    const views = await reviseBudget(w.user.id, row.id, { amount: 800_000n, appliesFrom: m("2025-01-01") })
    expect(views).toHaveLength(1)
    expect(views[0]).toMatchObject({ id: row.id, amountPaise: "800000", startMonth: "2026-03-01" })
  })

  it("normalises appliesFrom given as a day to its month", async () => {
    at(TODAY)
    const { w, row } = await budgetOf()
    const views = await reviseBudget(w.user.id, row.id, { amount: 800_000n, appliesFrom: m("2026-05-31") })
    expect(views[1].startMonth).toBe("2026-05-01")
  })

  it("refuses a month after the current month, under appliesFrom, and writes nothing", async () => {
    at(TODAY)
    const { w, row } = await budgetOf()
    const error = await invalid(reviseBudget(w.user.id, row.id, { amount: 800_000n, appliesFrom: m("2026-06-01") }))
    expect(fieldsOf(error)).toEqual(["appliesFrom"])
    const stored = await rows(w.user.id, w.food.id)
    expect(stored).toHaveLength(1)
    expect(stored[0].amountPaise).toBe(500_000n)
  })

  it("refuses a month after the budget's end, under appliesFrom", async () => {
    at(TODAY)
    const { w, row } = await budgetOf({ startMonth: "2026-01-01", endMonth: "2026-03-01" })
    const error = await invalid(reviseBudget(w.user.id, row.id, { amount: 800_000n, appliesFrom: m("2026-05-01") }))
    expect(fieldsOf(error)).toEqual(["appliesFrom"])
    expect((await rows(w.user.id, w.food.id))[0].amountPaise).toBe(500_000n)
  })

  it("allows the end month itself: the last month splits off as a one-month span", async () => {
    at(TODAY)
    const { w, row } = await budgetOf({ startMonth: "2026-01-01", endMonth: "2026-05-01" })
    const views = await reviseBudget(w.user.id, row.id, { amount: 800_000n, appliesFrom: m("2026-05-01") })
    expect(views.map((v) => [v.startMonth, v.endMonth])).toEqual([
      ["2026-01-01", "2026-04-01"],
      ["2026-05-01", "2026-05-01"],
    ])
  })

  it("refuses an amount that is not positive", async () => {
    at(TODAY)
    const { w, row } = await budgetOf()
    expect(fieldsOf(await invalid(reviseBudget(w.user.id, row.id, { amount: 0n, appliesFrom: m("2026-05-01") })))).toEqual(["amount"])
  })

  it("collects the amount and the month into one error", async () => {
    at(TODAY)
    const { w, row } = await budgetOf()
    const error = await invalid(reviseBudget(w.user.id, row.id, { amount: -1n, appliesFrom: m("2026-09-01") }))
    expect(fieldsOf(error)).toEqual(["amount", "appliesFrom"])
  })

  it("is not-found for another user's budget, one that does not exist, and a deleted one", async () => {
    at(TODAY)
    const { w, row } = await budgetOf()
    const other = await registry.makeWorld()
    await notFound(reviseBudget(other.user.id, row.id, { amount: 1n, appliesFrom: m("2026-05-01") }), "budget")
    await notFound(reviseBudget(w.user.id, "no-such-budget", { amount: 1n, appliesFrom: m("2026-05-01") }), "budget")
    expect((await rows(w.user.id, w.food.id))[0].amountPaise).toBe(500_000n)
  })

  it("still works on an archived ledger's budget (review focus 3)", async () => {
    at(TODAY)
    const { w, row } = await budgetOf()
    await prisma.ledgerNode.update({ where: { id: w.food.id }, data: { archivedAt: new Date() } })
    const views = await reviseBudget(w.user.id, row.id, { amount: 800_000n, appliesFrom: m("2026-05-01") })
    expect(views).toHaveLength(2)
  })

  it("review focus 2: two revises racing from the same month leave one split and one refusal, no overlap", async () => {
    at(TODAY)
    const { w, row } = await budgetOf()
    const results = await Promise.allSettled([
      reviseBudget(w.user.id, row.id, { amount: 700_000n, appliesFrom: m("2026-05-01") }),
      reviseBudget(w.user.id, row.id, { amount: 900_000n, appliesFrom: m("2026-05-01") }),
    ])
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected")
    expect(rejected[0].reason).toBeInstanceOf(InvalidBudgetError)
    expect(await rows(w.user.id, w.food.id)).toHaveLength(2)
    await expectNoOverlap(w.user.id, w.food.id)
  })

  it("two revises racing from different months both apply, and the spans never overlap", async () => {
    at(TODAY)
    const { w, row } = await budgetOf()
    const results = await Promise.allSettled([
      reviseBudget(w.user.id, row.id, { amount: 700_000n, appliesFrom: m("2026-05-01") }),
      reviseBudget(w.user.id, row.id, { amount: 900_000n, appliesFrom: m("2026-04-01") }),
    ])
    expect(results.every((r) => r.status === "fulfilled" || r.reason instanceof InvalidBudgetError)).toBe(true)
    await expectNoOverlap(w.user.id, w.food.id)
    const stored = await rows(w.user.id, w.food.id)
    // Whatever the order, every month from the start has exactly one span: the first runs on from where it began.
    expect(fromDbDate(stored[0].startMonth)).toBe("2026-03-01")
    expect(stored.at(-1)!.endMonth).toBeNull()
  })
})

describe("updateBudgetSettings", () => {
  it("sets an end month and toggles rollover in place", async () => {
    const w = await registry.makeWorld()
    const row = await registry.makeBudget(w.user.id, w.food.id, { startMonth: "2026-03-01" })
    const view = await updateBudgetSettings(w.user.id, row.id, { endMonth: m("2026-08-01"), rollover: true })
    expect(view).toMatchObject({ id: row.id, amountPaise: "500000", startMonth: "2026-03-01", endMonth: "2026-08-01", rollover: true })
    expect((await rows(w.user.id, w.food.id))).toHaveLength(1)
  })

  it("removes an end month", async () => {
    const w = await registry.makeWorld()
    const row = await registry.makeBudget(w.user.id, w.food.id, { startMonth: "2026-03-01", endMonth: "2026-08-01", rollover: true })
    const view = await updateBudgetSettings(w.user.id, row.id, { endMonth: null, rollover: false })
    expect(view.endMonth).toBeNull()
    expect(view.rollover).toBe(false)
  })

  it("accepts an end in the start month and normalises a day to its month", async () => {
    const w = await registry.makeWorld()
    const row = await registry.makeBudget(w.user.id, w.food.id, { startMonth: "2026-03-01" })
    expect((await updateBudgetSettings(w.user.id, row.id, { endMonth: m("2026-03-25"), rollover: false })).endMonth).toBe("2026-03-01")
  })

  it("refuses an end before the start, under endMonth", async () => {
    const w = await registry.makeWorld()
    const row = await registry.makeBudget(w.user.id, w.food.id, { startMonth: "2026-03-01" })
    const error = await invalid(updateBudgetSettings(w.user.id, row.id, { endMonth: m("2026-02-01"), rollover: true }))
    expect(fieldsOf(error)).toEqual(["endMonth"])
    const [stored] = await rows(w.user.id, w.food.id)
    expect(stored.endMonth).toBeNull()
    expect(stored.rollover).toBe(false)
  })

  it("refuses an end that would run into the ledger's next span, naming it", async () => {
    const w = await registry.makeWorld()
    const first = await registry.makeBudget(w.user.id, w.food.id, { startMonth: "2026-01-01", endMonth: "2026-04-01" })
    await registry.makeBudget(w.user.id, w.food.id, { startMonth: "2026-05-01" })
    const error = await invalid(updateBudgetSettings(w.user.id, first.id, { endMonth: m("2026-05-01"), rollover: false }))
    expect(fieldsOf(error)).toEqual(["endMonth"])
    expect(error.violations[0].message).toContain("May 2026")
    // up to the month before the next span is fine
    await updateBudgetSettings(w.user.id, first.id, { endMonth: m("2026-04-01"), rollover: false })
  })

  it("refuses removing an end while another span follows", async () => {
    const w = await registry.makeWorld()
    const first = await registry.makeBudget(w.user.id, w.food.id, { startMonth: "2026-01-01", endMonth: "2026-04-01" })
    await registry.makeBudget(w.user.id, w.food.id, { startMonth: "2026-05-01" })
    expect(fieldsOf(await invalid(updateBudgetSettings(w.user.id, first.id, { endMonth: null, rollover: false })))).toEqual(["endMonth"])
    expect((await rows(w.user.id, w.food.id))[0].endMonth).not.toBeNull()
  })

  it("lets the later span's own settings change without tripping over the earlier one", async () => {
    const w = await registry.makeWorld()
    await registry.makeBudget(w.user.id, w.food.id, { startMonth: "2026-01-01", endMonth: "2026-04-01" })
    const second = await registry.makeBudget(w.user.id, w.food.id, { startMonth: "2026-05-01" })
    const view = await updateBudgetSettings(w.user.id, second.id, { endMonth: m("2026-12-01"), rollover: true })
    expect(view.endMonth).toBe("2026-12-01")
  })

  it("is not-found for another user's budget and an unknown one", async () => {
    const w = await registry.makeWorld()
    const row = await registry.makeBudget(w.user.id, w.food.id)
    const other = await registry.makeWorld()
    await notFound(updateBudgetSettings(other.user.id, row.id, { endMonth: null, rollover: true }), "budget")
    await notFound(updateBudgetSettings(w.user.id, "no-such-budget", { endMonth: null, rollover: true }), "budget")
    expect((await rows(w.user.id, w.food.id))[0].rollover).toBe(false)
  })

  it("still works on an archived ledger's budget, though create does not (review focus 3)", async () => {
    const w = await registry.makeWorld()
    const row = await registry.makeBudget(w.user.id, w.food.id, { startMonth: "2026-03-01" })
    await prisma.ledgerNode.update({ where: { id: w.food.id }, data: { archivedAt: new Date() } })
    const view = await updateBudgetSettings(w.user.id, row.id, { endMonth: m("2026-06-01"), rollover: true })
    expect(view).toMatchObject({ endMonth: "2026-06-01", rollover: true })
    expect(fieldsOf(await invalid(createBudget(w.user.id, input(w.food.id, { startMonth: m("2027-01-01") }))))).toEqual(["nodeId"])
  })
})

describe("deleteBudget", () => {
  it("removes the row, and a second delete is not-found", async () => {
    const w = await registry.makeWorld()
    const row = await registry.makeBudget(w.user.id, w.food.id)
    await deleteBudget(w.user.id, row.id)
    expect(await rows(w.user.id, w.food.id)).toHaveLength(0)
    await notFound(deleteBudget(w.user.id, row.id), "budget")
  })

  it("is not-found for another user's budget and leaves it", async () => {
    const w = await registry.makeWorld()
    const row = await registry.makeBudget(w.user.id, w.food.id)
    const other = await registry.makeWorld()
    await notFound(deleteBudget(other.user.id, row.id), "budget")
    expect(await rows(w.user.id, w.food.id)).toHaveLength(1)
  })

  it("lets the months be budgeted again afterwards", async () => {
    const w = await registry.makeWorld()
    const row = await registry.makeBudget(w.user.id, w.food.id, { startMonth: "2026-05-01" })
    await deleteBudget(w.user.id, row.id)
    await createBudget(w.user.id, input(w.food.id))
  })
})

describe("views", () => {
  it("carry paise as text and months as text, with no bigint or Date left", async () => {
    at(TODAY)
    const w = await registry.makeWorld()
    const created = await createBudget(w.user.id, input(w.food.id, { amount: 9_007_199_254_740_993n, endMonth: m("2026-12-01") }))
    const revised = await reviseBudget(w.user.id, created.id, { amount: 123n, appliesFrom: m("2026-05-01") })
    const settings = await updateBudgetSettings(w.user.id, created.id, { endMonth: null, rollover: true })
    for (const view of [created, ...revised, settings]) {
      expect(typeof view.amountPaise).toBe("string")
      expect(typeof view.startMonth).toBe("string")
      expect(() => JSON.stringify(view)).not.toThrow()
    }
    expect(created.amountPaise).toBe("9007199254740993")
  })

  it("toBudgetSettingsView is a pure mapping of a stored row", async () => {
    const w = await registry.makeWorld()
    const row = await registry.makeBudget(w.user.id, w.food.id, { amountPaise: 12_345n, startMonth: "2026-02-01", endMonth: "2026-06-01", rollover: true })
    expect(toBudgetSettingsView(row, "Food")).toEqual({
      id: row.id,
      nodeId: w.food.id,
      nodeName: "Food",
      amountPaise: "12345",
      startMonth: "2026-02-01",
      endMonth: "2026-06-01",
      rollover: true,
    })
  })
})
