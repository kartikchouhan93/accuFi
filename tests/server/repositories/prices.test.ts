import { afterAll, describe, expect, it } from "vitest"
import { calendarDate } from "@/domain/calendar-date"
import { prisma } from "@/server/db"
import { NotFoundError } from "@/server/repositories/errors"
import { deletePrice, deletePricesOfNode, listPrices, upsertPrice } from "@/server/repositories/price-repository"
import { inTransaction } from "@/server/repositories/unit-of-work"
import { findStalePriceDays } from "@/server/repositories/user-repository"
import { createRegistry } from "./fixtures"

const registry = createRegistry()
afterAll(registry.cleanup)

const d = calendarDate

async function setup() {
  const user = await registry.makeUser()
  const gold = await registry.makeNode(user.id, "INVESTMENT", "Gold", { valuationMode: "QUANTITY", unitLabel: "g" })
  return { user, gold }
}

describe("upsertPrice and listPrices", () => {
  it("keeps one row per day, holding the price written last (EC-26)", async () => {
    const { user, gold } = await setup()
    await upsertPrice(user.id, { nodeId: gold.id, asOf: d("2026-03-01"), pricePerUnitPaise: 700_000n })
    await upsertPrice(user.id, { nodeId: gold.id, asOf: d("2026-03-01"), pricePerUnitPaise: 780_000n })
    expect(await prisma.priceSnapshot.count({ where: { nodeId: gold.id } })).toBe(1)
    expect(await listPrices(user.id, gold.id)).toEqual([{ asOf: "2026-03-01", pricePerUnitPaise: 780_000n }])
  })

  it("lists by ascending date whatever order the prices were entered in", async () => {
    const { user, gold } = await setup()
    for (const [asOf, price] of [
      ["2026-03-01", 3n],
      ["2026-01-01", 1n],
      ["2026-02-01", 2n],
    ] as const) {
      await upsertPrice(user.id, { nodeId: gold.id, asOf: d(asOf), pricePerUnitPaise: price })
    }
    expect(await listPrices(user.id, gold.id)).toEqual([
      { asOf: "2026-01-01", pricePerUnitPaise: 1n },
      { asOf: "2026-02-01", pricePerUnitPaise: 2n },
      { asOf: "2026-03-01", pricePerUnitPaise: 3n },
    ])
  })

  it("holds prices above Number.MAX_SAFE_INTEGER without loss", async () => {
    const { user, gold } = await setup()
    await upsertPrice(user.id, { nodeId: gold.id, asOf: d("2026-03-01"), pricePerUnitPaise: 9_007_199_254_740_993n })
    expect((await listPrices(user.id, gold.id))[0].pricePerUnitPaise).toBe(9_007_199_254_740_993n)
  })

  it("lists nothing for a node with no prices", async () => {
    const { user, gold } = await setup()
    expect(await listPrices(user.id, gold.id)).toEqual([])
  })
})

describe("deletePrice and deletePricesOfNode", () => {
  it("deletes one day's price and leaves the others", async () => {
    const { user, gold } = await setup()
    await upsertPrice(user.id, { nodeId: gold.id, asOf: d("2026-03-01"), pricePerUnitPaise: 1n })
    await upsertPrice(user.id, { nodeId: gold.id, asOf: d("2026-03-02"), pricePerUnitPaise: 2n })
    await deletePrice(user.id, gold.id, d("2026-03-01"))
    expect(await listPrices(user.id, gold.id)).toEqual([{ asOf: "2026-03-02", pricePerUnitPaise: 2n }])
  })

  it("answers not-found for a day that has no price", async () => {
    const { user, gold } = await setup()
    expect(await deletePrice(user.id, gold.id, d("2026-03-01")).catch((e: unknown) => e)).toBeInstanceOf(NotFoundError)
  })

  it("deletes every price of a node, and only that node's", async () => {
    const { user, gold } = await setup()
    const silver = await registry.makeNode(user.id, "INVESTMENT", "Silver", { valuationMode: "QUANTITY", unitLabel: "g" })
    await upsertPrice(user.id, { nodeId: gold.id, asOf: d("2026-03-01"), pricePerUnitPaise: 1n })
    await upsertPrice(user.id, { nodeId: gold.id, asOf: d("2026-03-02"), pricePerUnitPaise: 2n })
    await upsertPrice(user.id, { nodeId: silver.id, asOf: d("2026-03-01"), pricePerUnitPaise: 3n })
    await inTransaction((uow) => deletePricesOfNode(user.id, gold.id, uow))
    expect(await listPrices(user.id, gold.id)).toEqual([])
    expect(await listPrices(user.id, silver.id)).toHaveLength(1)
  })
})

describe("findStalePriceDays", () => {
  it("reads the user's staleness window, 30 days unless changed", async () => {
    const { user } = await setup()
    expect(await findStalePriceDays(user.id)).toBe(30)
    await prisma.user.update({ where: { id: user.id }, data: { stalePriceDays: 45 } })
    expect(await findStalePriceDays(user.id)).toBe(45)
  })
})
