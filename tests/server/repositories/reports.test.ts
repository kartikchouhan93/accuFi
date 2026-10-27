import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { addDays, calendarDate, todayIn } from "@/domain/calendar-date"
import { QUANTITY_SCALE } from "@/domain/quantity"
import { prisma } from "@/server/db"
import { UserNotFoundError } from "@/server/repositories/errors"
import {
  countLiveTransactionsAfter,
  findFirstTransactionDate,
  findMoves,
  findRealisedByMonth,
  type MoveRow,
} from "@/server/repositories/report-repository"
import { findFinancialYearStartMonth } from "@/server/repositories/user-repository"
import { seedAccountNodes } from "@/server/services/account-seed"
import { createLedgerNode } from "@/server/services/node-service"
import { sellInvestment } from "@/server/services/investment-service"
import { recordTransaction } from "@/server/services/transaction-service"
import { softDeleteTransaction } from "@/server/repositories/transaction-repository"
import { flowScenario, holdingsScenario, type Scenario } from "../reports/scenarios"
import { createRegistry } from "./fixtures"

// Every expected figure is worked by hand from the scenario tables (paise), never computed with the code under test.

const registry = createRegistry()
afterAll(registry.cleanup)

const Q1 = { from: calendarDate("2026-01-01"), to: calendarDate("2026-03-31") }
const byKey = (rows: MoveRow[], nodeId: string, bucket: string) => rows.find((r) => r.nodeId === nodeId && r.bucket === bucket)

let flow: Scenario
let holdings: Scenario
beforeAll(async () => {
  flow = await flowScenario(registry)
  holdings = await holdingsScenario(registry)
})

describe("findMoves", () => {
  it("sums what moved into and out of each income and expense node, per month, never counting the deleted entry", async () => {
    const { user, nodes } = flow
    const rows = await findMoves(user.id, { ...Q1, bucket: "month", kinds: ["INCOME_SOURCE", "EXPENSE"] })
    expect(byKey(rows, nodes.Salary.id, "2026-01")).toEqual({ nodeId: nodes.Salary.id, bucket: "2026-01", inPaise: 0n, outPaise: 5_000_000n })
    expect(byKey(rows, nodes.Rent.id, "2026-02")).toEqual({ nodeId: nodes.Rent.id, bucket: "2026-02", inPaise: 1_500_000n, outPaise: 0n })
    expect(byKey(rows, nodes.Groceries.id, "2026-02")).toEqual({ nodeId: nodes.Groceries.id, bucket: "2026-02", inPaise: 250_000n, outPaise: 50_000n })
    expect(byKey(rows, nodes.Dining.id, "2026-03")).toEqual({ nodeId: nodes.Dining.id, bucket: "2026-03", inPaise: 600_000n, outPaise: 900_000n })
    expect(byKey(rows, nodes["Opening Balance"].id, "2026-01")).toEqual({
      nodeId: nodes["Opening Balance"].id,
      bucket: "2026-01",
      inPaise: 0n,
      outPaise: 10_000_000n,
    })
    // the only March Groceries entry is the soft-deleted one
    expect(rows.filter((r) => r.nodeId === nodes.Groceries.id && r.bucket === "2026-03")).toEqual([])
    // no moves, no row
    expect(rows.filter((r) => r.nodeId === nodes.Utilities.id)).toEqual([])
    // kinds filter: no asset or liability nodes
    expect(rows.some((r) => [nodes.Bank.id, nodes.Savings.id, nodes.Card.id].includes(r.nodeId))).toBe(false)
  })

  it("narrows to the named nodes, with monthly in and out of the bank", async () => {
    const { user, nodes } = flow
    const rows = await findMoves(user.id, { ...Q1, bucket: "month", nodeIds: [nodes.Bank.id] })
    expect(rows).toEqual([
      { nodeId: nodes.Bank.id, bucket: "2026-01", inPaise: 15_000_000n, outPaise: 2_650_000n },
      { nodeId: nodes.Bank.id, bucket: "2026-02", inPaise: 5_080_000n, outPaise: 2_500_000n },
      { nodeId: nodes.Bank.id, bucket: "2026-03", inPaise: 6_100_000n, outPaise: 2_180_000n },
    ])
  })

  it("buckets by day, and includes both ends of the range", async () => {
    const { user, nodes } = flow
    const day = calendarDate("2026-01-05")
    expect(await findMoves(user.id, { from: day, to: day, bucket: "day", nodeIds: [nodes.Bank.id] })).toEqual([
      { nodeId: nodes.Bank.id, bucket: "2026-01-05", inPaise: 5_000_000n, outPaise: 0n },
    ])
  })

  it("gives nothing for a range that ends before the first entry", async () => {
    expect(await findMoves(flow.user.id, { from: calendarDate("2025-01-01"), to: calendarDate("2025-12-31"), bucket: "month" })).toEqual([])
  })
})

describe("findRealisedByMonth", () => {
  it("attributes a gain to the investment sold, in the month of the sale", async () => {
    expect(await findRealisedByMonth(holdings.user.id, Q1)).toEqual([
      { nodeId: holdings.nodes.Gold.id, bucket: "2026-03", gainPaise: 480_000n, lossPaise: 0n },
    ])
  })

  /** Gold bought 10 g for Rs 70,000 on 10 Jan, sold whole on 20 Mar for `proceeds` rupees. */
  async function goldSoldFor(proceeds: bigint) {
    const user = await registry.makeUser()
    await prisma.$transaction((tx) => seedAccountNodes(tx, user.id))
    const bank = await createLedgerNode(user.id, { kind: "ASSET", name: "Bank", assetSubtype: "SAVINGS" })
    const gold = await createLedgerNode(user.id, { kind: "INVESTMENT", name: "Gold", valuationMode: "QUANTITY", unitLabel: "g", lotMethod: "FIFO" })
    const opening = await prisma.ledgerNode.findFirstOrThrow({ where: { userId: user.id, systemRole: "OPENING_BALANCE" } })
    const post = (from: string, to: string, amount: bigint, day: string, quantity?: bigint) =>
      recordTransaction(user.id, { fromNodeId: from, toNodeId: to, amount, quantity, occurredAt: calendarDate(day), idempotencyKey: randomUUID() })
    await post(opening.id, bank.id, 200_000_00n, "2026-01-02")
    await post(bank.id, gold.id, 70_000_00n, "2026-01-10", 10n * QUANTITY_SCALE)
    await sellInvestment(user.id, {
      nodeId: gold.id,
      toNodeId: bank.id,
      quantity: 10n * QUANTITY_SCALE,
      proceeds: proceeds * 100n,
      occurredAt: calendarDate("2026-03-20"),
      idempotencyKey: randomUUID(),
    })
    return { user, gold }
  }

  it("attributes a loss to the investment sold", async () => {
    const { user, gold } = await goldSoldFor(62_000n)
    expect(await findRealisedByMonth(user.id, Q1)).toEqual([{ nodeId: gold.id, bucket: "2026-03", gainPaise: 0n, lossPaise: 800_000n }])
  })

  it("gives no row for a break-even sale, which posts one ungrouped transaction", async () => {
    const { user } = await goldSoldFor(70_000n)
    expect(await findRealisedByMonth(user.id, Q1)).toEqual([])
  })

  it("leaves out a realised leg outside the range, and one whose sale was deleted", async () => {
    const { user, nodes } = holdings
    expect(await findRealisedByMonth(user.id, { from: calendarDate("2026-01-01"), to: calendarDate("2026-02-28") })).toEqual([])
    const { user: seller, gold } = await goldSoldFor(62_000n)
    const legs = await prisma.transaction.findMany({ where: { userId: seller.id, group: { kind: "DISPOSAL" } } })
    expect(legs).toHaveLength(2)
    for (const leg of legs) await softDeleteTransaction(seller.id, leg.id)
    expect(await findRealisedByMonth(seller.id, Q1)).toEqual([])
    expect(gold.id).not.toBe(nodes.Gold.id)
  })
})

describe("findFirstTransactionDate", () => {
  it("is the earliest live entry, null with none, and null when the only entry is deleted", async () => {
    expect(await findFirstTransactionDate(flow.user.id)).toBe("2026-01-01")
    const empty = await registry.makeUser()
    expect(await findFirstTransactionDate(empty.id)).toBeNull()
    const world = await registry.makeWorld()
    await softDeleteTransaction(world.user.id, world.tx.id)
    expect(await findFirstTransactionDate(world.user.id)).toBeNull()
  })

  it("skips a deleted earlier entry", async () => {
    const world = await registry.makeWorld()
    const early = await registry.makeTransaction(world.user.id, world.bank.id, world.food.id, { occurredAt: "2025-05-05" })
    await softDeleteTransaction(world.user.id, early.id)
    expect(await findFirstTransactionDate(world.user.id)).toBe("2026-04-01")
  })
})

describe("countLiveTransactionsAfter", () => {
  it("counts live entries strictly after the day", async () => {
    const own = await flowScenario(registry)
    const after = calendarDate("2026-03-31")
    expect(await countLiveTransactionsAfter(own.user.id, after)).toBe(0)
    const future = addDays(todayIn(own.user.timezone), 10)
    const { Bank, Food } = own.nodes
    await registry.makeTransaction(own.user.id, Bank.id, Food.id, { occurredAt: future })
    expect(await countLiveTransactionsAfter(own.user.id, after)).toBe(1)
    const gone = await registry.makeTransaction(own.user.id, Bank.id, Food.id, { occurredAt: future, deletedAt: new Date() })
    expect(gone.deletedAt).not.toBeNull()
    expect(await countLiveTransactionsAfter(own.user.id, after)).toBe(1)
    // strictly after: an entry on the day itself is not counted
    await registry.makeTransaction(own.user.id, Bank.id, Food.id, { occurredAt: "2026-03-31" })
    expect(await countLiveTransactionsAfter(own.user.id, after)).toBe(1)
  })
})

describe("findFinancialYearStartMonth", () => {
  it("is 4 for a new user, the stored value once changed, and refuses an unknown id", async () => {
    const user = await registry.makeUser()
    expect(await findFinancialYearStartMonth(user.id)).toBe(4)
    await prisma.user.update({ where: { id: user.id }, data: { financialYearStartMonth: 1 } })
    expect(await findFinancialYearStartMonth(user.id)).toBe(1)
    expect(await findFinancialYearStartMonth("no-such-user").catch((e: unknown) => e)).toBeInstanceOf(UserNotFoundError)
  })
})
