import { describe, expect, it } from "vitest"
import { calendarDate, type CalendarDate } from "./calendar-date"
import { latestPrice, openLots, valueHolding, type HoldingLot, type PricePoint } from "./valuation"
import { parseQuantity } from "./quantity"

const d = (value: string): CalendarDate => calendarDate(value)

function lot(
  id: string,
  acquiredAt: string,
  seq: number,
  quantity: string,
  costBasisPaise: bigint,
  consumptions: { quantity: string; costBasisPaise: bigint; disposedAt: string }[] = [],
): HoldingLot {
  return {
    id,
    acquiredAt: d(acquiredAt),
    seq,
    quantity: parseQuantity(quantity),
    costBasisPaise,
    consumptions: consumptions.map((c) => ({
      quantity: parseQuantity(c.quantity),
      costBasisPaise: c.costBasisPaise,
      disposedAt: d(c.disposedAt),
    })),
  }
}

const point = (asOf: string, pricePerUnitPaise: bigint): PricePoint => ({ asOf: d(asOf), pricePerUnitPaise })

// Gold: 10 g for Rs 70,000 and 5 g for Rs 37,000
const goldLots = [lot("a", "2026-01-10", 1, "10", 7_000_000n), lot("b", "2026-02-10", 2, "5", 3_700_000n)]

describe("openLots", () => {
  it("returns each lot's remaining quantity and remaining cost basis", () => {
    const lots = [
      lot("a", "2026-01-10", 1, "10", 7_000_000n, [
        { quantity: "4", costBasisPaise: 2_800_000n, disposedAt: "2026-02-01" },
      ]),
    ]
    expect(openLots(lots)).toEqual([
      {
        id: "a",
        acquiredAt: "2026-01-10",
        seq: 1,
        quantityRemaining: parseQuantity("6"),
        costBasisRemainingPaise: 4_200_000n,
      },
    ])
  })

  it("drops a lot that has been fully consumed", () => {
    const lots = [
      lot("a", "2026-01-10", 1, "10", 7_000_000n, [
        { quantity: "10", costBasisPaise: 7_000_000n, disposedAt: "2026-02-01" },
      ]),
      lot("b", "2026-02-10", 2, "5", 3_700_000n),
    ]
    expect(openLots(lots).map((l) => l.id)).toEqual(["b"])
  })

  it("sums several consumptions of one lot", () => {
    const lots = [
      lot("a", "2026-01-10", 1, "10", 7_000_000n, [
        { quantity: "3", costBasisPaise: 2_100_000n, disposedAt: "2026-02-01" },
        { quantity: "2", costBasisPaise: 1_400_000n, disposedAt: "2026-03-01" },
      ]),
    ]
    const [open] = openLots(lots)
    expect(open.quantityRemaining).toBe(parseQuantity("5"))
    expect(open.costBasisRemainingPaise).toBe(3_500_000n)
  })

  it("without asOf, every consumption counts", () => {
    const lots = [
      lot("a", "2026-01-10", 1, "10", 7_000_000n, [
        { quantity: "4", costBasisPaise: 2_800_000n, disposedAt: "2099-01-01" },
      ]),
    ]
    expect(openLots(lots)[0].quantityRemaining).toBe(parseQuantity("6"))
  })

  it("with asOf, a consumption disposed later does not count yet", () => {
    const lots = [
      lot("a", "2026-01-10", 1, "10", 7_000_000n, [
        { quantity: "4", costBasisPaise: 2_800_000n, disposedAt: "2026-03-01" },
      ]),
    ]
    expect(openLots(lots, d("2026-02-28"))[0].quantityRemaining).toBe(parseQuantity("10"))
    expect(openLots(lots, d("2026-02-28"))[0].costBasisRemainingPaise).toBe(7_000_000n)
    expect(openLots(lots, d("2026-03-01"))[0].quantityRemaining).toBe(parseQuantity("6"))
  })

  it("with asOf, a lot acquired later is excluded and one acquired that day is included", () => {
    expect(openLots(goldLots, d("2026-01-31")).map((l) => l.id)).toEqual(["a"])
    expect(openLots(goldLots, d("2026-02-10")).map((l) => l.id)).toEqual(["a", "b"])
  })
})

describe("latestPrice", () => {
  it("is null with no points", () => {
    expect(latestPrice([], d("2026-04-01"))).toBeNull()
  })

  it("resolves by date, not insertion order (EC-25)", () => {
    const points = [point("2026-03-10", 780_000n), point("2026-01-05", 700_000n), point("2026-02-20", 750_000n)]
    expect(latestPrice(points, d("2026-04-01"))).toEqual(point("2026-03-10", 780_000n))
  })

  it("ignores a point dated after asOf", () => {
    const points = [point("2026-03-10", 780_000n), point("2026-05-01", 900_000n)]
    expect(latestPrice(points, d("2026-04-01"))).toEqual(point("2026-03-10", 780_000n))
  })

  it("uses a point dated exactly asOf", () => {
    expect(latestPrice([point("2026-04-01", 800_000n)], d("2026-04-01"))).toEqual(point("2026-04-01", 800_000n))
  })

  it("is null when every point is after asOf", () => {
    expect(latestPrice([point("2026-05-01", 900_000n)], d("2026-04-01"))).toBeNull()
  })

  it("does not mutate its input", () => {
    const points = [point("2026-03-10", 780_000n), point("2026-01-05", 700_000n)]
    latestPrice(points, d("2026-04-01"))
    expect(points.map((p) => p.asOf)).toEqual(["2026-03-10", "2026-01-05"])
  })
})

describe("valueHolding", () => {
  const base = { stalePriceDays: 30, asOf: d("2026-04-01") }

  it("is not valued, not zero, when quantity is held and there is no price (EC-23)", () => {
    const h = valueHolding({ ...base, lots: goldLots, points: [] })
    expect(h.quantityHeld).toBe(parseQuantity("15"))
    expect(h.costBasisPaise).toBe(10_700_000n)
    expect(h.price).toBeNull()
    expect(h.valuePaise).toBeNull()
    expect(h.unrealisedGainPaise).toBeNull()
    expect(h.gainBasisPoints).toBeNull()
  })

  it("is not valued when every price is dated after asOf", () => {
    const h = valueHolding({ ...base, lots: goldLots, points: [point("2026-05-01", 780_000n)] })
    expect(h.price).toBeNull()
    expect(h.valuePaise).toBeNull()
  })

  it("values the gold example: Rs 7,800 a gram on 15 g", () => {
    const h = valueHolding({ ...base, lots: goldLots, points: [point("2026-03-31", 780_000n)] })
    expect(h.quantityHeld).toBe(parseQuantity("15"))
    expect(h.valuePaise).toBe(11_700_000n)
    expect(h.costBasisPaise).toBe(10_700_000n)
    expect(h.unrealisedGainPaise).toBe(1_000_000n)
    expect(h.gainBasisPoints).toBe(935n) // 9.346% rounds half up to 9.35%
    expect(h.price).toEqual({ asOf: "2026-03-31", pricePerUnitPaise: 780_000n, stale: false })
  })

  it("reports a loss as a negative gain and negative basis points", () => {
    const h = valueHolding({
      ...base,
      lots: [lot("a", "2026-01-10", 1, "10", 7_000_000n)],
      points: [point("2026-03-31", 600_000n)],
    })
    expect(h.valuePaise).toBe(6_000_000n)
    expect(h.unrealisedGainPaise).toBe(-1_000_000n)
    expect(h.gainBasisPoints).toBe(-1429n) // -14.286%
  })

  it("rounds basis points half up, symmetrically for a loss", () => {
    // gain 1 on cost 32 is 3.125% = 312.5 bp, exactly on the half
    const up = valueHolding({ ...base, lots: [lot("a", "2026-01-10", 1, "1", 32n)], points: [point("2026-03-31", 33n)] })
    expect(up.gainBasisPoints).toBe(313n)
    const down = valueHolding({ ...base, lots: [lot("a", "2026-01-10", 1, "1", 32n)], points: [point("2026-03-31", 31n)] })
    expect(down.gainBasisPoints).toBe(-313n)
  })

  it("is stale only once the price is older than the window", () => {
    const lots = [lot("a", "2026-01-10", 1, "10", 7_000_000n)]
    const atWindow = valueHolding({ ...base, lots, points: [point("2026-03-02", 780_000n)] }) // 30 days
    expect(atWindow.price?.stale).toBe(false)
    const past = valueHolding({ ...base, lots, points: [point("2026-03-01", 780_000n)] }) // 31 days
    expect(past.price?.stale).toBe(true)
  })

  it("a price dated asOf is never stale, even with a zero-day window", () => {
    const h = valueHolding({
      ...base,
      stalePriceDays: 0,
      lots: goldLots,
      points: [point("2026-04-01", 780_000n)],
    })
    expect(h.price?.stale).toBe(false)
  })

  it("still values a stale price, flagged", () => {
    const h = valueHolding({ ...base, lots: goldLots, points: [point("2025-01-01", 780_000n)] })
    expect(h.price?.stale).toBe(true)
    expect(h.valuePaise).toBe(11_700_000n)
  })

  it("values nothing held as exactly zero, with or without a price", () => {
    const sold = [
      lot("a", "2026-01-10", 1, "10", 7_000_000n, [
        { quantity: "10", costBasisPaise: 7_000_000n, disposedAt: "2026-02-01" },
      ]),
    ]
    const without = valueHolding({ ...base, lots: sold, points: [] })
    expect(without.quantityHeld).toBe(0n)
    expect(without.valuePaise).toBe(0n)
    expect(without.costBasisPaise).toBe(0n)
    expect(without.unrealisedGainPaise).toBe(0n)
    expect(without.gainBasisPoints).toBeNull() // cost is 0
    expect(without.price).toBeNull()

    const withPrice = valueHolding({ ...base, lots: sold, points: [point("2026-03-31", 780_000n)] })
    expect(withPrice.valuePaise).toBe(0n)
    expect(withPrice.price).toEqual({ asOf: "2026-03-31", pricePerUnitPaise: 780_000n, stale: false })
  })

  it("values no lots at all as zero", () => {
    expect(valueHolding({ ...base, lots: [], points: [] }).valuePaise).toBe(0n)
  })

  it("a consumption disposed after asOf still counts as held at asOf", () => {
    const lots = [
      lot("a", "2026-01-10", 1, "10", 7_000_000n, [
        { quantity: "4", costBasisPaise: 2_800_000n, disposedAt: "2026-05-01" },
      ]),
    ]
    const h = valueHolding({ ...base, lots, points: [point("2026-03-31", 780_000n)] })
    expect(h.quantityHeld).toBe(parseQuantity("10"))
    expect(h.valuePaise).toBe(7_800_000n)
  })

  it("a lot acquired after asOf is excluded", () => {
    const h = valueHolding({ ...base, asOf: d("2026-01-31"), lots: goldLots, points: [point("2026-01-20", 780_000n)] })
    expect(h.quantityHeld).toBe(parseQuantity("10"))
    expect(h.costBasisPaise).toBe(7_000_000n)
  })

  it("costBasisPaise is the remaining basis of the open lots", () => {
    const lots = [
      lot("a", "2026-01-10", 1, "10", 7_000_000n, [
        { quantity: "4", costBasisPaise: 2_800_000n, disposedAt: "2026-02-01" },
      ]),
      lot("b", "2026-02-10", 2, "5", 3_700_000n),
    ]
    const h = valueHolding({ ...base, lots, points: [point("2026-03-31", 780_000n)] })
    expect(h.quantityHeld).toBe(parseQuantity("11"))
    expect(h.costBasisPaise).toBe(4_200_000n + 3_700_000n)
  })

  it("rounds once on the total quantity, not per lot", () => {
    // four lots of one micro-unit at 150,000 paise: each is worth 0.15 paise (0 if rounded alone), together 0.6 -> 1
    const lots = [1, 2, 3, 4].map((n) => lot(`l${n}`, "2026-01-10", n, "0.000001", 1n))
    const h = valueHolding({ ...base, lots, points: [point("2026-03-31", 150_000n)] })
    expect(h.valuePaise).toBe(1n)
  })
})
