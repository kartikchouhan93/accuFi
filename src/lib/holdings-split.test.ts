import { describe, expect, it } from "vitest"
import { holdingsSplit } from "@/lib/holdings-split"

describe("holdingsSplit", () => {
  it("divides in proportion, in thousandths", () => {
    expect(holdingsSplit("7500", "2500")).toEqual({ accounts: 750, invested: 250 })
    expect(holdingsSplit("10099950", "1000000")).toEqual({ accounts: 909, invested: 91 })
  })

  it("gives the whole bar to one part when the other is nothing", () => {
    expect(holdingsSplit("500000", "0")).toEqual({ accounts: 1000, invested: 0 })
    expect(holdingsSplit("0", "500000")).toEqual({ accounts: 0, invested: 1000 })
  })

  it("draws no bar when there is nothing held", () => {
    expect(holdingsSplit("0", "0")).toBeNull()
  })

  it("draws no bar when a part is negative, since shares of an overdrawn account mean nothing", () => {
    expect(holdingsSplit("-100", "500")).toBeNull()
    expect(holdingsSplit("500", "-100")).toBeNull()
  })

  it("keeps a small non-zero part visible rather than rounding it away", () => {
    expect(holdingsSplit("100000000", "1")).toEqual({ accounts: 992, invested: 8 })
    expect(holdingsSplit("1", "100000000")).toEqual({ accounts: 8, invested: 992 })
  })

  it("always adds to 1000, across awkward amounts", () => {
    for (const [a, i] of [["1", "2"], ["333", "667"], ["1", "999999"], ["123456789", "987654321"], ["5", "5"]]) {
      const split = holdingsSplit(a, i)
      expect(split && split.accounts + split.invested).toBe(1000)
    }
  })

  it("is exact for amounts beyond what a float can hold", () => {
    // 9_007_199_254_740_993 is 2^53 + 1, which a float cannot represent; the shares must still come out right.
    expect(holdingsSplit("9007199254740993", "9007199254740993")).toEqual({ accounts: 500, invested: 500 })
  })
})
