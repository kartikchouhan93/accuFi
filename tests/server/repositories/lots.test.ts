import { afterAll, describe, expect, it } from "vitest"
import { Prisma } from "@prisma/client"
import { calendarDate } from "@/domain/calendar-date"
import { prisma } from "@/server/db"
import { NotFoundError } from "@/server/repositories/errors"
import {
  countConsumptionsOfLot,
  deleteLotOf,
  findConsumptionsByTransaction,
  findLiveLots,
  findLotByTransaction,
  findLotGaps,
  findLotQuantities,
  insertConsumptions,
  insertLot,
  updateLot,
} from "@/server/repositories/lot-repository"
import { inTransaction } from "@/server/repositories/unit-of-work"
import { createRegistry } from "./fixtures"

const registry = createRegistry()
afterAll(registry.cleanup)

const d = calendarDate
const UNIT = 1_000_000n

/** A user with a bank, a QUANTITY gold node and one purchase into it (no lot yet), plus a sale-leg helper. */
async function setup() {
  const user = await registry.makeUser()
  const bank = await registry.makeNode(user.id, "ASSET", "Bank")
  const gold = await registry.makeNode(user.id, "INVESTMENT", "Gold", { valuationMode: "QUANTITY", unitLabel: "g" })
  const buy = (amountPaise = 7_000_000n, occurredAt = "2026-01-01") =>
    registry.makeTransaction(user.id, bank.id, gold.id, { amountPaise, occurredAt })
  const sale = (occurredAt = "2026-03-01") => registry.makeTransaction(user.id, gold.id, bank.id, { amountPaise: 1_000n, occurredAt })
  const lotFor = async (transactionId: string, quantity: bigint, costBasisPaise = 7_000_000n, acquiredAt = "2026-01-01") => {
    await inTransaction((uow) =>
      insertLot(user.id, { nodeId: gold.id, transactionId, quantity, costBasisPaise, acquiredAt: d(acquiredAt) }, uow),
    )
    return prisma.investmentLot.findUniqueOrThrow({ where: { transactionId } })
  }
  return { user, bank, gold, buy, sale, lotFor }
}

const softDelete = (id: string) => prisma.transaction.update({ where: { id }, data: { deletedAt: new Date() } })
const undelete = (id: string) => prisma.transaction.update({ where: { id }, data: { deletedAt: null } })

describe("insertLot and findLiveLots", () => {
  it("round-trips the quantity through Decimal as the same micro-units, with the basis and the day", async () => {
    const { user, gold, buy, lotFor } = await setup()
    const tx = await buy()
    // 142.387123 units and a quantity beyond 2^53 micro-units: neither survives a trip through a JS number.
    const lot = await lotFor(tx.id, 142_387_123n, 7_000_000n, "2026-01-01")
    const big = await lotFor((await buy(1n, "2026-01-02")).id, 999_999_999_999_999_999n, 1n, "2026-01-02")
    expect(lot.quantity.toString()).toBe("142.387123")
    const lots = await findLiveLots(user.id, gold.id)
    expect(lots).toEqual([
      { id: lot.id, acquiredAt: "2026-01-01", seq: 0, quantity: 142_387_123n, costBasisPaise: 7_000_000n, consumptions: [] },
      { id: big.id, acquiredAt: "2026-01-02", seq: 1, quantity: 999_999_999_999_999_999n, costBasisPaise: 1n, consumptions: [] },
    ])
  })

  it("numbers the lots in the order they were entered, not by date", async () => {
    const { user, gold, buy, lotFor } = await setup()
    const later = await lotFor((await buy(1_000n, "2026-02-01")).id, UNIT, 1_000n, "2026-02-01")
    const earlier = await lotFor((await buy(1_000n, "2026-01-01")).id, UNIT, 1_000n, "2026-01-01")
    expect((await findLiveLots(user.id, gold.id)).map((lot) => [lot.id, lot.seq])).toEqual([
      [later.id, 0],
      [earlier.id, 1],
    ])
  })

  it("drops a lot while its buying transaction is soft-deleted, and brings it back on restore", async () => {
    const { user, gold, buy, lotFor } = await setup()
    const tx = await buy()
    const lot = await lotFor(tx.id, 10n * UNIT)
    await softDelete(tx.id)
    expect(await findLiveLots(user.id, gold.id)).toEqual([])
    await undelete(tx.id)
    expect((await findLiveLots(user.id, gold.id)).map((l) => l.id)).toEqual([lot.id])
  })

  it("refuses a lot for a transaction that does not exist, writing nothing", async () => {
    const { user, gold } = await setup()
    const error = await inTransaction((uow) =>
      insertLot(user.id, { nodeId: gold.id, transactionId: "no-such-tx", quantity: UNIT, costBasisPaise: 1n, acquiredAt: d("2026-01-01") }, uow),
    ).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(NotFoundError)
    expect(await prisma.investmentLot.count({ where: { userId: user.id } })).toBe(0)
  })
})

describe("consumptions", () => {
  it("lists a lot's consumptions with the disposal's day, and leaves out one whose disposal is soft-deleted", async () => {
    const { user, gold, buy, sale, lotFor } = await setup()
    const lot = await lotFor((await buy()).id, 10n * UNIT)
    const first = await sale("2026-03-01")
    const second = await sale("2026-04-01")
    await inTransaction(async (uow) => {
      await insertConsumptions(user.id, [{ lotId: lot.id, transactionId: first.id, quantity: 3n * UNIT, costBasisPaise: 2_100_000n }], uow)
      await insertConsumptions(user.id, [{ lotId: lot.id, transactionId: second.id, quantity: 2n * UNIT, costBasisPaise: 0n }], uow)
    })
    const [live] = await findLiveLots(user.id, gold.id)
    expect(live.consumptions).toEqual([
      { quantity: 3n * UNIT, costBasisPaise: 2_100_000n, disposedAt: "2026-03-01" },
      { quantity: 2n * UNIT, costBasisPaise: 0n, disposedAt: "2026-04-01" },
    ])

    await softDelete(second.id)
    expect((await findLiveLots(user.id, gold.id))[0].consumptions).toEqual([
      { quantity: 3n * UNIT, costBasisPaise: 2_100_000n, disposedAt: "2026-03-01" },
    ])
    // ... while the deleted disposal still knows what it took, so a restore can bring it back
    expect(await findConsumptionsByTransaction(user.id, second.id)).toEqual([
      { lotId: lot.id, quantity: 2n * UNIT, costBasisPaise: 0n, acquiredAt: "2026-01-01" },
    ])
    expect(await countConsumptionsOfLot(user.id, lot.transactionId)).toBe(2)
  })

  it("inserts nothing for no rows", async () => {
    const { user } = await setup()
    await inTransaction((uow) => insertConsumptions(user.id, [], uow))
    expect(await prisma.lotConsumption.count({ where: { userId: user.id } })).toBe(0)
  })
})

describe("findLotByTransaction", () => {
  it("returns the lot with its live consumptions and whether its buying transaction is live", async () => {
    const { user, buy, sale, lotFor } = await setup()
    const firstTx = await buy()
    await lotFor(firstTx.id, UNIT, 1_000n)
    const tx = await buy(5_000_000n, "2026-01-05")
    const lot = await lotFor(tx.id, 5n * UNIT, 5_000_000n, "2026-01-05")
    const disposal = await sale("2026-02-01")
    await inTransaction((uow) =>
      insertConsumptions(user.id, [{ lotId: lot.id, transactionId: disposal.id, quantity: 3n * UNIT, costBasisPaise: 3_000_000n }], uow),
    )
    expect(await findLotByTransaction(user.id, tx.id)).toEqual({
      id: lot.id,
      acquiredAt: "2026-01-05",
      seq: 1,
      quantity: 5n * UNIT,
      costBasisPaise: 5_000_000n,
      consumptions: [{ quantity: 3n * UNIT, costBasisPaise: 3_000_000n, disposedAt: "2026-02-01" }],
      live: true,
    })
    await softDelete(tx.id)
    expect(await findLotByTransaction(user.id, tx.id)).toMatchObject({ id: lot.id, live: false })
    expect(await findLotByTransaction(user.id, disposal.id)).toBeNull()
  })
})

describe("findLotQuantities", () => {
  it("gives the quantity each of the transactions bought, and nothing for one that bought no lot", async () => {
    const { user, buy, sale, lotFor } = await setup()
    const first = await buy()
    await lotFor(first.id, 10n * UNIT)
    const second = await buy(37_000_00n, "2026-02-01")
    await lotFor(second.id, 5_500_000n, 37_000_00n, "2026-02-01")
    const legacy = await buy(1_000n)
    const disposal = await sale()
    const quantities = await findLotQuantities(user.id, [first.id, second.id, legacy.id, disposal.id])
    expect(quantities).toEqual(new Map([[first.id, 10n * UNIT], [second.id, 5_500_000n]]))
    expect(await findLotQuantities(user.id, [])).toEqual(new Map())
  })
})

describe("updateLot and deleteLotOf", () => {
  it("changes only the fields it is given", async () => {
    const { user, buy, lotFor } = await setup()
    const tx = await buy()
    await lotFor(tx.id, 10n * UNIT)
    await inTransaction((uow) => updateLot(user.id, tx.id, { quantity: 12_500_000n, acquiredAt: d("2026-01-09") }, uow))
    expect(await findLotByTransaction(user.id, tx.id)).toMatchObject({ quantity: 12_500_000n, costBasisPaise: 7_000_000n, acquiredAt: "2026-01-09" })
    await inTransaction((uow) => updateLot(user.id, tx.id, { costBasisPaise: 8_000_000n }, uow))
    expect(await findLotByTransaction(user.id, tx.id)).toMatchObject({ quantity: 12_500_000n, costBasisPaise: 8_000_000n })
  })

  it("moves a lot to another of the user's nodes", async () => {
    const { user, gold, buy, lotFor } = await setup()
    const silver = await registry.makeNode(user.id, "INVESTMENT", "Silver", { valuationMode: "QUANTITY", unitLabel: "g" })
    const tx = await buy()
    await lotFor(tx.id, UNIT)
    await inTransaction((uow) => updateLot(user.id, tx.id, { nodeId: silver.id }, uow))
    expect(await findLiveLots(user.id, gold.id)).toEqual([])
    expect(await findLiveLots(user.id, silver.id)).toHaveLength(1)
  })

  it("deletes the lot a transaction acquired, and answers not-found when there is none", async () => {
    const { user, gold, buy, lotFor } = await setup()
    const tx = await buy()
    await lotFor(tx.id, UNIT)
    await inTransaction((uow) => deleteLotOf(user.id, tx.id, uow))
    expect(await findLiveLots(user.id, gold.id)).toEqual([])
    expect(await inTransaction((uow) => deleteLotOf(user.id, tx.id, uow)).catch((e: unknown) => e)).toBeInstanceOf(NotFoundError)
    expect(await inTransaction((uow) => updateLot(user.id, tx.id, { quantity: UNIT }, uow)).catch((e: unknown) => e)).toBeInstanceOf(
      NotFoundError,
    )
  })
})

describe("findLotGaps", () => {
  it("counts a legacy inflow with no lot and an outflow with no consumption, live rows only", async () => {
    const { user, gold, buy, sale, lotFor } = await setup()
    expect(await findLotGaps(user.id, gold.id)).toEqual({ inflowsWithoutLot: 0, outflowsWithoutConsumption: 0 })
    const covered = await buy()
    const lot = await lotFor(covered.id, 10n * UNIT)
    await buy() // legacy: no lot
    const deletedLegacy = await buy()
    await softDelete(deletedLegacy.id)
    const coveredSale = await sale()
    await inTransaction((uow) =>
      insertConsumptions(user.id, [{ lotId: lot.id, transactionId: coveredSale.id, quantity: UNIT, costBasisPaise: 700_000n }], uow),
    )
    await sale() // legacy: no consumption
    expect(await findLotGaps(user.id, gold.id)).toEqual({ inflowsWithoutLot: 1, outflowsWithoutConsumption: 1 })
  })

  it("does not count the second leg of a disposal, which carries no consumption by design", async () => {
    // A loss posts gold -> bank (the leg with the consumptions) and gold -> Realised Loss: both are in the DISPOSAL group.
    const { user, gold, buy, sale, lotFor } = await setup()
    const lot = await lotFor((await buy()).id, 10n * UNIT)
    const loss = await registry.makeNode(user.id, "EXPENSE", "Realised Loss")
    const group = await prisma.transactionGroup.create({ data: { userId: user.id, kind: "DISPOSAL" } })
    const basisLeg = await sale()
    const lossLeg = await registry.makeTransaction(user.id, gold.id, loss.id, { amountPaise: 500n, occurredAt: "2026-03-01" })
    await prisma.transaction.updateMany({ where: { id: { in: [basisLeg.id, lossLeg.id] } }, data: { groupId: group.id } })
    await inTransaction((uow) =>
      insertConsumptions(user.id, [{ lotId: lot.id, transactionId: basisLeg.id, quantity: UNIT, costBasisPaise: 700_000n }], uow),
    )
    expect(await findLotGaps(user.id, gold.id)).toEqual({ inflowsWithoutLot: 0, outflowsWithoutConsumption: 0 })
  })
})

describe("database constraints the repository relies on", () => {
  it("stores the quantity as Decimal(18,6)", async () => {
    const { buy, lotFor } = await setup()
    const lot = await lotFor((await buy()).id, 1n)
    expect(lot.quantity).toBeInstanceOf(Prisma.Decimal)
    expect(lot.quantity.toString()).toBe("0.000001")
  })
})
