import { randomUUID } from "node:crypto"
import { afterAll, describe, expect, it } from "vitest"
import { calendarDate } from "@/domain/calendar-date"
import { InsufficientQuantityError } from "@/domain/lots"
import { openLots } from "@/domain/valuation"
import { prisma } from "@/server/db"
import { NotFoundError } from "@/server/repositories/errors"
import { findLiveLots } from "@/server/repositories/lot-repository"
import { sumBalances } from "@/server/repositories/transaction-repository"
import { previewSale, sellInvestment, type SellInput } from "@/server/services/investment-service"
import { archiveLedgerNode } from "@/server/services/node-service"
import {
  editTransaction,
  InvalidTransactionError,
  LotInUseError,
  recordTransaction,
  removeTransaction,
  RequestKeyConflictError,
  restoreTransaction,
  ungroupTransaction,
} from "@/server/services/transaction-service"
import { createRegistry } from "./repositories/fixtures"

const registry = createRegistry()
afterAll(registry.cleanup)

const UNIT = 1_000_000n
const g = (grams: bigint) => grams * UNIT
const MAR_1 = calendarDate("2026-03-01")

type Node = { id: string }

/**
 * Account A: income, a bank holding Rs 2,00,000, the system Realised Gain and Realised Loss nodes, and gold valued by
 * quantity (FIFO unless `lotMethod` says otherwise) bought twice through the generic path: 10g for Rs 70,000 on 1 Jan
 * (lot A) and 5g for Rs 37,000 on 1 Feb (lot B).
 */
async function setup(lotMethod: "FIFO" | "LIFO" | "HIGHEST_COST_FIRST" | null = "FIFO") {
  const user = await registry.makeUser()
  const income = await registry.makeNode(user.id, "INCOME_SOURCE", "Salary")
  const bank = await registry.makeNode(user.id, "ASSET", "Bank")
  const food = await registry.makeNode(user.id, "EXPENSE", "Food")
  const fund = await registry.makeNode(user.id, "INVESTMENT", "Index SIP", { valuationMode: "CONTRIBUTION_ONLY" })
  const silver = await registry.makeNode(user.id, "INVESTMENT", "Silver", { valuationMode: "QUANTITY", unitLabel: "g" })
  const gain = await registry.makeNode(user.id, "INCOME_SOURCE", "Realised Gain", { systemRole: "REALISED_GAIN" })
  const loss = await registry.makeNode(user.id, "EXPENSE", "Realised Loss", { systemRole: "REALISED_LOSS" })
  const gold = await registry.makeNode(user.id, "INVESTMENT", "Gold", { valuationMode: "QUANTITY", unitLabel: "g", lotMethod })
  await registry.makeTransaction(user.id, income.id, bank.id, { amountPaise: 2_00_000_00n, occurredAt: "2025-12-01" })
  const buyA = await buy(user.id, bank, gold, 70_000_00n, g(10n), "2026-01-01")
  const buyB = await buy(user.id, bank, gold, 37_000_00n, g(5n), "2026-02-01")
  return { user, income, bank, food, fund, silver, gain, loss, gold, buyA, buyB }
}

const buy = (userId: string, from: Node, to: Node, amount: bigint, quantity: bigint, day: string) =>
  recordTransaction(userId, {
    fromNodeId: from.id,
    toNodeId: to.id,
    amount,
    quantity,
    occurredAt: calendarDate(day),
    idempotencyKey: randomUUID(),
  })

type World = Awaited<ReturnType<typeof setup>>

const saleOf = (world: World, quantity: bigint, proceeds: bigint, over: Partial<SellInput> = {}): SellInput => ({
  nodeId: world.gold.id,
  toNodeId: world.bank.id,
  quantity,
  proceeds,
  occurredAt: MAR_1,
  idempotencyKey: randomUUID(),
  ...over,
})

const sell = (world: World, quantity: bigint, proceeds: bigint, over: Partial<SellInput> = {}) =>
  sellInvestment(world.user.id, saleOf(world, quantity, proceeds, over))

async function balanceOf(userId: string, node: Node): Promise<bigint> {
  const row = (await sumBalances(userId)).find((b) => b.nodeId === node.id)
  if (!row) throw new Error("no such node")
  return row.balance
}

/** What each live lot of `node` still holds, oldest first: [remaining quantity, remaining cost basis]. */
async function remaining(userId: string, node: Node): Promise<[bigint, bigint][]> {
  const lots = await findLiveLots(userId, node.id)
  return lots.map((lot) => {
    const [open] = openLots([lot])
    return open ? [open.quantityRemaining, open.costBasisRemainingPaise] : [0n, 0n]
  })
}

const counts = async (userId: string) => ({
  transactions: await prisma.transaction.count({ where: { userId } }),
  live: await prisma.transaction.count({ where: { userId, deletedAt: null } }),
  groups: await prisma.transactionGroup.count({ where: { userId } }),
  consumptions: await prisma.lotConsumption.count({ where: { userId } }),
})

const legShape = (legs: { fromNodeId: string; toNodeId: string; amountPaise: string }[]) =>
  legs.map((leg) => [leg.fromNodeId, leg.toNodeId, leg.amountPaise])

const violationCodes = (error: unknown) => (error as InvalidTransactionError).violations.map((v) => v.code)

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected a rejection")
    },
    (error: unknown) => error,
  )
}

describe("sellInvestment", () => {
  it("posts a gain as a DISPOSAL group: the cost-basis leg and a Realised Gain leg (spec §7.5)", async () => {
    const world = await setup()
    const { user, bank, gold, gain } = world
    const bankBefore = await balanceOf(user.id, bank)
    expect(await balanceOf(user.id, gold)).toBe(1_07_000_00n)

    const { legs, preview } = await sell(world, g(8n), 68_000_00n, { note: "  Diwali  " })

    expect(legShape(legs)).toEqual([
      [gold.id, bank.id, "5600000"],
      [gain.id, bank.id, "1200000"],
    ])
    expect(legs.every((leg) => leg.occurredAt === MAR_1 && leg.note === "Diwali")).toBe(true)
    const groupId = legs[0].groupId
    expect(groupId).not.toBeNull()
    expect(legs[1].groupId).toBe(groupId)
    expect(await prisma.transactionGroup.findUniqueOrThrow({ where: { id: groupId ?? "" } })).toMatchObject({
      userId: user.id,
      kind: "DISPOSAL",
    })
    expect(preview).toEqual({
      costBasisPaise: 56_000_00n,
      proceedsPaise: 68_000_00n,
      gainPaise: 12_000_00n,
      allocations: [{ acquiredAt: "2026-01-01", quantity: g(8n), costBasisPaise: 56_000_00n }],
    })

    // lot A has 2g left at Rs 14,000; lot B is untouched
    expect(await remaining(user.id, gold)).toEqual([
      [g(2n), 14_000_00n],
      [g(5n), 37_000_00n],
    ])
    expect((await balanceOf(user.id, bank)) - bankBefore).toBe(68_000_00n)
    // the investment's contribution balance falls by the cost basis only: Rs 51,000 of Rs 1,07,000 is left
    expect(await balanceOf(user.id, gold)).toBe(51_000_00n)
    expect(await balanceOf(user.id, gain)).toBe(-12_000_00n)
    // one consumption row, on the cost-basis leg
    const consumptions = await prisma.lotConsumption.findMany({ where: { userId: user.id } })
    expect(consumptions).toHaveLength(1)
    expect(consumptions[0]).toMatchObject({ transactionId: legs[0].id, costBasisPaise: 56_000_00n })
    expect(consumptions[0].quantity.toString()).toBe("8")
  })

  it("posts a loss as the proceeds leg and a Realised Loss leg (spec §7.5)", async () => {
    const world = await setup()
    const { user, bank, gold, loss } = world
    const bankBefore = await balanceOf(user.id, bank)
    const { legs, preview } = await sell(world, g(8n), 50_000_00n)
    expect(legShape(legs)).toEqual([
      [gold.id, bank.id, "5000000"],
      [gold.id, loss.id, "600000"],
    ])
    expect(legs[0].groupId).not.toBeNull()
    expect(legs[1].groupId).toBe(legs[0].groupId)
    expect(preview).toMatchObject({ costBasisPaise: 56_000_00n, proceedsPaise: 50_000_00n, gainPaise: -6_000_00n })
    expect((await balanceOf(user.id, bank)) - bankBefore).toBe(50_000_00n)
    expect(await balanceOf(user.id, gold)).toBe(51_000_00n)
    expect(await balanceOf(user.id, loss)).toBe(6_000_00n)
    const consumptions = await prisma.lotConsumption.findMany({ where: { userId: user.id } })
    expect(consumptions.map((c) => [c.transactionId, c.costBasisPaise])).toEqual([[legs[0].id, 56_000_00n]])
  })

  it("posts a break-even sale as one transaction in no group, with the consumption on it", async () => {
    const world = await setup()
    const { user, bank, gold } = world
    const before = await counts(user.id)
    const { legs, preview } = await sell(world, g(8n), 56_000_00n)
    expect(legShape(legs)).toEqual([[gold.id, bank.id, "5600000"]])
    expect(legs[0].groupId).toBeNull()
    expect(preview.gainPaise).toBe(0n)
    expect(await counts(user.id)).toEqual({
      transactions: before.transactions + 1,
      live: before.live + 1,
      groups: before.groups,
      consumptions: 1,
    })
    expect(await prisma.lotConsumption.findFirstOrThrow({ where: { userId: user.id } })).toMatchObject({ transactionId: legs[0].id })
    expect(await remaining(user.id, gold)).toEqual([
      [g(2n), 14_000_00n],
      [g(5n), 37_000_00n],
    ])
  })

  it("spans lots: 13g takes all of lot A and 3g of lot B for a cost basis of Rs 92,200 (spec §7.5)", async () => {
    const world = await setup()
    const { user, gold } = world
    const { legs, preview } = await sell(world, g(13n), 95_000_00n)
    expect(preview).toEqual({
      costBasisPaise: 92_200_00n,
      proceedsPaise: 95_000_00n,
      gainPaise: 2_800_00n,
      allocations: [
        { acquiredAt: "2026-01-01", quantity: g(10n), costBasisPaise: 70_000_00n },
        { acquiredAt: "2026-02-01", quantity: g(3n), costBasisPaise: 22_200_00n },
      ],
    })
    expect(legs[0].amountPaise).toBe("9220000")
    // lot A is empty; lot B has 2g left at the rest of its cost
    expect(await remaining(user.id, gold)).toEqual([
      [0n, 0n],
      [g(2n), 14_800_00n],
    ])
    const consumptions = await prisma.lotConsumption.findMany({ where: { userId: user.id } })
    expect(consumptions.every((c) => c.transactionId === legs[0].id)).toBe(true)
    expect(consumptions.map((c) => c.costBasisPaise).sort()).toEqual([22_200_00n, 70_000_00n])
  })

  it("takes from the newest lot first when the investment is LIFO", async () => {
    const world = await setup("LIFO")
    const { preview } = await sell(world, g(8n), 60_000_00n)
    expect(preview.allocations).toEqual([
      { acquiredAt: "2026-02-01", quantity: g(5n), costBasisPaise: 37_000_00n },
      { acquiredAt: "2026-01-01", quantity: g(3n), costBasisPaise: 21_000_00n },
    ])
    expect(preview.costBasisPaise).toBe(58_000_00n)
    expect(await remaining(world.user.id, world.gold)).toEqual([
      [g(7n), 49_000_00n],
      [0n, 0n],
    ])
  })

  it("is FIFO when the investment names no lot method", async () => {
    const world = await setup(null)
    const { preview } = await sell(world, g(8n), 60_000_00n)
    expect(preview.allocations).toEqual([{ acquiredAt: "2026-01-01", quantity: g(8n), costBasisPaise: 56_000_00n }])
  })

  it("lets a sale leg be neither edited nor taken out of its group", async () => {
    const world = await setup()
    const { legs } = await sell(world, g(8n), 68_000_00n)
    for (const leg of legs) {
      const error = await rejection(editTransaction(world.user.id, leg.id, { note: "typo" }, leg.version))
      expect((error as InvalidTransactionError).message).toBe("A sale is deleted and entered again, not edited.")
      expect(await rejection(ungroupTransaction(world.user.id, leg.id))).toBeInstanceOf(InvalidTransactionError)
    }
  })

  it("sells two at once without taking the same grams twice", async () => {
    // 15g are held; each sale asks for 8g. Whichever commits second must see the first and be refused.
    const world = await setup()
    const results = await Promise.allSettled([sell(world, g(8n), 60_000_00n), sell(world, g(8n), 60_000_00n)])
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"])
    const refused = results.find((r) => r.status === "rejected")
    expect((refused as PromiseRejectedResult).reason).toBeInstanceOf(InsufficientQuantityError)
    const held = (await remaining(world.user.id, world.gold)).reduce((sum, [quantity]) => sum + quantity, 0n)
    expect(held).toBe(g(7n))
  })
})

describe("sellInvestment refuses, writing nothing", () => {
  async function expectNothingWritten(world: World, attempt: () => Promise<unknown>): Promise<unknown> {
    const before = await counts(world.user.id)
    const lotsBefore = await remaining(world.user.id, world.gold)
    const error = await rejection(attempt())
    expect(await counts(world.user.id)).toEqual(before)
    expect(await remaining(world.user.id, world.gold)).toEqual(lotsBefore)
    return error
  }

  it("more than is held, stating the quantity available in grams (EC-21)", async () => {
    const world = await setup()
    const error = await expectNothingWritten(world, () => sell(world, g(16n), 1_20_000_00n))
    expect(error).toBeInstanceOf(InsufficientQuantityError)
    expect((error as InsufficientQuantityError).available).toBe(g(15n))
    expect((error as InsufficientQuantityError).requested).toBe(g(16n))
    expect((error as InsufficientQuantityError).message).toBe(
      "Only 15 g of Gold is available to sell on 2026-03-01, so 16 g cannot be sold.",
    )
  })

  it("states fractional quantities in units, not micro-units", async () => {
    const world = await setup()
    await sell(world, 14_250_000n, 1_00_000_00n) // 14.25g sold; 0.75g left
    const error = await rejection(sell(world, 1_500_000n, 10_000_00n))
    expect((error as InsufficientQuantityError).message).toBe(
      "Only 0.75 g of Gold is available to sell on 2026-03-01, so 1.5 g cannot be sold.",
    )
  })

  it("more than was held on the sale's own day: only the lots bought by then count (call 6)", async () => {
    const world = await setup()
    const error = await expectNothingWritten(world, () => sell(world, g(12n), 90_000_00n, { occurredAt: calendarDate("2026-01-15") }))
    expect(error).toBeInstanceOf(InsufficientQuantityError)
    expect((error as InsufficientQuantityError).available).toBe(g(10n))
    expect((error as InsufficientQuantityError).message).toContain("Only 10 g of Gold is available to sell on 2026-01-15")
  })

  it.each([0n, -1n, -g(1n), 10n ** 18n])("a quantity of %s micro-units", async (quantity) => {
    const world = await setup()
    const error = await expectNothingWritten(world, () => sell(world, quantity, 1_000_00n))
    expect(violationCodes(error)).toEqual(["QUANTITY_OUT_OF_RANGE"])
  })

  it.each([0n, -1n])("proceeds of %s paise", async (proceeds) => {
    const world = await setup()
    const error = await expectNothingWritten(world, () => sell(world, g(1n), proceeds))
    expect(violationCodes(error)).toEqual(["NON_POSITIVE_AMOUNT"])
  })

  it("a destination that is an expense, an investment or an income source", async () => {
    const world = await setup()
    for (const destination of [world.food, world.silver, world.fund, world.income, world.gold]) {
      const error = await expectNothingWritten(world, () => sell(world, g(1n), 7_000_00n, { toNodeId: destination.id }))
      expect(error).toBeInstanceOf(InvalidTransactionError)
      expect(violationCodes(error)).toEqual(["SALE_DESTINATION"])
    }
  })

  it("an archived destination, and an archived investment (EC-14)", async () => {
    const world = await setup()
    const old = await registry.makeNode(world.user.id, "ASSET", "Old bank")
    await archiveLedgerNode(world.user.id, old.id)
    const toArchived = await expectNothingWritten(world, () => sell(world, g(1n), 7_000_00n, { toNodeId: old.id }))
    expect(violationCodes(toArchived)).toEqual(["ARCHIVED_TARGET"])

    await archiveLedgerNode(world.user.id, world.gold.id)
    const fromArchived = await expectNothingWritten(world, () => sell(world, g(1n), 7_000_00n))
    expect(violationCodes(fromArchived)).toEqual(["ARCHIVED_SOURCE"])
  })

  it("an investment valued by contribution, which has no lots: it is an ordinary transaction (EC-28)", async () => {
    const world = await setup()
    const error = await expectNothingWritten(world, () => sell(world, g(1n), 7_000_00n, { nodeId: world.fund.id }))
    expect(error).toBeInstanceOf(InvalidTransactionError)
    expect(violationCodes(error)).toEqual(["NOT_SOLD_BY_LOT"])
    expect((error as InvalidTransactionError).message).toContain("Record this as an ordinary transaction")
  })

  it("a node that is not an investment", async () => {
    const world = await setup()
    const error = await expectNothingWritten(world, () => sell(world, g(1n), 7_000_00n, { nodeId: world.bank.id, toNodeId: world.food.id }))
    expect(violationCodes(error)).toContain("NOT_SOLD_BY_LOT")
  })

  it("another user's investment or account is not found (EC-8)", async () => {
    const world = await setup()
    const other = await setup()
    const theirGold = await expectNothingWritten(world, () => sell(world, g(1n), 7_000_00n, { nodeId: other.gold.id }))
    expect(theirGold).toBeInstanceOf(NotFoundError)
    const theirBank = await expectNothingWritten(world, () => sell(world, g(1n), 7_000_00n, { toNodeId: other.bank.id }))
    expect(theirBank).toBeInstanceOf(NotFoundError)
    // and their lots are untouched
    expect(await remaining(other.user.id, other.gold)).toEqual([
      [g(10n), 70_000_00n],
      [g(5n), 37_000_00n],
    ])
  })

  it("a quantity whose cost rounds to nothing, which no leg could carry", async () => {
    const world = await setup()
    // 1g of silver for 10 paise: a millionth of a gram costs a hundred-thousandth of a paisa, which rounds to 0
    await buy(world.user.id, world.bank, world.silver, 10n, g(1n), "2026-01-01")
    const before = await counts(world.user.id)
    const error = await rejection(sell(world, 1n, 1n, { nodeId: world.silver.id }))
    expect(await counts(world.user.id)).toEqual(before)
    expect(violationCodes(error)).toEqual(["QUANTITY_TOO_SMALL"])
    expect((error as InvalidTransactionError).message).toContain("0.000001 g of Silver")
    // a quantity whose cost is at least a paisa sells
    const { preview } = await sell(world, 100_000n, 5n, { nodeId: world.silver.id })
    expect(preview).toMatchObject({ costBasisPaise: 1n, proceedsPaise: 5n, gainPaise: 4n })
  })
})

describe("selling a lump investment", () => {
  async function plotWorld() {
    const world = await setup()
    const plot = await registry.makeNode(world.user.id, "INVESTMENT", "Plot", { valuationMode: "LUMP", unitLabel: "plot" })
    await registry.makeTransaction(world.user.id, world.income.id, world.bank.id, { amountPaise: 10_00_000_00n, occurredAt: "2025-12-01" })
    await buy(world.user.id, world.bank, plot, 10_00_000_00n, UNIT, "2026-01-10")
    return { ...world, plot }
  }

  it("refuses any quantity but 1, writing nothing", async () => {
    const world = await plotWorld()
    const before = await counts(world.user.id)
    for (const quantity of [500_000n, g(2n)]) {
      const error = await rejection(sell(world, quantity, 12_00_000_00n, { nodeId: world.plot.id }))
      expect(violationCodes(error)).toEqual(["LUMP_QUANTITY"])
    }
    expect(await counts(world.user.id)).toEqual(before)
  })

  it("sells the whole of it as 1 unit", async () => {
    const world = await plotWorld()
    const { legs, preview } = await sell(world, UNIT, 12_00_000_00n, { nodeId: world.plot.id })
    expect(legShape(legs)).toEqual([
      [world.plot.id, world.bank.id, "100000000"],
      [world.gain.id, world.bank.id, "20000000"],
    ])
    expect(preview).toEqual({
      costBasisPaise: 10_00_000_00n,
      proceedsPaise: 12_00_000_00n,
      gainPaise: 2_00_000_00n,
      allocations: [{ acquiredAt: "2026-01-10", quantity: UNIT, costBasisPaise: 10_00_000_00n }],
    })
    expect(await balanceOf(world.user.id, world.plot)).toBe(0n)
    expect(await remaining(world.user.id, world.plot)).toEqual([[0n, 0n]])
  })
})

describe("sellInvestment idempotency (EC-17)", () => {
  it.each([
    ["a gain", 68_000_00n],
    ["a loss", 50_000_00n],
    ["break-even", 56_000_00n],
  ])("returns the stored sale for a replay of %s, writing nothing more", async (_, proceeds) => {
    const world = await setup()
    const input = saleOf(world, g(8n), proceeds)
    const first = await sellInvestment(world.user.id, input)
    const after = await counts(world.user.id)
    const replay = await sellInvestment(world.user.id, input)
    expect(replay.legs.map((leg) => leg.id)).toEqual(first.legs.map((leg) => leg.id))
    expect(legShape(replay.legs)).toEqual(legShape(first.legs))
    expect(replay.preview).toEqual(first.preview)
    expect(await counts(world.user.id)).toEqual(after)
    const keys = (await prisma.transaction.findMany({ where: { id: { in: first.legs.map((leg) => leg.id) } } }))
      .map((row) => row.idempotencyKey)
      .sort()
    expect(keys).toEqual(first.legs.map((_, index) => `${input.idempotencyKey}:${index}`))
  })

  it("returns the stored allocations for a replay of a sale that spans lots", async () => {
    const world = await setup()
    const input = saleOf(world, g(13n), 95_000_00n)
    const first = await sellInvestment(world.user.id, input)
    expect((await sellInvestment(world.user.id, input)).preview).toEqual(first.preview)
  })

  it("refuses a different request on the same key, writing nothing", async () => {
    const world = await setup()
    const input = saleOf(world, g(8n), 68_000_00n)
    await sellInvestment(world.user.id, input)
    const after = await counts(world.user.id)
    const changes: Partial<SellInput>[] = [
      { quantity: g(7n) },
      { proceeds: 50_000_00n }, // a loss where a gain was stored: a different shape
      { proceeds: 69_000_00n },
      { occurredAt: calendarDate("2026-03-02") },
      { toNodeId: (await registry.makeNode(world.user.id, "ASSET", "Savings")).id },
    ]
    for (const change of changes) {
      expect(await rejection(sellInvestment(world.user.id, { ...input, ...change }))).toBeInstanceOf(RequestKeyConflictError)
    }
    expect(await counts(world.user.id)).toEqual(after)
  })

  it("refuses a key whose derived keys belong to another request", async () => {
    const world = await setup()
    const key = randomUUID()
    await recordTransaction(world.user.id, {
      fromNodeId: world.income.id,
      toNodeId: world.bank.id,
      amount: 100n,
      occurredAt: MAR_1,
      idempotencyKey: `${key}:0`,
    })
    const before = await counts(world.user.id)
    expect(await rejection(sell(world, g(8n), 56_000_00n, { idempotencyKey: key }))).toBeInstanceOf(RequestKeyConflictError)
    expect(await counts(world.user.id)).toEqual(before)
  })
})

describe("deleting and restoring a sale", () => {
  it("deletes the whole disposal, and restores it with the same consumption rows (EC-13)", async () => {
    const world = await setup()
    const { user, gold, bank } = world
    const bankBefore = await balanceOf(user.id, bank)
    const { legs } = await sell(world, g(8n), 68_000_00n)
    const consumptionsBefore = await prisma.lotConsumption.findMany({ where: { userId: user.id }, orderBy: { id: "asc" } })

    await removeTransaction(user.id, legs[0].id)
    const rows = await prisma.transaction.findMany({ where: { id: { in: legs.map((leg) => leg.id) } } })
    expect(rows.every((row) => row.deletedAt !== null)).toBe(true)
    expect(await remaining(user.id, gold)).toEqual([
      [g(10n), 70_000_00n],
      [g(5n), 37_000_00n],
    ])
    expect(await balanceOf(user.id, gold)).toBe(1_07_000_00n)
    expect(await balanceOf(user.id, bank)).toBe(bankBefore)

    const restored = await restoreTransaction(user.id, legs[0].id)
    expect(restored.deleted).toBe(false)
    const back = await prisma.transaction.findMany({ where: { id: { in: legs.map((leg) => leg.id) } } })
    expect(back.every((row) => row.deletedAt === null)).toBe(true)
    // nothing is re-allocated: the same rows count again
    expect(await prisma.lotConsumption.findMany({ where: { userId: user.id }, orderBy: { id: "asc" } })).toEqual(consumptionsBefore)
    expect(await remaining(user.id, gold)).toEqual([
      [g(2n), 14_000_00n],
      [g(5n), 37_000_00n],
    ])
    expect(await balanceOf(user.id, gold)).toBe(51_000_00n)
  })

  it("deletes and restores a break-even sale", async () => {
    const world = await setup()
    const { legs } = await sell(world, g(8n), 56_000_00n)
    await removeTransaction(world.user.id, legs[0].id)
    expect(await remaining(world.user.id, world.gold)).toEqual([
      [g(10n), 70_000_00n],
      [g(5n), 37_000_00n],
    ])
    await restoreTransaction(world.user.id, legs[0].id)
    expect(await remaining(world.user.id, world.gold)).toEqual([
      [g(2n), 14_000_00n],
      [g(5n), 37_000_00n],
    ])
  })

  async function expectRestoreRefused(world: World, legIds: string[], restoreId: string): Promise<unknown> {
    const lotsBefore = await remaining(world.user.id, world.gold)
    const error = await rejection(restoreTransaction(world.user.id, restoreId))
    const rows = await prisma.transaction.findMany({ where: { id: { in: legIds } } })
    expect(rows.every((row) => row.deletedAt !== null)).toBe(true) // nothing restored: the whole restore rolled back
    expect(await remaining(world.user.id, world.gold)).toEqual(lotsBefore)
    return error
  }

  it("is refused when another sale has since taken the grams it took", async () => {
    const world = await setup()
    const first = await sell(world, g(8n), 68_000_00n)
    await removeTransaction(world.user.id, first.legs[0].id)
    await sell(world, g(12n), 90_000_00n) // all of lot A and 2g of lot B
    // restoring from either leg is refused
    for (const leg of first.legs) {
      const error = await expectRestoreRefused(world, first.legs.map((l) => l.id), leg.id)
      expect(error).toBeInstanceOf(InsufficientQuantityError)
      expect((error as InsufficientQuantityError).message).toBe(
        "This sale cannot be restored: it took 8 g of Gold from the purchase of 2026-01-01, which now has only 0 g left to sell.",
      )
    }
  })

  it("is refused when the purchase it took from has been deleted", async () => {
    const world = await setup()
    const { legs } = await sell(world, g(8n), 68_000_00n)
    await removeTransaction(world.user.id, legs[0].id)
    await removeTransaction(world.user.id, world.buyA.id)
    const error = await expectRestoreRefused(world, legs.map((l) => l.id), legs[0].id)
    expect(error).toBeInstanceOf(InsufficientQuantityError)
    expect((error as InsufficientQuantityError).message).toContain("the purchase it took 8 g of Gold from has been deleted")
  })

  it("is refused when the purchase it took from is now dated after the sale", async () => {
    const world = await setup()
    const { legs } = await sell(world, g(8n), 68_000_00n)
    await removeTransaction(world.user.id, legs[0].id)
    await editTransaction(world.user.id, world.buyA.id, { occurredAt: calendarDate("2026-03-15") }, world.buyA.version)
    const error = await expectRestoreRefused(world, legs.map((l) => l.id), legs[0].id)
    expect(error).toBeInstanceOf(InsufficientQuantityError)
    expect((error as InsufficientQuantityError).message).toContain("now dated 2026-03-15, after this sale on 2026-03-01")
  })

  it("is refused when the purchase it took from now costs less than the sale's cost basis", async () => {
    const world = await setup()
    const { legs } = await sell(world, g(8n), 68_000_00n)
    await removeTransaction(world.user.id, legs[0].id)
    await editTransaction(world.user.id, world.buyA.id, { amount: 50_000_00n }, world.buyA.version)
    const error = await expectRestoreRefused(world, legs.map((l) => l.id), legs[0].id)
    expect(error).toBeInstanceOf(LotInUseError)
    expect(violationCodes(error)).toEqual(["AMOUNT_BELOW_SOLD"])
    expect((error as LotInUseError).message).toBe(
      "This sale cannot be restored: with it, sales would take ₹56,000.00 of the cost of the purchase of 2026-01-01, which now costs ₹50,000.00 in all.",
    )
  })

  it("is refused when it sold all of a purchase whose cost has since changed", async () => {
    const world = await setup()
    const { legs } = await sell(world, g(10n), 75_000_00n)
    await removeTransaction(world.user.id, legs[0].id)
    await editTransaction(world.user.id, world.buyA.id, { amount: 72_000_00n }, world.buyA.version)
    const error = await expectRestoreRefused(world, legs.map((l) => l.id), legs[0].id)
    expect(error).toBeInstanceOf(LotInUseError)
    expect(violationCodes(error)).toEqual(["SOLD_COST_CHANGED"])
  })

  it("is refused when the purchase it took from now holds less than the sale took", async () => {
    const world = await setup()
    const { legs } = await sell(world, g(8n), 68_000_00n)
    await removeTransaction(world.user.id, legs[0].id)
    await editTransaction(world.user.id, world.buyA.id, { quantity: g(6n) }, world.buyA.version)
    const error = await expectRestoreRefused(world, legs.map((l) => l.id), legs[0].id)
    expect(error).toBeInstanceOf(InsufficientQuantityError)
    expect((error as InsufficientQuantityError).available).toBe(g(6n))
  })

  it("is allowed again once the conflict is undone", async () => {
    const world = await setup()
    const first = await sell(world, g(8n), 68_000_00n)
    await removeTransaction(world.user.id, first.legs[0].id)
    const second = await sell(world, g(12n), 90_000_00n)
    await rejection(restoreTransaction(world.user.id, first.legs[0].id))
    await removeTransaction(world.user.id, second.legs[0].id)
    await restoreTransaction(world.user.id, first.legs[0].id)
    expect(await remaining(world.user.id, world.gold)).toEqual([
      [g(2n), 14_000_00n],
      [g(5n), 37_000_00n],
    ])
  })
})

describe("previewSale", () => {
  it("returns the numbers sellInvestment writes, and writes nothing", async () => {
    const world = await setup()
    for (const [quantity, proceeds] of [
      [g(8n), 68_000_00n],
      [g(13n), 80_000_00n],
      [g(8n), 56_000_00n],
    ] as const) {
      const input = saleOf(world, quantity, proceeds)
      const before = await counts(world.user.id)
      const preview = await previewSale(world.user.id, {
        nodeId: input.nodeId,
        toNodeId: input.toNodeId,
        quantity: input.quantity,
        proceeds: input.proceeds,
        occurredAt: input.occurredAt,
      })
      expect(await counts(world.user.id)).toEqual(before)
      const { legs, preview: written } = await sellInvestment(world.user.id, input)
      expect(written).toEqual(preview)
      expect(BigInt(legs[0].amountPaise)).toBe(preview.gainPaise >= 0n ? preview.costBasisPaise : preview.proceedsPaise)
      await removeTransaction(world.user.id, legs[0].id) // the next one previews against the same lots
    }
  })

  it("refuses what sellInvestment refuses", async () => {
    const world = await setup()
    const request = { nodeId: world.gold.id, toNodeId: world.bank.id, quantity: g(16n), proceeds: 1n, occurredAt: MAR_1 }
    expect(await rejection(previewSale(world.user.id, request))).toBeInstanceOf(InsufficientQuantityError)
    expect(await rejection(previewSale(world.user.id, { ...request, quantity: g(1n), toNodeId: world.food.id }))).toBeInstanceOf(
      InvalidTransactionError,
    )
    const other = await setup()
    expect(await rejection(previewSale(world.user.id, { ...request, nodeId: other.gold.id }))).toBeInstanceOf(NotFoundError)
  })
})
