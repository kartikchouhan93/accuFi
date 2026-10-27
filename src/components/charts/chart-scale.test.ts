import { describe, expect, it } from "vitest"
import { formatTick, linePath, niceDomain, paiseToNumber } from "./chart-scale"

// The geometry under the charts: where a mark goes. None of these numbers is ever shown as money.

const evenlySpaced = (ticks: number[]) => {
  const step = ticks[1] - ticks[0]
  return ticks.every((tick, i) => i === 0 || Math.abs(tick - ticks[i - 1] - step) < step * 1e-9)
}

describe("paiseToNumber", () => {
  it("places an amount beyond 2^53 paise without throwing", () => {
    const n = paiseToNumber("123456789012345678901")
    expect(Number.isFinite(n)).toBe(true)
    expect(n).toBeGreaterThan(1e20)
  })

  it("reads a negative amount", () => {
    expect(paiseToNumber("-150000")).toBe(-150000)
  })
})

describe("niceDomain", () => {
  it("rounds a positive maximum up to a nice step from zero", () => {
    const domain = niceDomain(0, 8_230_000)
    expect(domain.min).toBe(0)
    expect(domain.max).toBe(10_000_000)
    expect(domain.ticks[0]).toBe(0)
    expect(domain.ticks.at(-1)).toBe(10_000_000)
  })

  it("spans a negative minimum, zero and the maximum with evenly spaced ticks", () => {
    const domain = niceDomain(-1_500_000, 4_000_000)
    expect(domain.min).toBeLessThanOrEqual(-1_500_000)
    expect(domain.max).toBeGreaterThanOrEqual(4_000_000)
    expect(domain.ticks).toContain(0)
    expect(domain.ticks.length).toBeGreaterThanOrEqual(3)
    expect(domain.ticks.length).toBeLessThanOrEqual(7)
    expect(evenlySpaced(domain.ticks)).toBe(true)
  })

  it("always contains zero, even when every value is above it", () => {
    expect(niceDomain(5_000, 9_000).min).toBe(0)
    expect(niceDomain(-9_000, -5_000).max).toBe(0)
  })

  it("uses a 1, 2, 2.5 or 5 step and 3 to 7 ticks across many spans", () => {
    for (const [min, max] of [
      [0, 1],
      [0, 7],
      [0, 99],
      [-3, 250],
      [0, 123_456_789],
      [-987_654, 12],
      [0, 1.234e23],
    ]) {
      const { ticks } = niceDomain(min, max)
      expect(ticks.length, `${min}..${max}`).toBeGreaterThanOrEqual(3)
      expect(ticks.length, `${min}..${max}`).toBeLessThanOrEqual(7)
      const step = ticks[1] - ticks[0]
      const mantissa = Number((step / 10 ** Math.floor(Math.log10(step))).toPrecision(6))
      expect([1, 2, 2.5, 5], `${min}..${max} step ${step}`).toContain(mantissa)
      expect(ticks[0]).toBeLessThanOrEqual(min)
      expect(ticks.at(-1)).toBeGreaterThanOrEqual(max)
    }
  })

  it("still returns a positive span when every value is zero", () => {
    const domain = niceDomain(0, 0)
    expect(domain.max - domain.min).toBeGreaterThan(0)
    expect(domain.ticks.length).toBeGreaterThanOrEqual(3)
  })
})

describe("linePath", () => {
  it("lifts the pen at a gap", () => {
    expect(linePath([{ x: 0, y: 5 }, null, { x: 10, y: 5 }, { x: 20, y: 6 }])).toBe("M0,5M10,5L20,6")
  })

  it("is empty when there is nothing to draw", () => {
    expect(linePath([null, null])).toBe("")
  })
})

describe("formatTick", () => {
  it("labels an axis in compact rupees from paise", () => {
    expect(formatTick(0)).toBe("₹0")
    expect(formatTick(50_000)).toBe("₹500")
    expect(formatTick(250_000)).toBe("₹2.5K")
    expect(formatTick(10_000_000)).toBe("₹1L")
    expect(formatTick(-2_000_000_000)).toBe("-₹2Cr")
  })

  it("prints a 2.5 step exactly, never rounded to one decimal", () => {
    expect(formatTick(12_500_000)).toBe("₹1.25L")
    expect(formatTick(17_500_000)).toBe("₹1.75L")
    expect(formatTick(125_000)).toBe("₹1.25K")
    expect(formatTick(-375_000)).toBe("-₹3.75K")
    expect(formatTick(1_250_000_000)).toBe("₹1.25Cr")
    expect(formatTick(2_250_000_000)).toBe("₹2.25Cr")
    expect(formatTick(75_000_000)).toBe("₹7.5L")
    expect(formatTick(25)).toBe("₹0.25")
  })

  // Every tick niceDomain can produce, over spans from a rupee to a lakh crore, reads back as exactly its value.
  it("labels every tick niceDomain produces with its exact value", () => {
    const UNITS: Record<string, number> = { "": 1, K: 1e3, L: 1e5, Cr: 1e7 }
    const readBack = (label: string) => {
      const match = /^(-?)₹([\d,.]+)(K|L|Cr)?$/.exec(label)
      expect(match, label).not.toBeNull()
      const [, sign, digits, unit = ""] = match as RegExpExecArray
      return (sign ? -1 : 1) * Number(digits.replaceAll(",", "")) * UNITS[unit] * 100
    }
    for (let exponent = 2; exponent <= 15; exponent += 1) {
      for (const mantissa of [1, 1.3, 1.7, 2.2, 3.1, 4.4, 6.5, 8.2, 9.9]) {
        for (const negative of [0, 0.3, 1]) {
          const max = mantissa * 10 ** exponent
          for (const tick of niceDomain(-max * negative, max).ticks) {
            const back = readBack(formatTick(tick))
            expect(Math.abs(back - tick), `${tick} -> ${formatTick(tick)}`).toBeLessThanOrEqual(Math.abs(tick) * 1e-9)
          }
        }
      }
    }
  })

  it("never prints an exponent for a huge tick", () => {
    expect(formatTick(1e23)).not.toMatch(/e|NaN/)
  })
})
