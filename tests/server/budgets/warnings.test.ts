import { randomUUID } from "node:crypto"
import { afterAll, afterEach, describe, expect, it, vi } from "vitest"
import { calendarDate } from "@/domain/calendar-date"
import { prisma } from "@/server/db"
import * as reportRepository from "@/server/repositories/report-repository"
import { editTransaction, recordSplit, recordTransaction } from "@/server/services/transaction-service"
import { createRegistry } from "../repositories/fixtures"

// The budget warnings a write carries (design §7). They are judged on the state the write leaves behind, in the entry's
// own month, and they are only messages: the entry is recorded whatever they say. "Today" is moved with a fake Date
// (nothing else); the 19th of May 2026 at 06:00Z is the same day in Kolkata and New York.

const registry = createRegistry()
afterAll(registry.cleanup)
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const at = (iso: string) => vi.useFakeTimers({ toFake: ["Date"], now: new Date(iso) })
const TODAY = "2026-05-19T06:00:00Z"
const BUDGET = 100_000n // Rs 1,000.00 a month

async function setup() {
  const user = await registry.makeUser()
  const bank = await registry.makeNode(user.id, "ASSET", "Bank")
  await registry.makeTransaction(user.id, (await registry.makeNode(user.id, "INCOME_SOURCE", "Salary")).id, bank.id, {
    amountPaise: 100_000_000n,
    occurredAt: "2026-01-01",
  })
  const food = await registry.makeNode(user.id, "EXPENSE", "Food")
  const dairy = await registry.makeNode(user.id, "EXPENSE", "Dairy", { parentId: food.id })
  const fun = await registry.makeNode(user.id, "EXPENSE", "Fun")
  const record = (to: { id: string }, amount: bigint, occurredAt = "2026-05-10", from: { id: string } = bank) =>
    recordTransaction(user.id, {
      fromNodeId: from.id,
      toNodeId: to.id,
      amount,
      occurredAt: calendarDate(occurredAt),
      idempotencyKey: randomUUID(),
    })
  return { user, bank, food, dairy, fun, record }
}

const budgetWarnings = (view: { warnings: { code: string; message: string }[] }) =>
  view.warnings.filter((w) => w.code.startsWith("BUDGET_"))

describe("budget warnings on a recorded entry", () => {
  it("an entry leaving a budget at 85% carries BUDGET_NEAR with the percent", async () => {
    at(TODAY)
    const w = await setup()
    await registry.makeBudget(w.user.id, w.food.id, { amountPaise: BUDGET })
    const view = await w.record(w.food, 85_000n)
    expect(budgetWarnings(view)).toEqual([{ code: "BUDGET_NEAR", message: "Food is at 85% of its budget this month." }])
  })

  it("an entry leaving it at 105% carries BUDGET_OVER with the exact over-by amount", async () => {
    at(TODAY)
    const w = await setup()
    await registry.makeBudget(w.user.id, w.food.id, { amountPaise: BUDGET })
    await w.record(w.food, 70_000n)
    const view = await w.record(w.food, 35_000n)
    expect(budgetWarnings(view)).toEqual([{ code: "BUDGET_OVER", message: "Food is over budget by ₹50.00 this month." }])
  })

  it("a second entry while already over still carries BUDGET_OVER", async () => {
    at(TODAY)
    const w = await setup()
    await registry.makeBudget(w.user.id, w.food.id, { amountPaise: BUDGET })
    await w.record(w.food, 105_000n)
    const view = await w.record(w.food, 1_000n)
    expect(budgetWarnings(view)).toEqual([{ code: "BUDGET_OVER", message: "Food is over budget by ₹60.00 this month." }])
  })

  it("an edit that lowers the spend but still ends over still warns", async () => {
    at(TODAY)
    const w = await setup()
    await registry.makeBudget(w.user.id, w.food.id, { amountPaise: BUDGET })
    const big = await w.record(w.food, 150_000n)
    const edited = await editTransaction(w.user.id, big.id, { amount: 120_000n }, big.version)
    expect(budgetWarnings(edited)).toEqual([{ code: "BUDGET_OVER", message: "Food is over budget by ₹200.00 this month." }])
  })

  it("an entry leaving it below 80% carries none", async () => {
    at(TODAY)
    const w = await setup()
    await registry.makeBudget(w.user.id, w.food.id, { amountPaise: BUDGET })
    expect(budgetWarnings(await w.record(w.food, 79_000n))).toEqual([])
  })

  it("a refund carries none, even while the budget is over", async () => {
    at(TODAY)
    const w = await setup()
    await registry.makeBudget(w.user.id, w.food.id, { amountPaise: BUDGET })
    await w.record(w.food, 150_000n)
    const refund = await w.record(w.bank, 1_000n, "2026-05-12", w.food)
    expect(budgetWarnings(refund)).toEqual([])
  })

  it("an entry dated after today carries none", async () => {
    at(TODAY)
    const w = await setup()
    await registry.makeBudget(w.user.id, w.food.id, { amountPaise: BUDGET })
    await w.record(w.food, 150_000n)
    const future = await w.record(w.food, 5_000n, "2026-05-25")
    expect(future.warnings.map((x) => x.code)).toEqual(["FUTURE_DATED"])
  })

  it("a backdated entry is judged against its own month, not the current one", async () => {
    at(TODAY)
    const w = await setup()
    await registry.makeBudget(w.user.id, w.food.id, { amountPaise: BUDGET, startMonth: "2026-03-01" })
    await w.record(w.food, 10_000n, "2026-05-02") // May is quiet
    const april = await w.record(w.food, 105_000n, "2026-04-10")
    expect(budgetWarnings(april)).toEqual([{ code: "BUDGET_OVER", message: "Food is over budget by ₹50.00 this month." }])
    const before = await w.record(w.food, 105_000n, "2026-02-10") // before the budget began: nothing covers it
    expect(budgetWarnings(before)).toEqual([])
  })

  it("a child entry warns for both the child's budget and its parent's, each naming its own ledger", async () => {
    at(TODAY)
    const w = await setup()
    await registry.makeBudget(w.user.id, w.food.id, { amountPaise: 20_000n })
    await registry.makeBudget(w.user.id, w.dairy.id, { amountPaise: 20_000n })
    const view = await w.record(w.dairy, 25_000n)
    const warnings = budgetWarnings(view)
    expect(warnings).toHaveLength(2)
    expect(warnings.map((x) => x.code)).toEqual(["BUDGET_OVER", "BUDGET_OVER"])
    expect(warnings.map((x) => x.message).sort()).toEqual([
      "Dairy is over budget by ₹50.00 this month.",
      "Food is over budget by ₹50.00 this month.",
    ])
  })

  it("an unbudgeted ledger carries none, and neither does an entry that nothing budgets", async () => {
    at(TODAY)
    const w = await setup()
    await registry.makeBudget(w.user.id, w.food.id, { amountPaise: BUDGET })
    expect(budgetWarnings(await w.record(w.fun, 900_000n))).toEqual([])
  })

  it("another user's budget does not speak for this user's ledger", async () => {
    at(TODAY)
    const w = await setup()
    const other = await setup()
    await registry.makeBudget(other.user.id, other.food.id, { amountPaise: 1_000n })
    expect(budgetWarnings(await w.record(w.food, 900_000n))).toEqual([])
  })

  it("a split's budget warnings judge every leg, once each", async () => {
    at(TODAY)
    const w = await setup()
    await registry.makeBudget(w.user.id, w.food.id, { amountPaise: BUDGET })
    await registry.makeBudget(w.user.id, w.fun.id, { amountPaise: 10_000n })
    const views = await recordSplit(w.user.id, {
      fromNodeId: w.bank.id,
      occurredAt: calendarDate("2026-05-10"),
      idempotencyKey: randomUUID(),
      legs: [
        { toNodeId: w.food.id, amount: 90_000n },
        { toNodeId: w.fun.id, amount: 20_000n },
      ],
    })
    for (const view of views) {
      expect(budgetWarnings(view).map((x) => x.message)).toEqual([
        "Fun is over budget by ₹100.00 this month.",
        "Food is at 90% of its budget this month.",
      ])
    }
  })
})

describe("the order of warnings", () => {
  it("is OVERDRAWN, OVER_CREDIT_LIMIT, then BUDGET_OVER, then BUDGET_NEAR", async () => {
    at(TODAY)
    const w = await setup()
    // Food is near (90,000 of 100,000 once the entry lands); Dairy is over; Food counts Dairy's spend too.
    await registry.makeBudget(w.user.id, w.food.id, { amountPaise: 100_000n })
    await registry.makeBudget(w.user.id, w.dairy.id, { amountPaise: 10_000n })
    const empty = await registry.makeNode(w.user.id, "ASSET", "Empty wallet")
    const overdrawn = await w.record(w.dairy, 90_000n, "2026-05-10", empty)
    expect(overdrawn.warnings.map((x) => x.code)).toEqual(["OVERDRAWN", "BUDGET_OVER", "BUDGET_NEAR"])

    const card = await prisma.ledgerNode.create({
      data: { userId: w.user.id, kind: "LIABILITY", name: "Card", liabilitySubtype: "CREDIT_CARD", creditLimitPaise: 500n },
    })
    const overLimit = await w.record(w.dairy, 1_000n, "2026-05-11", card)
    expect(overLimit.warnings.map((x) => x.code)).toEqual(["OVER_CREDIT_LIMIT", "BUDGET_OVER", "BUDGET_NEAR"])
  })
})

describe("a budget failure never fails a write", () => {
  it("records the entry, carries no budget warning, and logs under [budgets] when the evaluation throws", async () => {
    at(TODAY)
    const w = await setup()
    await registry.makeBudget(w.user.id, w.food.id, { amountPaise: BUDGET })
    vi.spyOn(reportRepository, "findMoves").mockRejectedValue(new Error("connection reset"))
    const log = vi.spyOn(console, "error").mockImplementation(() => {})
    const view = await w.record(w.food, 150_000n)
    expect(await prisma.transaction.count({ where: { id: view.id } })).toBe(1)
    expect(budgetWarnings(view)).toEqual([])
    const lines = log.mock.calls.map((call) => String(call[0]))
    expect(lines.some((line) => line.startsWith("[budgets] "))).toBe(true)
  })
})
