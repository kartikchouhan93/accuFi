import { describe, expect, it } from "vitest"
import { calendarDate } from "./calendar-date"
import { allocateLots, InsufficientQuantityError, type OpenLot } from "./lots"
import { QUANTITY_SCALE, parseQuantity } from "./quantity"

const q = parseQuantity
const lot = (id: string, acquiredAt: string, seq: number, quantity: string, basis: bigint): OpenLot => ({
  id,
  acquiredAt: calendarDate(acquiredAt),
  seq,
  quantityRemaining: q(quantity),
  costBasisRemainingPaise: basis,
})

// Spec §7.2 example: A is 10 units for ₹70,000, B is 5 units for ₹37,000, bought in that order.
const A = lot("A", "2025-01-10", 1, "10", 7_000_000n)
const B = lot("B", "2025-03-10", 2, "5", 3_700_000n)

describe("allocateLots", () => {
  it("FIFO selling 13 takes all of A then 3 of B (₹92,200)", () => {
    const result = allocateLots([A, B], "FIFO", q("13"))
    expect(result).toEqual([
      { lotId: "A", quantity: q("10"), costBasisPaise: 7_000_000n },
      { lotId: "B", quantity: q("3"), costBasisPaise: 2_220_000n },
    ])
    expect(result.reduce((s, a) => s + a.costBasisPaise, 0n)).toBe(9_220_000n)
  })

  it("does not depend on the order lots are passed in", () => {
    expect(allocateLots([B, A], "FIFO", q("13"))).toEqual(allocateLots([A, B], "FIFO", q("13")))
  })

  it("LIFO selling 6 takes all of B then 1 of A", () => {
    expect(allocateLots([A, B], "LIFO", q("6"))).toEqual([
      { lotId: "B", quantity: q("5"), costBasisPaise: 3_700_000n },
      { lotId: "A", quantity: q("1"), costBasisPaise: 700_000n },
    ])
  })

  it("HIGHEST_COST_FIRST takes B (₹7,400 a unit) before A (₹7,000 a unit)", () => {
    expect(allocateLots([A, B], "HIGHEST_COST_FIRST", q("6"))).toEqual([
      { lotId: "B", quantity: q("5"), costBasisPaise: 3_700_000n },
      { lotId: "A", quantity: q("1"), costBasisPaise: 700_000n },
    ])
  })

  it("HIGHEST_COST_FIRST compares remaining unit cost, not total basis", () => {
    const cheapBig = lot("big", "2025-01-01", 1, "100", 100_000n) // 1,000 paise a unit, larger total basis
    const dearSmall = lot("small", "2025-02-01", 2, "1", 5_000n) // 5,000 paise a unit, smaller total basis
    expect(allocateLots([cheapBig, dearSmall], "HIGHEST_COST_FIRST", q("1"))[0].lotId).toBe("small")
  })

  it("HIGHEST_COST_FIRST breaks a unit-cost tie by FIFO", () => {
    const first = lot("first", "2025-01-01", 1, "2", 200_000n)
    const second = lot("second", "2025-02-01", 2, "4", 400_000n)
    expect(allocateLots([second, first], "HIGHEST_COST_FIRST", q("1"))[0].lotId).toBe("first")
  })

  it("breaks an acquiredAt tie by seq (FIFO oldest seq first, LIFO newest seq first)", () => {
    const x = lot("x", "2025-05-05", 7, "1", 100n)
    const y = lot("y", "2025-05-05", 3, "1", 100n)
    expect(allocateLots([x, y], "FIFO", q("1"))[0].lotId).toBe("y")
    expect(allocateLots([x, y], "LIFO", q("1"))[0].lotId).toBe("x")
  })

  it("loses no paisa when a lot is sold in parts: 3 then 7 of 10 sums to the whole basis", () => {
    const whole = lot("L", "2025-01-01", 1, "10", 7_000_000n)
    const [first] = allocateLots([whole], "FIFO", q("3"))
    expect(first.costBasisPaise).toBe(2_100_000n)
    const rest: OpenLot = {
      ...whole,
      quantityRemaining: whole.quantityRemaining - first.quantity,
      costBasisRemainingPaise: whole.costBasisRemainingPaise - first.costBasisPaise,
    }
    const [second] = allocateLots([rest], "FIFO", q("7"))
    expect(first.costBasisPaise + second.costBasisPaise).toBe(7_000_000n)
  })

  it("rounds a partial basis half up", () => {
    // 1 paisa across 2 units, sell 1 → 0.5 → 1
    expect(allocateLots([lot("h", "2025-01-01", 1, "2", 1n)], "FIFO", q("1"))[0].costBasisPaise).toBe(1n)
    // 1 paisa across 3 units, sell 1 → 0.33 → 0
    expect(allocateLots([lot("t", "2025-01-01", 1, "3", 1n)], "FIFO", q("1"))[0].costBasisPaise).toBe(0n)
  })

  it("selling exactly everything allocates every lot in full", () => {
    const result = allocateLots([A, B], "FIFO", q("15"))
    expect(result.map((a) => a.lotId)).toEqual(["A", "B"])
    expect(result.reduce((s, a) => s + a.costBasisPaise, 0n)).toBe(10_700_000n)
  })

  it("skips lots with nothing remaining", () => {
    const empty = lot("E", "2024-01-01", 0, "1", 0n)
    const spent: OpenLot = { ...empty, quantityRemaining: 0n }
    const result = allocateLots([spent, A], "FIFO", q("1"))
    expect(result.map((a) => a.lotId)).toEqual(["A"])
  })

  it("never touches a lot it does not need", () => {
    expect(allocateLots([A, B], "FIFO", q("4")).map((a) => a.lotId)).toEqual(["A"])
  })

  it("does not mutate its input", () => {
    const lots = [B, A]
    allocateLots(lots, "FIFO", q("13"))
    expect(lots).toEqual([B, A])
  })

  it.each([0n, -1n, -5_000_000n])("refuses a quantity of %s", (bad) => {
    expect(() => allocateLots([A], "FIFO", bad)).toThrow(RangeError)
  })

  it("throws InsufficientQuantityError carrying what is held and what was asked (EC-21)", () => {
    const attempt = () => allocateLots([A, B], "FIFO", q("15.000001"))
    expect(attempt).toThrow(InsufficientQuantityError)
    try {
      attempt()
    } catch (e) {
      expect((e as InsufficientQuantityError).available).toBe(q("15"))
      expect((e as InsufficientQuantityError).requested).toBe(q("15.000001"))
    }
  })

  it("throws InsufficientQuantityError when there are no lots at all", () => {
    expect(() => allocateLots([], "LIFO", q("1"))).toThrow(InsufficientQuantityError)
  })

  it("property: 500 random lot sets, allocations sum to the quantity and never exceed the held basis", () => {
    const methods = ["FIFO", "LIFO", "HIGHEST_COST_FIRST"] as const
    const randomBigInt = (max: bigint) => BigInt(Math.floor(Math.random() * Number(max)))
    for (let run = 0; run < 500; run++) {
      const count = 1 + Math.floor(Math.random() * 8)
      const lots: OpenLot[] = Array.from({ length: count }, (_, i) => {
        const qty = Math.random() < 0.15 ? 0n : 1n + randomBigInt(500n * QUANTITY_SCALE)
        return {
          id: `lot${i}`,
          acquiredAt: calendarDate(`2025-01-${String(1 + Math.floor(Math.random() * 28)).padStart(2, "0")}`),
          seq: i,
          quantityRemaining: qty,
          costBasisRemainingPaise: qty === 0n ? 0n : randomBigInt(10_000_000_000n),
        }
      })
      const total = lots.reduce((sum, l) => sum + l.quantityRemaining, 0n)
      if (total === 0n) continue
      const want = 1n + randomBigInt(total) // 1..total
      const method = methods[run % 3]
      const result = allocateLots(lots, method, want)
      expect(result.reduce((s, a) => s + a.quantity, 0n)).toBe(want)
      const held = lots.reduce((s, l) => s + l.costBasisRemainingPaise, 0n)
      expect(result.reduce((s, a) => s + a.costBasisPaise, 0n)).toBeLessThanOrEqual(held)
      for (const a of result) {
        const source = lots.find((l) => l.id === a.lotId)!
        expect(a.quantity).toBeGreaterThan(0n)
        expect(a.quantity).toBeLessThanOrEqual(source.quantityRemaining)
        expect(a.costBasisPaise).toBeLessThanOrEqual(source.costBasisRemainingPaise)
      }
    }
  })
})
