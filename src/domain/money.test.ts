import { describe, expect, it } from "vitest"
import { MoneyParseError, allocate, formatPaise, parseRupees } from "./money"

describe("parseRupees", () => {
  it("parses plain and grouped input", () => {
    expect(parseRupees("1234.56")).toBe(123456n)
    expect(parseRupees("1,23,456.78")).toBe(12345678n)
    expect(parseRupees("100")).toBe(10000n)
    expect(parseRupees("0.05")).toBe(5n)
  })
  it("pads a single decimal digit to paise", () => {
    expect(parseRupees("1.5")).toBe(150n)
  })
  it("parses negative input and surrounding whitespace", () => {
    expect(parseRupees("-12.34")).toBe(-1234n)
    expect(parseRupees("  7 ")).toBe(700n)
  })
  it("parses values beyond the safe-integer range exactly", () => {
    expect(parseRupees("90071992547409930.99")).toBe(9007199254740993099n)
  })
  it("rejects more than two decimal places", () => {
    expect(() => parseRupees("1.234")).toThrow(MoneyParseError)
  })
  it("rejects non-numeric input", () => {
    expect(() => parseRupees("abc")).toThrow(MoneyParseError)
  })
  it("rejects empty, malformed and mis-grouped input", () => {
    for (const bad of ["", " ", "-", ".", "1.", "1..2", "1,2,3", "12,34", "1e3", "0x10", "+5", "1 000"]) {
      expect(() => parseRupees(bad), bad).toThrow(MoneyParseError)
    }
  })
})

describe("formatPaise", () => {
  it("uses Indian digit grouping", () => {
    expect(formatPaise(12345678n)).toBe("₹1,23,456.78")
    expect(formatPaise(10000n)).toBe("₹100.00")
    expect(formatPaise(0n)).toBe("₹0.00")
  })
  it("formats negative amounts with the sign before the symbol", () => {
    expect(formatPaise(-12345678n)).toBe("-₹1,23,456.78")
  })
  it("zero-pads the paise portion", () => {
    expect(formatPaise(5n)).toBe("₹0.05")
    expect(formatPaise(-5n)).toBe("-₹0.05")
    expect(formatPaise(10001n)).toBe("₹100.01")
  })
  it("formats values beyond the safe-integer range exactly", () => {
    expect(formatPaise(9007199254740993099n)).toBe("₹90,07,19,92,54,74,09,930.99")
  })
  it("round-trips with parseRupees", () => {
    for (const p of [0n, 1n, 99n, 100n, 12345678n, -12345678n, 9007199254740993099n]) {
      expect(parseRupees(formatPaise(p).replace("₹", ""))).toBe(p)
    }
  })
})

describe("allocate", () => {
  it("distributes an indivisible remainder so the legs sum exactly", () => {
    expect(allocate(10000n, [1n, 1n, 1n])).toEqual([3334n, 3333n, 3333n])
  })
  it("allocates proportionally to weights", () => {
    expect(allocate(10000n, [3n, 1n])).toEqual([7500n, 2500n])
  })
  it("gives leftover paise to the largest fractional remainders, ties by index", () => {
    // 7 * [1,1,2] / 4 = 1.75, 1.75, 3.5: floors 1,1,3, two left over; remainders .75,.75,.5 -> legs 0 and 1
    expect(allocate(7n, [1n, 1n, 2n])).toEqual([2n, 2n, 3n])
    // 5 * [1,1,1] / 3: equal remainders, two left over -> the lowest indices win the tie
    expect(allocate(5n, [1n, 1n, 1n])).toEqual([2n, 2n, 1n])
    // 5 * [4,5,6] / 15 = 1.33, 1.67, 2: one left over -> goes to leg 1 (largest remainder), not leg 0
    expect(allocate(5n, [4n, 5n, 6n])).toEqual([1n, 2n, 2n])
  })
  it("never gives paise to zero-weight legs", () => {
    expect(allocate(100n, [0n, 1n, 0n, 1n, 1n])).toEqual([0n, 34n, 0n, 33n, 33n])
  })
  it("allocates everything to the only weighted leg", () => {
    expect(allocate(123n, [0n, 5n])).toEqual([0n, 123n])
  })
  it("allocates a zero total as zeros", () => {
    expect(allocate(0n, [1n, 2n])).toEqual([0n, 0n])
  })
  it("allocates negative totals symmetrically, still summing exactly", () => {
    expect(allocate(-10000n, [1n, 1n, 1n])).toEqual([-3334n, -3333n, -3333n])
  })
  it("rejects empty, negative or all-zero weights", () => {
    expect(() => allocate(100n, [])).toThrow(RangeError)
    expect(() => allocate(100n, [1n, -1n])).toThrow(RangeError)
    expect(() => allocate(100n, [0n, 0n])).toThrow(RangeError)
  })

  // Uniform random bigint in [0, 2^bits) built from random 32-bit chunks.
  const randomBits = (bits: number): bigint => {
    let out = 0n
    for (let done = 0; done < bits; done += 32) {
      out = (out << 32n) | BigInt(Math.floor(Math.random() * 2 ** 32))
    }
    return out & ((1n << BigInt(bits)) - 1n)
  }

  it("always sums to the total for arbitrary inputs", () => {
    for (let i = 0; i < 2000; i++) {
      // Vary magnitude per case so tiny, mid-range and huge (beyond 2^64) values all occur.
      const totalBits = 1 + Math.floor(Math.random() * 90)
      const weightBits = 1 + Math.floor(Math.random() * 70)
      const legs = 1 + Math.floor(Math.random() * 12)
      const sign = Math.random() < 0.3 ? -1n : 1n
      const total = sign * randomBits(totalBits)
      const weights: bigint[] = Array.from({ length: legs }, () => (Math.random() < 0.15 ? 0n : randomBits(weightBits)))
      if (!weights.some((w) => w > 0n)) weights[0] = 1n

      const parts = allocate(total, weights)

      expect(parts).toHaveLength(legs)
      expect(parts.reduce((s, p) => s + p, 0n), `total=${total} weights=${weights}`).toBe(total)
      weights.forEach((w, idx) => {
        if (w === 0n) expect(parts[idx]).toBe(0n)
      })
    }
  })

  it("keeps every leg within one paise of its exact proportional share", () => {
    for (let i = 0; i < 500; i++) {
      const total = randomBits(1 + Math.floor(Math.random() * 80))
      const weights = Array.from({ length: 1 + Math.floor(Math.random() * 8) }, () => 1n + randomBits(40))
      const sumW = weights.reduce((s, w) => s + w, 0n)
      const parts = allocate(total, weights)
      parts.forEach((p, idx) => {
        const floor = (total * weights[idx]) / sumW
        expect(p === floor || p === floor + 1n).toBe(true)
      })
    }
  })
})
