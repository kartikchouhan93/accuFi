import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { netWorth } from "@/domain/balance"
import { calendarDate, todayIn } from "@/domain/calendar-date"
import { QUANTITY_SCALE } from "@/domain/quantity"
import { transactionsHref } from "@/lib/report-drill"
import { prisma } from "@/server/db"
import { NotFoundError } from "@/server/repositories/errors"
import { sumBalances } from "@/server/repositories/transaction-repository"
import { seedAccountNodes } from "@/server/services/account-seed"
import { getDashboard } from "@/server/services/balance-service"
import { loadValuations, sellInvestment } from "@/server/services/investment-service"
import { archiveLedgerNode, createLedgerNode } from "@/server/services/node-service"
import { recordPrice } from "@/server/services/price-service"
import { loadAccountHistory, loadInvestmentGrowth, loadNetWorthReport } from "@/server/services/report-service"
import { recordTransaction } from "@/server/services/transaction-service"
import { loadTransactionScreen } from "@/server/services/transaction-list"
import { createRegistry } from "../repositories/fixtures"
import { flowScenario, holdingsScenario, type Scenario } from "./scenarios"

// Every expected figure is worked by hand from Scenario N (net worth, growth) and Scenario F (account history), plan
// "Shared scenarios", in paise, never computed with the code under test. The oracle tests tie the reports to the code
// path the dashboard already uses, so a report cannot disagree with it.

const registry = createRegistry()
afterAll(registry.cleanup)

const custom = (from: string, to: string) => ({ kind: "custom", from: calendarDate(from), to: calendarDate(to) }) as const
const Q1 = custom("2026-01-01", "2026-03-31")

let holdings: Scenario
let flows: Scenario
beforeAll(async () => {
  holdings = await holdingsScenario(registry)
  flows = await flowScenario(registry)
})

async function emptyUser() {
  const user = await registry.makeUser()
  await prisma.$transaction((tx) => seedAccountNodes(tx, user.id))
  return user
}

describe("loadNetWorthReport, Scenario N, January to March 2026", () => {
  it("values each month-end at the prices known then, leaving an unpriced holding out as partial", async () => {
    const view = await loadNetWorthReport(holdings.user.id, Q1)
    expect(view.empty).toBe(false)
    expect(view.range).toEqual({ from: "2026-01-01", to: "2026-03-31", clampedToToday: false, historyBegins: "2026-01-02", futureCount: 0 })
    expect(view.points.map((p) => p.asOf)).toEqual(["2026-01-31", "2026-02-28", "2026-03-31"])
    expect(view.points.map((p) => p.bucket.key)).toEqual(["2026-01", "2026-02", "2026-03"])
    const [jan, feb, mar] = view.points
    expect(jan).toMatchObject({
      assetsPaise: "12000000",
      investmentsPaise: "1000000",
      liabilitiesPaise: "2000000",
      totalPaise: "11000000",
      partial: true,
      unvalued: [{ nodeId: holdings.nodes.Gold.id, name: "Gold", reason: "NO_PRICE" }],
      staleNames: [],
    })
    expect(feb).toMatchObject({
      assetsPaise: "8300000",
      investmentsPaise: "12250000",
      liabilitiesPaise: "2000000",
      totalPaise: "18550000",
      partial: false,
      unvalued: [],
      staleNames: [],
    })
    expect(mar).toMatchObject({
      assetsPaise: "14380000",
      investmentsPaise: "6320000",
      liabilitiesPaise: "2000000",
      totalPaise: "18700000",
      partial: false,
      unvalued: [],
      staleNames: [],
    })
  })

  it("drills each month into its entries, by kind or all of them", async () => {
    const view = await loadNetWorthReport(holdings.user.id, Q1)
    const feb = view.points[1]
    expect(feb.assetsDrill).toEqual({ kind: "ASSET", from: "2026-02-01", to: "2026-02-28" })
    expect(feb.investmentsDrill).toEqual({ kind: "INVESTMENT", from: "2026-02-01", to: "2026-02-28" })
    expect(feb.liabilitiesDrill).toEqual({ kind: "LIABILITY", from: "2026-02-01", to: "2026-02-28" })
    expect(feb.movementDrill).toEqual({ from: "2026-02-01", to: "2026-02-28" })
    expect(feb.movementDrill.kind).toBeUndefined()
  })

  it("agrees with the existing net worth code path on every month-end, and with the dashboard today", async () => {
    const { user } = holdings
    const view = await loadNetWorthReport(user.id, Q1)
    for (const point of view.points) {
      const oracle = netWorth(await sumBalances(user.id, point.asOf), await loadValuations(user.id, point.asOf))
      expect(point.totalPaise, point.asOf).toBe(String(oracle.total))
    }

    const today = todayIn(user.timezone)
    const year = await loadNetWorthReport(user.id, { kind: "last12" })
    const last = year.points[year.points.length - 1]
    expect(last.asOf).toBe(today)
    expect(last.totalPaise).toBe("18700000")
    expect(last.totalPaise).toBe((await getDashboard(user.id)).netWorth.total)
  })

  it("values January once a price dated in January is recorded, and flags a price gone stale (EC-24, EC-25)", async () => {
    const own = await holdingsScenario(registry)
    await recordPrice(own.user.id, { nodeId: own.nodes.Gold.id, asOf: calendarDate("2026-01-31"), pricePerUnit: 720_000n })
    const view = await loadNetWorthReport(own.user.id, Q1)
    expect(view.points[0]).toMatchObject({ investmentsPaise: "8200000", totalPaise: "18200000", partial: false, unvalued: [] })

    const longer = await loadNetWorthReport(own.user.id, custom("2026-01-01", "2026-04-30"))
    expect(longer.points.map((p) => p.asOf)).toEqual(["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"])
    expect(longer.points[2].staleNames).toEqual([])
    expect(longer.points[3]).toMatchObject({ totalPaise: "18700000", staleNames: ["Gold"], partial: false })
  })

  it("leaves out, at every point, an investment held by lots with an entry that has no lot (EC-23)", async () => {
    const own = await holdingsScenario(registry)
    const silver = await registry.makeNode(own.user.id, "INVESTMENT", "Silver", { valuationMode: "QUANTITY", unitLabel: "g", lotMethod: "FIFO" })
    await registry.makeTransaction(own.user.id, own.nodes.Bank.id, silver.id, { amountPaise: 1_000_000n, occurredAt: "2026-01-15" })

    const view = await loadNetWorthReport(own.user.id, Q1)
    const silverGap = { nodeId: silver.id, name: "Silver", reason: "NEEDS_QUANTITY" }
    expect(view.points[0]).toMatchObject({
      assetsPaise: "11000000",
      investmentsPaise: "1000000",
      totalPaise: "10000000",
      partial: true,
      unvalued: [{ nodeId: own.nodes.Gold.id, name: "Gold", reason: "NO_PRICE" }, silverGap],
    })
    expect(view.points[1]).toMatchObject({ assetsPaise: "7300000", investmentsPaise: "12250000", totalPaise: "17550000", partial: true, unvalued: [silverGap] })
    expect(view.points[2]).toMatchObject({ assetsPaise: "13380000", investmentsPaise: "6320000", totalPaise: "17700000", partial: true, unvalued: [silverGap] })
  })

  it("says empty, with no points, for a user with no transactions", async () => {
    const user = await emptyUser()
    const view = await loadNetWorthReport(user.id, { kind: "last12" })
    expect(view.empty).toBe(true)
    expect(view.points).toEqual([])
  })
})

describe("loadAccountHistory, Scenario F", () => {
  // 182 days as asked for, so monthly; clipped to begin in January, where the history begins.
  const HALF_YEAR = custom("2025-10-01", "2026-03-31")
  const steps = (view: Awaited<ReturnType<typeof loadAccountHistory>>) =>
    view.steps.map((s) => [s.openingPaise, s.inPaise, s.outPaise, s.closingPaise])

  it("steps the bank month by month over a long range, starting where history begins", async () => {
    const { user, nodes } = flows
    const view = await loadAccountHistory(user.id, HALF_YEAR, nodes.Bank.id)
    expect(view.granularity).toBe("month")
    expect(view.empty).toBe(false)
    expect(view.range).toMatchObject({ from: "2026-01-01", to: "2026-03-31", historyBegins: "2026-01-01" })
    expect(view.selected).toEqual({ id: nodes.Bank.id, name: "Bank", kind: "ASSET", archived: false })
    expect(view.steps.map((s) => s.bucket.key)).toEqual(["2026-01", "2026-02", "2026-03"])
    expect(steps(view)).toEqual([
      ["0", "15000000", "2650000", "12350000"],
      ["12350000", "5080000", "2500000", "14930000"],
      ["14930000", "6100000", "2180000", "18850000"],
    ])
    expect(view.steps[1].drill).toEqual({ node: [nodes.Bank.id], from: "2026-02-01", to: "2026-02-28" })
  })

  it("steps day by day over a range of 93 days or fewer, opening on the balance the day before", async () => {
    const { user, nodes } = flows
    const view = await loadAccountHistory(user.id, custom("2026-02-01", "2026-03-31"), nodes.Bank.id)
    expect(view.granularity).toBe("day")
    expect(view.steps).toHaveLength(59)
    expect(view.steps[0].bucket.key).toBe("2026-02-01")
    expect(view.steps[0].openingPaise).toBe("12350000")
    expect(view.steps[58].closingPaise).toBe("18850000")

    const january = await loadAccountHistory(user.id, custom("2026-01-01", "2026-01-31"), nodes.Bank.id)
    expect(january.granularity).toBe("day")
    expect(january.steps).toHaveLength(31)
    const fifth = january.steps.find((s) => s.bucket.key === "2026-01-05")!
    expect([fifth.openingPaise, fifth.inPaise, fifth.outPaise, fifth.closingPaise]).toEqual(["10000000", "5000000", "0", "15000000"])
    expect(fifth.drill).toEqual({ node: [nodes.Bank.id], from: "2026-01-05", to: "2026-01-05" })
  })

  it("is daily up to 93 days inclusive and monthly from 94", async () => {
    const { user, nodes } = flows
    expect((await loadAccountHistory(user.id, custom("2026-01-01", "2026-04-03"), nodes.Bank.id)).granularity).toBe("day")
    expect((await loadAccountHistory(user.id, custom("2026-01-01", "2026-04-04"), nodes.Bank.id)).granularity).toBe("month")
  })

  it("steps the card, a liability, as a negative balance", async () => {
    const { user, nodes } = flows
    const view = await loadAccountHistory(user.id, HALF_YEAR, nodes.Card.id)
    expect(view.selected).toEqual({ id: nodes.Card.id, name: "Card", kind: "LIABILITY", archived: false })
    expect(view.granularity).toBe("month")
    expect(steps(view)).toEqual([
      ["0", "500000", "2000000", "-1500000"],
      ["-1500000", "0", "250000", "-1750000"],
      ["-1750000", "0", "0", "-1750000"],
    ])
  })

  it("selects the oldest live asset when no account is named, and lists every asset and liability", async () => {
    const { user, nodes } = flows
    const view = await loadAccountHistory(user.id, Q1, undefined)
    expect(view.selected?.id).toBe(nodes.Bank.id)
    expect(view.accounts.map((a) => [a.name, a.kind])).toEqual([
      ["Bank", "ASSET"],
      ["Savings", "ASSET"],
      ["Card", "LIABILITY"],
    ])
  })

  it("passes over an archived asset when choosing one, but still lists it", async () => {
    const own = await flowScenario(registry)
    await archiveLedgerNode(own.user.id, own.nodes.Bank.id)
    const view = await loadAccountHistory(own.user.id, Q1, undefined)
    expect(view.selected?.id).toBe(own.nodes.Savings.id)
    expect(view.accounts.find((a) => a.id === own.nodes.Bank.id)?.archived).toBe(true)
    const archived = await loadAccountHistory(own.user.id, HALF_YEAR, own.nodes.Bank.id)
    expect(archived.steps[2].closingPaise).toBe("18850000")
  })

  it("selects nothing for a user with no asset", async () => {
    const user = await emptyUser()
    const view = await loadAccountHistory(user.id, Q1, undefined)
    expect(view.selected).toBeNull()
    expect(view.steps).toEqual([])
    expect(view.empty).toBe(true)
  })

  it("refuses an income source, an expense, an unknown id and another user's account", async () => {
    const { user, nodes } = flows
    for (const id of [nodes.Salary.id, nodes.Rent.id, randomUUID(), holdings.nodes.Bank.id]) {
      await expect(loadAccountHistory(user.id, Q1, id)).rejects.toBeInstanceOf(NotFoundError)
    }
  })

  it("ties every bank month to the Transactions screen's total and to the balance at its end", async () => {
    const { user, nodes } = flows
    const view = await loadAccountHistory(user.id, HALF_YEAR, nodes.Bank.id)
    const nets: string[] = []
    for (const step of view.steps) {
      const screen = await loadTransactionScreen(user.id, { node: nodes.Bank.id, from: step.bucket.from, to: step.bucket.to })
      expect(screen.problems).toEqual({})
      nets.push(screen.netTotal!.paise)
      expect(screen.netTotal!.paise).toBe(String(BigInt(step.closingPaise) - BigInt(step.openingPaise)))
      const balance = (await sumBalances(user.id, step.bucket.to)).find((row) => row.nodeId === nodes.Bank.id)!.balance
      expect(step.closingPaise).toBe(String(balance))
    }
    expect(nets).toEqual(["12350000", "2580000", "3920000"])
  })
})

describe("loadInvestmentGrowth, Scenario N, January to March 2026", () => {
  const figures = (points: { investedPaise: string; valuePaise: string | null; gainPaise: string | null; realisedPaise: string }[]) =>
    points.map((p) => [p.investedPaise, p.valuePaise, p.gainPaise, p.realisedPaise])

  it("sets what the portfolio is worth against what went into it, over the investments it can value", async () => {
    const { user, nodes } = holdings
    const view = await loadInvestmentGrowth(user.id, Q1, undefined)
    expect(view.empty).toBe(false)
    expect(view.selected).toBeNull()
    expect(view.investments.map((i) => i.name).sort()).toEqual(["Fund", "Gold"])
    expect(view.points.map((p) => p.asOf)).toEqual(["2026-01-31", "2026-02-28", "2026-03-31"])
    expect(figures(view.points)).toEqual([
      ["8000000", "1000000", "0", "0"],
      ["11700000", "12250000", "550000", "0"],
      ["6100000", "6320000", "220000", "480000"],
    ])
    expect(view.points.map((p) => p.covered)).toEqual([
      { covered: 1, total: 2 },
      { covered: 2, total: 2 },
      { covered: 2, total: 2 },
    ])
    expect(view.points.map((p) => p.unvaluedNames)).toEqual([["Gold"], [], []])
    expect(view.points.map((p) => p.stale)).toEqual([false, false, false])
    expect(new Set(view.points[1].drill.node)).toEqual(new Set([nodes.Gold.id, nodes.Fund.id]))
    expect(view.points[1].drill).toMatchObject({ from: "2026-02-01", to: "2026-02-28" })
  })

  it("follows one investment, with a gap where it cannot be valued", async () => {
    const { user, nodes } = holdings
    const gold = await loadInvestmentGrowth(user.id, Q1, nodes.Gold.id)
    expect(gold.selected).toEqual({ id: nodes.Gold.id, name: "Gold" })
    expect(figures(gold.points)).toEqual([
      ["7000000", null, null, "0"],
      ["10700000", "11250000", "550000", "0"],
      ["5100000", "5320000", "220000", "480000"],
    ])
    expect(gold.points.map((p) => p.covered)).toEqual([null, null, null])
    expect(gold.points[2].drill).toEqual({ node: [nodes.Gold.id], from: "2026-03-01", to: "2026-03-31" })
    expect(gold.points[2].valuePaise).toBe(String((await loadValuations(user.id, calendarDate("2026-03-31"))).get(nodes.Gold.id)))

    const fund = await loadInvestmentGrowth(user.id, Q1, nodes.Fund.id)
    expect(figures(fund.points)).toEqual([
      ["1000000", "1000000", "0", "0"],
      ["1000000", "1000000", "0", "0"],
      ["1000000", "1000000", "0", "0"],
    ])
  })

  it("reports a sale at a loss as a negative realised figure", async () => {
    const user = await emptyUser()
    const bank = await createLedgerNode(user.id, { kind: "ASSET", name: "Bank", assetSubtype: "SAVINGS" })
    const gold = await createLedgerNode(user.id, { kind: "INVESTMENT", name: "Gold", valuationMode: "QUANTITY", unitLabel: "g", lotMethod: "FIFO" })
    const opening = (await prisma.ledgerNode.findFirst({ where: { userId: user.id, systemRole: "OPENING_BALANCE" } }))!
    const post = (from: string, to: string, amount: bigint, day: string, quantity?: bigint) =>
      recordTransaction(user.id, { fromNodeId: from, toNodeId: to, amount, occurredAt: calendarDate(day), quantity, idempotencyKey: randomUUID() })
    await post(opening.id, bank.id, 10_000_000n, "2026-01-02")
    await post(bank.id, gold.id, 7_000_000n, "2026-01-10", 10n * QUANTITY_SCALE)
    await sellInvestment(user.id, {
      nodeId: gold.id,
      toNodeId: bank.id,
      quantity: 10n * QUANTITY_SCALE,
      proceeds: 6_200_000n,
      occurredAt: calendarDate("2026-03-20"),
      idempotencyKey: randomUUID(),
    })
    const view = await loadInvestmentGrowth(user.id, Q1, gold.id)
    expect(view.points.map((p) => p.realisedPaise)).toEqual(["0", "0", "-800000"])
    expect(view.points[2].investedPaise).toBe("0")
  })

  it("still counts an archived investment", async () => {
    const own = await holdingsScenario(registry)
    await archiveLedgerNode(own.user.id, own.nodes.Gold.id)
    const view = await loadInvestmentGrowth(own.user.id, Q1, undefined)
    expect(view.investments.find((i) => i.id === own.nodes.Gold.id)?.archived).toBe(true)
    expect(figures(view.points)).toEqual([
      ["8000000", "1000000", "0", "0"],
      ["11700000", "12250000", "550000", "0"],
      ["6100000", "6320000", "220000", "480000"],
    ])
    const gold = await loadInvestmentGrowth(own.user.id, Q1, own.nodes.Gold.id)
    expect(gold.points[2].valuePaise).toBe("5320000")
  })

  it("refuses an account that is not an investment, and another user's investment", async () => {
    const { user, nodes } = holdings
    for (const id of [nodes.Bank.id, flows.nodes.Salary.id, randomUUID()]) {
      await expect(loadInvestmentGrowth(user.id, Q1, id)).rejects.toBeInstanceOf(NotFoundError)
    }
    const other = await holdingsScenario(registry)
    await expect(loadInvestmentGrowth(user.id, Q1, other.nodes.Gold.id)).rejects.toBeInstanceOf(NotFoundError)
  })

  it("drills a month into the investment entries, not every entry, for a user with transactions but no investments", async () => {
    const view = await loadInvestmentGrowth(flows.user.id, Q1, undefined)
    expect(view.investments).toEqual([])
    expect(view.points.map((p) => p.drill)).toEqual([
      { kind: "INVESTMENT", from: "2026-01-01", to: "2026-01-31" },
      { kind: "INVESTMENT", from: "2026-02-01", to: "2026-02-28" },
      { kind: "INVESTMENT", from: "2026-03-01", to: "2026-03-31" },
    ])
    expect(transactionsHref(view.points[0].drill)).toBe("/transactions?kind=INVESTMENT&from=2026-01-01&to=2026-01-31")
  })

  it("says empty, with no points, for a user with no transactions", async () => {
    const user = await emptyUser()
    const view = await loadInvestmentGrowth(user.id, { kind: "last12" }, undefined)
    expect(view.empty).toBe(true)
    expect(view.points).toEqual([])
  })
})
