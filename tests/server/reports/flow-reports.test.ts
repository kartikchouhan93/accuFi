import { randomUUID } from "node:crypto"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { addDays, calendarDate, toDbDate, todayIn, type CalendarDate } from "@/domain/calendar-date"
import { ReportRangeError } from "@/domain/periods"
import type { CashFlowView, RankedRowView, RankedView } from "@/lib/report-view"
import { prisma } from "@/server/db"
import { seedAccountNodes } from "@/server/services/account-seed"
import { archiveLedgerNode, createLedgerNode } from "@/server/services/node-service"
import { loadCashFlow, loadRangeOptions, loadRanked } from "@/server/services/report-service"
import { recordTransaction } from "@/server/services/transaction-service"
import { loadTransactionScreen } from "@/server/services/transaction-list"
import { createRegistry } from "../repositories/fixtures"
import { flowScenario, type Scenario } from "./scenarios"

// Every expected figure is worked by hand from Scenario F (plan "Shared scenarios"), in paise, never computed with the
// code under test. The reconciliation tests tie each figure to the Transactions screen's own total: the milestone's
// exit criterion is that a number on a report is the number of the entries it drills into.

const registry = createRegistry()
afterAll(registry.cleanup)

const Q1 = { kind: "custom", from: calendarDate("2026-01-01"), to: calendarDate("2026-03-31") } as const

let scenario: Scenario
beforeAll(async () => {
  scenario = await flowScenario(registry)
})

function post(userId: string, from: string, to: string, paise: bigint, day: CalendarDate) {
  return recordTransaction(userId, { fromNodeId: from, toNodeId: to, amount: paise, occurredAt: day, idempotencyKey: randomUUID() })
}

async function newUserWithNodes() {
  const user = await registry.makeUser()
  await prisma.$transaction((tx) => seedAccountNodes(tx, user.id))
  const salary = await createLedgerNode(user.id, { kind: "INCOME_SOURCE", name: "Salary" })
  const bank = await createLedgerNode(user.id, { kind: "ASSET", name: "Bank", assetSubtype: "SAVINGS" })
  return { user, salary, bank }
}

describe("loadCashFlow, Scenario F, January to March 2026", () => {
  it("reports each month's income, spending and saved, and the totals, as paise text", async () => {
    const view = await loadCashFlow(scenario.user.id, Q1)
    expect(view.empty).toBe(false)
    expect(view.buckets.map((b) => b.bucket.key)).toEqual(["2026-01", "2026-02", "2026-03"])
    expect(view.buckets.map((b) => b.incomePaise)).toEqual(["5000000", "5030000", "5200000"])
    expect(view.buckets.map((b) => b.spendingPaise)).toEqual(["2150000", "1700000", "1280000"])
    expect(view.buckets.map((b) => b.savedPaise)).toEqual(["2850000", "3330000", "3920000"])
    expect(view.buckets.some((b) => b.bucket.partial)).toBe(false)
    expect(view.totals).toMatchObject({
      incomePaise: "15230000",
      spendingPaise: "5130000",
      savedPaise: "10100000",
      gainPaise: "200000",
      lossPaise: "80000",
    })
    expect(view.range).toEqual({ from: "2026-01-01", to: "2026-03-31", clampedToToday: false, historyBegins: null, futureCount: 0 })
  })

  it("drills each bucket by flow over its own days, and the totals over the range", async () => {
    const view = await loadCashFlow(scenario.user.id, Q1)
    expect(view.buckets[0].spendingDrill).toEqual({ flow: "spending", from: "2026-01-01", to: "2026-01-31" })
    expect(view.buckets[0].incomeDrill).toEqual({ flow: "income", from: "2026-01-01", to: "2026-01-31" })
    expect(view.buckets[1].spendingDrill).toEqual({ flow: "spending", from: "2026-02-01", to: "2026-02-28" })
    expect(view.totals.incomeDrill).toEqual({ flow: "income", from: "2026-01-01", to: "2026-03-31" })
    expect(view.totals.spendingDrill).toEqual({ flow: "spending", from: "2026-01-01", to: "2026-03-31" })
  })
})

describe("loadRanked, Scenario F, January to March 2026", () => {
  it("ranks spending with children, shares, sales and refunds", async () => {
    const { nodes, user } = scenario
    const view = await loadRanked(user.id, Q1, "EXPENSE")
    expect(view.kind).toBe("EXPENSE")
    expect(view.empty).toBe(false)
    expect(view.rows.map((r) => [r.name, r.paise, r.shareTenths])).toEqual([
      ["Rent", "4500000", 852],
      ["Food", "700000", 133],
      ["Realised Loss", "80000", 15],
    ])
    const food = view.rows[1]
    expect(food.directPaise).toBe("100000")
    expect(food.children).toHaveLength(1)
    expect(food.children[0]).toMatchObject({ name: "Groceries", paise: "600000", directPaise: "600000", shareTenths: null })
    expect(food.drill).toEqual({ node: [nodes.Food.id, nodes.Groceries.id], from: "2026-01-01", to: "2026-03-31" })
    expect(food.children[0].drill).toEqual({ node: [nodes.Groceries.id], from: "2026-01-01", to: "2026-03-31" })
    expect(view.rows.map((r) => r.fromSales)).toEqual([false, false, true])
    expect(view.refunds.map((r) => [r.name, r.paise, r.shareTenths])).toEqual([["Dining", "-150000", null]])
    expect(view.totalPaise).toBe("5130000")
    expect(view.totalDrill).toEqual({ flow: "spending", from: "2026-01-01", to: "2026-03-31" })
  })

  it("ranks income, marking realised gains as from sales", async () => {
    const view = await loadRanked(scenario.user.id, Q1, "INCOME_SOURCE")
    expect(view.rows.map((r) => [r.name, r.paise, r.shareTenths, r.fromSales])).toEqual([
      ["Salary", "15000000", 985, false],
      ["Realised Gain", "200000", 13, true],
      ["Interest", "30000", 2, false],
    ])
    expect(view.refunds).toEqual([])
    expect(view.totalPaise).toBe("15230000")
    expect(view.totalDrill).toEqual({ flow: "income", from: "2026-01-01", to: "2026-03-31" })
  })

  it("keeps an archived node's row, marked archived, and the total", async () => {
    const own = await flowScenario(registry)
    await archiveLedgerNode(own.user.id, own.nodes.Rent.id)
    const view = await loadRanked(own.user.id, Q1, "EXPENSE")
    expect(view.rows[0]).toMatchObject({ name: "Rent", paise: "4500000", archived: true })
    expect(view.rows.filter((r) => r.archived)).toHaveLength(1)
    expect(view.totalPaise).toBe("5130000")
  })
})

// The milestone's exit criterion: nothing on a report differs from what its drill-through screen totals.
describe("reconciliation with the Transactions screen", () => {
  const net = async (userId: string, query: Record<string, string>) => {
    const screen = await loadTransactionScreen(userId, query)
    expect(screen.problems).toEqual({})
    return screen.netTotal!.paise
  }
  const negate = (paise: string) => String(-BigInt(paise))

  it("ties every bucket and the totals of the cash flow to the flow filter", async () => {
    const { user } = scenario
    const view = await loadCashFlow(user.id, Q1)
    const cells = [
      ...view.buckets.map((b) => ({ spending: b.spendingDrill, income: b.incomeDrill, s: b.spendingPaise, i: b.incomePaise })),
      { spending: view.totals.spendingDrill, income: view.totals.incomeDrill, s: view.totals.spendingPaise, i: view.totals.incomePaise },
    ]
    expect(cells).toHaveLength(4)
    for (const cell of cells) {
      expect(await net(user.id, { flow: "spending", from: cell.spending.from, to: cell.spending.to })).toBe(cell.s)
      expect(negate(await net(user.id, { flow: "income", from: cell.income.from, to: cell.income.to }))).toBe(cell.i)
    }
  })

  async function listedIds(userId: string, query: Record<string, string>): Promise<string[]> {
    const screen = await loadTransactionScreen(userId, query)
    return screen.page.entries
      .flatMap((e) => (e.kind === "single" ? [e.transaction.id] : e.legs.map((l) => l.id)))
      .sort()
  }
  async function touching(userId: string, ids: readonly string[], from: string, to: string): Promise<string[]> {
    const rows = await prisma.transaction.findMany({
      where: {
        userId,
        deletedAt: null,
        occurredAt: { gte: toDbDate(calendarDate(from)), lte: toDbDate(calendarDate(to)) },
        OR: [{ fromNodeId: { in: [...ids] } }, { toNodeId: { in: [...ids] } }],
      },
      select: { id: true },
    })
    return rows.map((r) => r.id).sort()
  }

  async function reconcileRows(view: RankedView, sign: 1n | -1n) {
    const { user } = scenario
    const all: RankedRowView[] = [...view.rows, ...view.rows.flatMap((r) => r.children), ...view.refunds]
    expect(all.length).toBeGreaterThan(0)
    for (const row of all) {
      const ids = row.drill.node!
      const query = { node: ids.join(","), from: row.drill.from, to: row.drill.to }
      expect(BigInt(await net(user.id, query)) * sign, row.name).toBe(BigInt(row.paise))
      const listed = await listedIds(user.id, query)
      expect(listed, row.name).toEqual(await touching(user.id, ids, row.drill.from, row.drill.to))
      expect(listed.length, row.name).toBeGreaterThan(0)
    }
    expect(await net(user.id, { flow: view.totalDrill.flow!, from: view.totalDrill.from, to: view.totalDrill.to })).toBe(
      view.kind === "EXPENSE" ? view.totalPaise : negate(view.totalPaise),
    )
  }

  it("ties every spending row, child and refund row to the node filter", async () => {
    await reconcileRows(await loadRanked(scenario.user.id, Q1, "EXPENSE"), 1n)
  })

  it("ties every income row to the node filter", async () => {
    await reconcileRows(await loadRanked(scenario.user.id, Q1, "INCOME_SOURCE"), -1n)
  })
})

describe("range handling", () => {
  it("starts at the month of the first entry and says when history begins", async () => {
    const { user, salary, bank } = await newUserWithNodes()
    await post(user.id, salary.id, bank.id, 100_000n, calendarDate("2026-02-10"))
    const view = await loadCashFlow(user.id, { kind: "custom", from: calendarDate("2025-11-01"), to: calendarDate("2026-03-31") })
    expect(view.buckets.map((b) => b.bucket.key)).toEqual(["2026-02", "2026-03"])
    expect(view.range.from).toBe("2026-02-01")
    expect(view.range.historyBegins).toBe("2026-02-10")
    expect(view.buckets[0].incomePaise).toBe("100000")
  })

  it("does not clip the ranked view", async () => {
    const { user, salary, bank } = await newUserWithNodes()
    await post(user.id, salary.id, bank.id, 100_000n, calendarDate("2026-02-10"))
    const view = await loadRanked(user.id, { kind: "custom", from: calendarDate("2025-11-01"), to: calendarDate("2026-03-31") }, "INCOME_SOURCE")
    expect(view.range.from).toBe("2025-11-01")
    expect(view.range.historyBegins).toBeNull()
    expect(view.rows.map((r) => [r.name, r.paise])).toEqual([["Salary", "100000"]])
  })

  it("clamps a range ending in the future to today and counts the entries it leaves out", async () => {
    const { user, salary, bank } = await newUserWithNodes()
    const today = todayIn(user.timezone)
    await post(user.id, salary.id, bank.id, 100_000n, today)
    await post(user.id, salary.id, bank.id, 700_000n, addDays(today, 10))
    const choice = { kind: "custom", from: addDays(today, -5), to: addDays(today, 30) } as const

    const flow = await loadCashFlow(user.id, choice)
    expect(flow.range.to).toBe(today)
    expect(flow.range.clampedToToday).toBe(true)
    expect(flow.range.futureCount).toBe(1)
    expect(flow.totals.incomePaise).toBe("100000")

    const ranked = await loadRanked(user.id, choice, "INCOME_SOURCE")
    expect(ranked.range).toMatchObject({ to: today, clampedToToday: true, futureCount: 1 })
    expect(ranked.totalPaise).toBe("100000")
  })

  it("counts no future entries when the range ends before today", async () => {
    const { user, salary, bank } = await newUserWithNodes()
    const today = todayIn(user.timezone)
    await post(user.id, salary.id, bank.id, 700_000n, addDays(today, 10))
    const view = await loadCashFlow(user.id, { kind: "custom", from: addDays(today, -40), to: addDays(today, -20) })
    expect(view.range.futureCount).toBe(0)
  })

  it.each(["Pacific/Kiritimati", "Pacific/Pago_Pago"])("ends a last-12-months range on today in %s", async (zone) => {
    const user = await registry.makeUser()
    await prisma.user.update({ where: { id: user.id }, data: { timezone: zone } })
    const view = await loadCashFlow(user.id, { kind: "last12" })
    expect(view.range.to).toBe(todayIn(zone))
    expect(view.buckets).toEqual([])
  })
})

describe("degenerate ranges", () => {
  it("says empty, with no buckets, for a user with no transactions", async () => {
    const user = await registry.makeUser()
    await prisma.$transaction((tx) => seedAccountNodes(tx, user.id))
    const flow = await loadCashFlow(user.id, { kind: "last12" })
    expect(flow.empty).toBe(true)
    expect(flow.buckets).toEqual([])
    expect(flow.totals).toMatchObject({ incomePaise: "0", spendingPaise: "0", savedPaise: "0", gainPaise: "0", lossPaise: "0" })
    const ranked = await loadRanked(user.id, { kind: "last12" }, "EXPENSE")
    expect(ranked.empty).toBe(true)
    expect(ranked.rows).toEqual([])
    expect(ranked.totalPaise).toBe("0")
  })

  it("gives one zero bucket and no rows for a range with no activity", async () => {
    const choice = { kind: "custom", from: calendarDate("2025-01-01"), to: calendarDate("2025-01-31") } as const
    const flow: CashFlowView = await loadCashFlow(scenario.user.id, choice)
    expect(flow.empty).toBe(false)
    expect(flow.buckets).toHaveLength(1)
    expect(flow.buckets[0]).toMatchObject({ incomePaise: "0", spendingPaise: "0", savedPaise: "0" })
    expect(flow.range.historyBegins).toBeNull()
    expect(JSON.stringify(flow)).not.toContain("NaN")
    for (const kind of ["INCOME_SOURCE", "EXPENSE"] as const) {
      const ranked = await loadRanked(scenario.user.id, choice, kind)
      expect(ranked.rows).toEqual([])
      expect(ranked.refunds).toEqual([])
      expect(ranked.totalPaise).toBe("0")
      expect(JSON.stringify(ranked)).not.toContain("NaN")
    }
  })

  it("rejects a range that ends before it starts", async () => {
    const choice = { kind: "custom", from: calendarDate("2026-03-01"), to: calendarDate("2026-01-01") } as const
    await expect(loadCashFlow(scenario.user.id, choice)).rejects.toBeInstanceOf(ReportRangeError)
    await expect(loadRanked(scenario.user.id, choice, "EXPENSE")).rejects.toBeInstanceOf(ReportRangeError)
  })
})

// What the range pickers offer: every month and financial year from the first live entry to today, today being the
// user's own day. The clock is moved (Date only) to a moment that is still 31 March in UTC but already 1 April in
// Kolkata, the users' timezone, so a list built from the machine's day instead would miss April and FY 2026-27.
describe("loadRangeOptions", () => {
  afterEach(() => {
    vi.useRealTimers()
  })
  const lateOn31March = () => vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-03-31T20:00:00Z") })

  it("offers each month and financial year from the first entry (1 Jan 2026) to today in the user's timezone, newest first", async () => {
    lateOn31March()
    expect(await loadRangeOptions(scenario.user.id)).toEqual({
      months: [
        { year: 2026, month: 4 },
        { year: 2026, month: 3 },
        { year: 2026, month: 2 },
        { year: 2026, month: 1 },
      ],
      fys: [2026, 2025],
      fyStartMonth: 4,
    })
  })

  it("offers nothing to a user with no transactions", async () => {
    const user = await registry.makeUser()
    await prisma.$transaction((tx) => seedAccountNodes(tx, user.id))
    lateOn31March()
    expect(await loadRangeOptions(user.id)).toEqual({ months: [], fys: [], fyStartMonth: 4 })
  })

  it("counts financial years from the user's own start month", async () => {
    const { user, salary, bank } = await newUserWithNodes()
    await post(user.id, salary.id, bank.id, 100_000n, calendarDate("2026-01-05"))
    await prisma.user.update({ where: { id: user.id }, data: { financialYearStartMonth: 1 } })
    lateOn31March()
    expect(await loadRangeOptions(user.id)).toEqual({
      months: [
        { year: 2026, month: 4 },
        { year: 2026, month: 3 },
        { year: 2026, month: 2 },
        { year: 2026, month: 1 },
      ],
      fys: [2026],
      fyStartMonth: 1,
    })
  })

  it("ignores a soft-deleted entry older than every live one", async () => {
    const { user, salary, bank } = await newUserWithNodes()
    const old = await post(user.id, salary.id, bank.id, 100_000n, calendarDate("2025-12-20"))
    await post(user.id, salary.id, bank.id, 100_000n, calendarDate("2026-03-02"))
    await prisma.transaction.update({ where: { id: old.id }, data: { deletedAt: new Date("2026-03-03T00:00:00Z") } })
    lateOn31March()
    expect((await loadRangeOptions(user.id)).months).toEqual([
      { year: 2026, month: 4 },
      { year: 2026, month: 3 },
    ])
  })
})
