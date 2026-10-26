import { randomUUID } from "node:crypto"
import { afterAll, describe, expect, it } from "vitest"
import { calendarDate, fromDbDate, toDbDate, type CalendarDate } from "@/domain/calendar-date"
import { prisma } from "@/server/db"
import { NotFoundError } from "@/server/repositories/errors"
import { listPrices } from "@/server/repositories/price-repository"
import { insertTransactions } from "@/server/repositories/transaction-repository"
import { getDashboard } from "@/server/services/balance-service"
import { todayFor } from "@/server/services/clock"
import { loadHolding, loadPortfolio, loadValuations, sellInvestment } from "@/server/services/investment-service"
import { loadNodeOverview } from "@/server/services/node-overview"
import { snapshotPriceResolver } from "@/server/services/price-resolver"
import { deletePrice, InvalidPriceError, previewRevaluation, recordPrice } from "@/server/services/price-service"
import { recordTransaction } from "@/server/services/transaction-service"
import { createRegistry } from "./repositories/fixtures"

// Prices, holdings and valuation from real rows (plan calls 6-9, EC-23..EC-26). Every expected figure is a literal worked
// out by hand, in paise, never computed with the code under test.

const registry = createRegistry()
afterAll(registry.cleanup)

const UNIT = 1_000_000n
const g = (grams: bigint) => grams * UNIT
const MAR_1 = calendarDate("2026-03-01")
const RS_7800 = 7_800_00n

type Node = { id: string }

/** `days` after (or, negative, before) `day`. */
function shift(day: CalendarDate, days: number): CalendarDate {
  const date = toDbDate(day)
  date.setUTCDate(date.getUTCDate() + days)
  return fromDbDate(date)
}

const buy = (userId: string, from: Node, to: Node, amount: bigint, quantity: bigint | undefined, day: string) =>
  recordTransaction(userId, {
    fromNodeId: from.id,
    toNodeId: to.id,
    amount,
    quantity,
    occurredAt: calendarDate(day),
    idempotencyKey: randomUUID(),
  })

/**
 * The Task 6 world: a bank holding Rs 2,00,000, the Realised Gain and Realised Loss nodes, a contribution-only fund with
 * nothing in it yet, and gold valued by quantity (FIFO) bought twice: 10g for Rs 70,000 on 1 Jan and 5g for Rs 37,000 on
 * 1 Feb. The bank then holds Rs 93,000 and the gold cost Rs 1,07,000.
 */
async function setup() {
  const user = await registry.makeUser()
  const income = await registry.makeNode(user.id, "INCOME_SOURCE", "Salary")
  const bank = await registry.makeNode(user.id, "ASSET", "Bank")
  const rent = await registry.makeNode(user.id, "EXPENSE", "Rent")
  await registry.makeNode(user.id, "INCOME_SOURCE", "Realised Gain", { systemRole: "REALISED_GAIN" })
  await registry.makeNode(user.id, "EXPENSE", "Realised Loss", { systemRole: "REALISED_LOSS" })
  const fund = await registry.makeNode(user.id, "INVESTMENT", "Index SIP", { valuationMode: "CONTRIBUTION_ONLY" })
  const gold = await registry.makeNode(user.id, "INVESTMENT", "Gold", { valuationMode: "QUANTITY", unitLabel: "g", lotMethod: "FIFO" })
  await registry.makeTransaction(user.id, income.id, bank.id, { amountPaise: 2_00_000_00n, occurredAt: "2025-12-01" })
  await buy(user.id, bank, gold, 70_000_00n, g(10n), "2026-01-01")
  await buy(user.id, bank, gold, 37_000_00n, g(5n), "2026-02-01")
  const today = await todayFor(user.id)
  return { user, income, bank, rent, fund, gold, today }
}

const priceGold = (world: { user: { id: string }; gold: Node }, pricePerUnit = RS_7800, asOf = MAR_1) =>
  recordPrice(world.user.id, { nodeId: world.gold.id, asOf, pricePerUnit })

/** Every value in the object, so a bigint or a Date anywhere in it is found. */
function typesIn(value: unknown): Set<string> {
  const found = new Set<string>([typeof value])
  if (value instanceof Date) found.add("Date")
  if (value !== null && typeof value === "object") for (const inner of Object.values(value)) typesIn(inner).forEach((t) => found.add(t))
  return found
}

describe("loadValuations", () => {
  it("values 15 g of gold at Rs 7,800 a gram as Rs 1,17,000, and lists only the investments valued by lot", async () => {
    const world = await setup()
    await priceGold(world)
    const valuations = await loadValuations(world.user.id, world.today)
    expect(valuations.get(world.gold.id)).toBe(1_17_000_00n)
    expect([...valuations.keys()]).toEqual([world.gold.id])
  })

  it("maps a held quantity with no price to null: not valued, never zero or cost (EC-23)", async () => {
    const world = await setup()
    const valuations = await loadValuations(world.user.id, world.today)
    expect(valuations.has(world.gold.id)).toBe(true)
    expect(valuations.get(world.gold.id)).toBeNull()
  })

  it("values a fully sold investment at nothing, priced or not", async () => {
    const world = await setup()
    await sellInvestment(world.user.id, {
      nodeId: world.gold.id,
      toNodeId: world.bank.id,
      quantity: g(15n),
      proceeds: 1_20_000_00n,
      occurredAt: MAR_1,
      idempotencyKey: randomUUID(),
    })
    expect((await loadValuations(world.user.id, world.today)).get(world.gold.id)).toBe(0n)
    await priceGold(world)
    expect((await loadValuations(world.user.id, world.today)).get(world.gold.id)).toBe(0n)
    const holding = await loadHolding(world.user.id, world.gold.id)
    expect(holding).toMatchObject({ quantityHeld: "0", valuePaise: "0", costBasisPaise: "0", notValued: null, lotCount: 2 })
  })

  it("maps an investment with an entry from before lots existed to null, as needing a quantity (call 7)", async () => {
    const world = await setup()
    await priceGold(world)
    // Straight through the repository: the service would refuse a purchase with no quantity.
    await insertTransactions(world.user.id, [
      { fromNodeId: world.bank.id, toNodeId: world.gold.id, amountPaise: 5_000_00n, occurredAt: calendarDate("2025-12-15") },
    ])
    expect((await loadValuations(world.user.id, world.today)).get(world.gold.id)).toBeNull()
    const holding = await loadHolding(world.user.id, world.gold.id)
    expect(holding).toMatchObject({
      notValued: "NEEDS_QUANTITY",
      valuePaise: null,
      unrealisedGainPaise: null,
      gainBasisPoints: null,
      quantityHeld: "15",
      price: { asOf: MAR_1, pricePerUnitPaise: "780000" },
    })
  })

  it("values as of a day: a lot bought after it is not held yet", async () => {
    const world = await setup()
    await priceGold(world, RS_7800, calendarDate("2026-01-15"))
    // On 20 Jan only the 10 g of 1 Jan is held.
    expect((await loadValuations(world.user.id, calendarDate("2026-01-20"))).get(world.gold.id)).toBe(78_000_00n)
    // Before any price, nothing values the 10 g.
    expect((await loadValuations(world.user.id, calendarDate("2026-01-10"))).get(world.gold.id)).toBeNull()
  })

  it("leaves a contribution-only investment out of the map, and its balance still counts in net worth", async () => {
    const world = await setup()
    await priceGold(world)
    await buy(world.user.id, world.bank, world.fund, 10_000_00n, undefined, "2026-02-15")
    expect((await loadValuations(world.user.id, world.today)).has(world.fund.id)).toBe(false)

    const view = await getDashboard(world.user.id)
    // Bank 2,00,000 - 70,000 - 37,000 - 10,000 = 83,000; fund 10,000 at cost; gold 1,17,000 at its price.
    expect(view.netWorth).toMatchObject({
      assets: "8300000",
      investments: "12700000",
      total: "21000000",
      isPartial: false,
      unvaluedNodeIds: [],
    })
  })
})

describe("loadHolding", () => {
  it("states quantity, cost, value, gain and the price, with each lot", async () => {
    const world = await setup()
    await priceGold(world)
    const holding = await loadHolding(world.user.id, world.gold.id)
    expect(holding).toMatchObject({
      nodeId: world.gold.id,
      name: "Gold",
      unitLabel: "g",
      valuationMode: "QUANTITY",
      archived: false,
      quantityHeld: "15",
      costBasisPaise: "10700000",
      valuePaise: "11700000",
      unrealisedGainPaise: "1000000",
      // 10,000 / 1,07,000 = 9.3458%.
      gainBasisPoints: 935,
      price: { asOf: MAR_1, pricePerUnitPaise: "780000" },
      notValued: null,
      lotCount: 2,
    })
    expect(holding.lots).toEqual([
      expect.objectContaining({ acquiredAt: "2026-01-01", quantity: "10", quantityRemaining: "10", costBasisPaise: "7000000", costBasisRemainingPaise: "7000000" }),
      expect.objectContaining({ acquiredAt: "2026-02-01", quantity: "5", quantityRemaining: "5", costBasisPaise: "3700000", costBasisRemainingPaise: "3700000" }),
    ])
    expect(holding.prices).toEqual([{ asOf: MAR_1, pricePerUnitPaise: "780000" }])
    expect(() => JSON.stringify(holding)).not.toThrow()
    expect(typesIn(holding)).not.toContain("bigint")
    expect(typesIn(holding)).not.toContain("Date")
  })

  it("shows what a sale left in each lot", async () => {
    const world = await setup()
    await priceGold(world)
    // 13 g FIFO: all 10 g of lot A (Rs 70,000) and 3 of lot B's 5 (Rs 22,200).
    await sellInvestment(world.user.id, {
      nodeId: world.gold.id,
      toNodeId: world.bank.id,
      quantity: g(13n),
      proceeds: 1_00_000_00n,
      occurredAt: MAR_1,
      idempotencyKey: randomUUID(),
    })
    const holding = await loadHolding(world.user.id, world.gold.id)
    expect(holding).toMatchObject({ quantityHeld: "2", costBasisPaise: "1480000", valuePaise: "1560000", unrealisedGainPaise: "80000" })
    expect(holding.lots.map((lot) => [lot.quantityRemaining, lot.costBasisRemainingPaise])).toEqual([
      ["0", "0"],
      ["2", "1480000"],
    ])
  })

  it("flags a price older than the window as stale: the node's own window first, else the user's (call 9)", async () => {
    const world = await setup()
    await priceGold(world, RS_7800, shift(world.today, -31))
    const stale = async () => (await loadHolding(world.user.id, world.gold.id)).price?.stale

    // The user's default window, 30 days: 31 days old is stale.
    expect(await stale()).toBe(true)
    await prisma.ledgerNode.update({ where: { id: world.gold.id }, data: { stalePriceDays: 30 } })
    expect(await stale()).toBe(true)
    await prisma.ledgerNode.update({ where: { id: world.gold.id }, data: { stalePriceDays: 400 } })
    expect(await stale()).toBe(false)

    // With no override, the user's own window decides.
    await prisma.ledgerNode.update({ where: { id: world.gold.id }, data: { stalePriceDays: null } })
    await prisma.user.update({ where: { id: world.user.id }, data: { stalePriceDays: 400 } })
    expect(await stale()).toBe(false)
  })

  it("does not call a price exactly as old as the window stale", async () => {
    const world = await setup()
    await priceGold(world, RS_7800, shift(world.today, -30))
    expect((await loadHolding(world.user.id, world.gold.id)).price?.stale).toBe(false)
  })

  it("reports a held quantity with no price as not valued for want of a price", async () => {
    const world = await setup()
    const holding = await loadHolding(world.user.id, world.gold.id)
    expect(holding).toMatchObject({ notValued: "NO_PRICE", valuePaise: null, price: null, quantityHeld: "15", costBasisPaise: "10700000" })
  })

  it("is not found for another user's investment (EC-8)", async () => {
    const world = await setup()
    const stranger = await registry.makeUser()
    await expect(loadHolding(stranger.id, world.gold.id)).rejects.toBeInstanceOf(NotFoundError)
  })
})

describe("loadPortfolio", () => {
  it("lists every investment, and its totals are the sum of its rows", async () => {
    const world = await setup()
    await priceGold(world)
    await buy(world.user.id, world.bank, world.fund, 10_000_00n, undefined, "2026-02-15")
    const silver = await registry.makeNode(world.user.id, "INVESTMENT", "Silver", { valuationMode: "QUANTITY", unitLabel: "g" })
    await buy(world.user.id, world.bank, silver, 14_000_00n, g(2n), "2026-02-20") // no price: not valued

    const portfolio = await loadPortfolio(world.user.id)

    const byName = Object.fromEntries(portfolio.holdings.map((h) => [h.name, h]))
    expect(Object.keys(byName).sort()).toEqual(["Gold", "Index SIP", "Silver"])
    expect(byName.Gold).toMatchObject({ costBasisPaise: "10700000", valuePaise: "11700000", unrealisedGainPaise: "1000000" })
    expect(byName.Silver).toMatchObject({ costBasisPaise: "1400000", valuePaise: null, notValued: "NO_PRICE" })
    // A contribution-only investment is worth what was put in: it is not revalued.
    expect(byName["Index SIP"]).toMatchObject({
      valuationMode: "CONTRIBUTION_ONLY",
      costBasisPaise: "1000000",
      valuePaise: "1000000",
      unrealisedGainPaise: "0",
      price: null,
      notValued: null,
      lotCount: 0,
    })

    // Put in: 1,07,000 + 14,000 + 10,000. Worth, of what can be valued: 1,17,000 + 10,000. Gain on that: 10,000.
    expect(portfolio.totals).toEqual({ contributedPaise: "13100000", valuePaise: "12700000", unrealisedGainPaise: "1000000", notValuedCount: 1 })
    const sum = (pick: (h: (typeof portfolio.holdings)[number]) => string | null) =>
      String(portfolio.holdings.reduce((total, h) => total + BigInt(pick(h) ?? "0"), 0n))
    expect(portfolio.totals.contributedPaise).toBe(sum((h) => h.costBasisPaise))
    expect(portfolio.totals.valuePaise).toBe(sum((h) => h.valuePaise))
    expect(portfolio.totals.unrealisedGainPaise).toBe(sum((h) => h.unrealisedGainPaise))
    expect(portfolio.totals.notValuedCount).toBe(portfolio.holdings.filter((h) => h.notValued !== null).length)

    expect(() => JSON.stringify(portfolio)).not.toThrow()
    expect(typesIn(portfolio)).not.toContain("bigint")
    expect(typesIn(portfolio)).not.toContain("Date")
  })

  it("does not list another user's investments", async () => {
    const world = await setup()
    const stranger = await registry.makeUser()
    expect((await loadPortfolio(stranger.id)).holdings).toEqual([])
    expect((await loadPortfolio(world.user.id)).holdings.map((h) => h.name).sort()).toEqual(["Gold", "Index SIP"])
  })
})

describe("recordPrice and deletePrice", () => {
  it("overwrites the price of a day entered twice (EC-26)", async () => {
    const world = await setup()
    await priceGold(world, RS_7800)
    await priceGold(world, 8_000_00n)
    expect(await listPrices(world.user.id, world.gold.id)).toEqual([{ asOf: MAR_1, pricePerUnitPaise: 8_000_00n }])
    expect((await loadValuations(world.user.id, world.today)).get(world.gold.id)).toBe(1_20_000_00n)
  })

  it("accepts today and any earlier day, even one before the latest price, which still decides the value (call 8, EC-25)", async () => {
    const world = await setup()
    await priceGold(world, RS_7800, world.today)
    await priceGold(world, 9_000_00n, calendarDate("2026-02-15"))
    expect(await listPrices(world.user.id, world.gold.id)).toHaveLength(2)
    expect((await loadValuations(world.user.id, world.today)).get(world.gold.id)).toBe(1_17_000_00n)
  })

  it("refuses a price dated after today, and writes nothing (call 8)", async () => {
    const world = await setup()
    const tomorrow = shift(world.today, 1)
    await expect(priceGold(world, RS_7800, tomorrow)).rejects.toBeInstanceOf(InvalidPriceError)
    await expect(priceGold(world, RS_7800, tomorrow)).rejects.toMatchObject({ code: "PRICE_AFTER_TODAY" })
    expect(await listPrices(world.user.id, world.gold.id)).toEqual([])
  })

  it("refuses a price of zero", async () => {
    const world = await setup()
    await expect(priceGold(world, 0n)).rejects.toMatchObject({ code: "PRICE_NOT_POSITIVE" })
    expect(await listPrices(world.user.id, world.gold.id)).toEqual([])
  })

  it("refuses to price an investment valued by what was put into it, or anything that is not an investment", async () => {
    const world = await setup()
    const refused = recordPrice(world.user.id, { nodeId: world.fund.id, asOf: MAR_1, pricePerUnit: RS_7800 })
    await expect(refused).rejects.toBeInstanceOf(InvalidPriceError)
    await expect(refused).rejects.toThrow("This investment is not revalued")
    await expect(recordPrice(world.user.id, { nodeId: world.bank.id, asOf: MAR_1, pricePerUnit: RS_7800 })).rejects.toMatchObject({
      code: "NOT_REVALUED",
    })
    expect(await prisma.priceSnapshot.count({ where: { userId: world.user.id } })).toBe(0)
  })

  it("is not found for another user's investment, and touches nothing of theirs (EC-8)", async () => {
    const world = await setup()
    await priceGold(world)
    const stranger = await registry.makeUser()
    const input = { nodeId: world.gold.id, asOf: MAR_1, pricePerUnit: 1n }
    await expect(recordPrice(stranger.id, input)).rejects.toBeInstanceOf(NotFoundError)
    await expect(previewRevaluation(stranger.id, input)).rejects.toBeInstanceOf(NotFoundError)
    await expect(deletePrice(stranger.id, world.gold.id, MAR_1)).rejects.toBeInstanceOf(NotFoundError)
    expect(await listPrices(world.user.id, world.gold.id)).toEqual([{ asOf: MAR_1, pricePerUnitPaise: RS_7800 }])
  })

  it("deletes a day's price, leaving the holding not valued once it was the only one", async () => {
    const world = await setup()
    await priceGold(world)
    await deletePrice(world.user.id, world.gold.id, MAR_1)
    expect(await listPrices(world.user.id, world.gold.id)).toEqual([])
    expect((await loadHolding(world.user.id, world.gold.id)).notValued).toBe("NO_PRICE")
    await expect(deletePrice(world.user.id, world.gold.id, MAR_1)).rejects.toBeInstanceOf(NotFoundError)
  })

  it("is what the snapshot resolver reads (the seam of spec §7.4)", async () => {
    const world = await setup()
    await priceGold(world, 8_000_00n, calendarDate("2026-04-01"))
    await priceGold(world, RS_7800)
    expect(await snapshotPriceResolver.pricesFor(world.user.id, world.gold.id)).toEqual([
      { asOf: MAR_1, pricePerUnitPaise: RS_7800 },
      { asOf: calendarDate("2026-04-01"), pricePerUnitPaise: 8_000_00n },
    ])
  })
})

describe("previewRevaluation", () => {
  it("states the value before and after a first price, and writes nothing", async () => {
    const world = await setup()
    const input = { nodeId: world.gold.id, asOf: MAR_1, pricePerUnit: RS_7800 }
    expect(await previewRevaluation(world.user.id, input)).toEqual({ beforePaise: null, afterPaise: 1_17_000_00n, changePaise: null })
    expect(await prisma.priceSnapshot.count({ where: { userId: world.user.id } })).toBe(0)
  })

  it("states the change a new price makes to today's value", async () => {
    const world = await setup()
    await priceGold(world)
    const preview = await previewRevaluation(world.user.id, { nodeId: world.gold.id, asOf: world.today, pricePerUnit: 8_000_00n })
    expect(preview).toEqual({ beforePaise: 1_17_000_00n, afterPaise: 1_20_000_00n, changePaise: 3_000_00n })
    expect(await listPrices(world.user.id, world.gold.id)).toEqual([{ asOf: MAR_1, pricePerUnitPaise: RS_7800 }])
  })

  it("shows no change for a price dated before the one that values the holding today", async () => {
    const world = await setup()
    await priceGold(world)
    const preview = await previewRevaluation(world.user.id, { nodeId: world.gold.id, asOf: calendarDate("2026-02-15"), pricePerUnit: 9_000_00n })
    expect(preview).toEqual({ beforePaise: 1_17_000_00n, afterPaise: 1_17_000_00n, changePaise: 0n })
  })

  it("replaces the price of the same day, as saving would", async () => {
    const world = await setup()
    await priceGold(world)
    const preview = await previewRevaluation(world.user.id, { nodeId: world.gold.id, asOf: MAR_1, pricePerUnit: 7_000_00n })
    expect(preview).toEqual({ beforePaise: 1_17_000_00n, afterPaise: 1_05_000_00n, changePaise: -12_000_00n })
  })

  it("has no value after either for an investment that needs a quantity: a price does not value it (call 7)", async () => {
    const world = await setup()
    await insertTransactions(world.user.id, [
      { fromNodeId: world.bank.id, toNodeId: world.gold.id, amountPaise: 5_000_00n, occurredAt: calendarDate("2025-12-15") },
    ])
    const preview = await previewRevaluation(world.user.id, { nodeId: world.gold.id, asOf: MAR_1, pricePerUnit: RS_7800 })
    expect(preview).toEqual({ beforePaise: null, afterPaise: null, changePaise: null })
  })

  it("refuses what recording would refuse", async () => {
    const world = await setup()
    await expect(
      previewRevaluation(world.user.id, { nodeId: world.gold.id, asOf: shift(world.today, 1), pricePerUnit: RS_7800 }),
    ).rejects.toMatchObject({ code: "PRICE_AFTER_TODAY" })
    await expect(previewRevaluation(world.user.id, { nodeId: world.fund.id, asOf: MAR_1, pricePerUnit: RS_7800 })).rejects.toMatchObject({
      code: "NOT_REVALUED",
    })
  })
})

describe("net worth with valuations", () => {
  it("on the dashboard: an unvalued investment makes the figure partial, is named, and is left out of the total", async () => {
    const world = await setup()
    const view = await getDashboard(world.user.id)
    // Only the bank's Rs 93,000: the gold has no price.
    expect(view.netWorth).toMatchObject({
      total: "9300000",
      investments: "0",
      isPartial: true,
      unvaluedNodeIds: [world.gold.id],
      unvaluedNames: ["Gold"],
    })
    expect(view.accounts.find((a) => a.name === "Gold")).toMatchObject({ balance: "0", notValued: "NO_PRICE" })
  })

  it("on the dashboard: a priced investment counts at its value, today and in the projection (call 6)", async () => {
    const world = await setup()
    await priceGold(world)
    await recordTransaction(world.user.id, {
      fromNodeId: world.bank.id,
      toNodeId: world.rent.id,
      amount: 1_000_00n,
      occurredAt: calendarDate("2099-01-01"),
      idempotencyKey: randomUUID(),
    })
    const view = await getDashboard(world.user.id)
    // 93,000 in the bank and 1,17,000 of gold; then 1,000 of rent in 2099.
    expect(view.netWorth).toMatchObject({ total: "21000000", investments: "11700000", isPartial: false })
    expect(view.accounts.find((a) => a.name === "Gold")).toMatchObject({ balance: "11700000", notValued: null })
    expect(view.kindTotals.find((k) => k.kind === "INVESTMENT")?.total).toBe("11700000")
    expect(view.projected).toEqual({ total: "20900000", asOf: "2099-01-01" })
  })

  it("on the ledger: a lot-mode investment's balance and kind total are its value, or 0 with the reason when not valued", async () => {
    const world = await setup()
    await buy(world.user.id, world.bank, world.fund, 10_000_00n, undefined, "2026-02-15")

    const unpriced = await loadNodeOverview(world.user.id)
    expect(unpriced.balances[world.gold.id]).toBe("0")
    expect(unpriced.unvalued).toEqual({ [world.gold.id]: "NO_PRICE" })
    expect(unpriced.kinds.INVESTMENT.total).toBe("1000000") // the fund only
    expect(unpriced.netWorth).toMatchObject({ isPartial: true, unvaluedNodeIds: [world.gold.id], total: "9300000" })

    await priceGold(world)
    const priced = await loadNodeOverview(world.user.id)
    expect(priced.balances[world.gold.id]).toBe("11700000")
    expect(priced.balances[world.fund.id]).toBe("1000000")
    expect(priced.unvalued).toEqual({})
    expect(priced.kinds.INVESTMENT.total).toBe("12700000")
    expect(priced.netWorth).toMatchObject({ isPartial: false, total: "21000000", investments: "12700000" })
  })

  it("on the ledger: an investment that needs a quantity says so", async () => {
    const world = await setup()
    await priceGold(world)
    await insertTransactions(world.user.id, [
      { fromNodeId: world.bank.id, toNodeId: world.gold.id, amountPaise: 5_000_00n, occurredAt: calendarDate("2025-12-15") },
    ])
    const overview = await loadNodeOverview(world.user.id)
    expect(overview.unvalued).toEqual({ [world.gold.id]: "NEEDS_QUANTITY" })
    expect(overview.balances[world.gold.id]).toBe("0")
  })
})
