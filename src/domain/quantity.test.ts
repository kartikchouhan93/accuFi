import { describe, expect, it } from "vitest"
import {
  QUANTITY_SCALE,
  QuantityParseError,
  formatQuantity,
  parseQuantity,
  quantityFor,
  unitPriceOf,
  valueOf,
} from "./quantity"

describe("parseQuantity", () => {
  it("scales to micro-units", () => {
    expect(QUANTITY_SCALE).toBe(1_000_000n)
    expect(parseQuantity("10")).toBe(10_000_000n)
    expect(parseQuantity("142.3871")).toBe(142_387_100n)
    expect(parseQuantity("0.000001")).toBe(1n)
  })

  it("trims surrounding whitespace", () => {
    expect(parseQuantity("  2.5 ")).toBe(2_500_000n)
  })

  it("accepts the Decimal(18,6) maximum", () => {
    expect(parseQuantity("999999999999.999999")).toBe(999_999_999_999_999_999n)
  })

  it.each([
    ["empty", ""],
    ["zero", "0"],
    ["zero with decimals", "0.000000"],
    ["negative", "-1"],
    ["explicit plus", "+1"],
    ["exponent", "1e3"],
    ["comma decimal", "1,5"],
    ["more than six decimals", "1.1234567"],
    ["no leading digit", ".5"],
    ["no trailing digit", "5."],
    ["letters", "abc"],
    ["more than twelve integer digits", "1000000000000"],
  ])("rejects %s", (_label, input) => {
    expect(() => parseQuantity(input)).toThrow(QuantityParseError)
  })
})

describe("formatQuantity", () => {
  it("drops trailing zeros and the point for whole numbers", () => {
    expect(formatQuantity(10_000_000n)).toBe("10")
    expect(formatQuantity(142_387_100n)).toBe("142.3871")
    expect(formatQuantity(1n)).toBe("0.000001")
    expect(formatQuantity(2_500_000n)).toBe("2.5")
  })

  it("round-trips through parseQuantity for 200 random quantities", () => {
    for (let i = 0; i < 200; i++) {
      const digits = 1 + Math.floor(Math.random() * 18)
      let text = ""
      for (let d = 0; d < digits; d++) text += String(Math.floor(Math.random() * 10))
      const q = BigInt(text) === 0n ? 1n : BigInt(text)
      expect(parseQuantity(formatQuantity(q))).toBe(q)
    }
  })
})

describe("valueOf", () => {
  it("multiplies quantity by price per unit", () => {
    // 15 g at ₹7,800 a gram
    expect(valueOf(15_000_000n, 780_000n)).toBe(11_700_000n)
  })

  it("rounds half up to whole paise", () => {
    expect(valueOf(1n, 1n)).toBe(0n)
    expect(valueOf(500_000n, 1n)).toBe(1n)
    expect(valueOf(499_999n, 1n)).toBe(0n)
  })
})

describe("unitPriceOf", () => {
  it("divides an amount by a quantity", () => {
    expect(unitPriceOf(7_000_000n, 10_000_000n)).toBe(700_000n)
  })

  it("rounds half up to whole paise", () => {
    // 1 paise over 2 units = 0.5 paise a unit
    expect(unitPriceOf(1n, 2_000_000n)).toBe(1n)
  })

  it("refuses a zero quantity", () => {
    expect(() => unitPriceOf(100n, 0n)).toThrow(RangeError)
  })
})

describe("quantityFor", () => {
  it("divides an amount by a price per unit", () => {
    expect(quantityFor(7_000_000n, 700_000n)).toBe(10_000_000n)
  })

  it("rounds half up to a micro-unit", () => {
    // 1 paise at 2 paise a unit = 0.5 unit
    expect(quantityFor(1n, 2n)).toBe(500_000n)
    // 1 paise at 3 paise a unit = 0.333333...
    expect(quantityFor(1n, 3n)).toBe(333_333n)
  })

  it("refuses a zero price", () => {
    expect(() => quantityFor(100n, 0n)).toThrow(RangeError)
  })
})
