import { describe, expect, it } from "vitest"
import { describeGain, describeRevaluation, describeSaleFigures, formatBasisPoints, priceText, quantityText } from "./investment-text"

describe("formatBasisPoints", () => {
  it("prints basis points as a percentage to two places, in integer arithmetic", () => {
    expect(formatBasisPoints(935)).toBe("9.35%")
    expect(formatBasisPoints(-1429)).toBe("-14.29%")
    expect(formatBasisPoints(5)).toBe("0.05%")
    expect(formatBasisPoints(0)).toBe("0.00%")
    expect(formatBasisPoints(1_000_000)).toBe("10000.00%")
  })
})

describe("describeGain", () => {
  it("signs a gain and puts its percentage beside it", () => {
    expect(describeGain("1000000", 935)).toEqual({ amount: "+₹10,000.00 (9.35%)", qualifier: null, tone: "positive" })
  })

  it("shows a loss with its minus sign and the negative tone", () => {
    expect(describeGain("-50000000", -1000)).toEqual({ amount: "-₹5,00,000.00 (-10.00%)", qualifier: null, tone: "negative" })
  })

  it("leaves the percentage out when there is none, and an even holding unsigned", () => {
    expect(describeGain("0", null)).toEqual({ amount: "₹0.00", qualifier: null, tone: "muted" })
    expect(describeGain("0", 0)).toEqual({ amount: "₹0.00 (0.00%)", qualifier: null, tone: "muted" })
  })
})

describe("describeSaleFigures", () => {
  it("names a gain, a loss, and a sale at cost", () => {
    expect(describeSaleFigures({ costBasisPaise: "5600000", gainPaise: "1200000" })).toBe("Cost basis ₹56,000.00 · gain ₹12,000.00")
    expect(describeSaleFigures({ costBasisPaise: "500000000", gainPaise: "-50000000" })).toBe("Cost basis ₹50,00,000.00 · loss ₹5,00,000.00")
    expect(describeSaleFigures({ costBasisPaise: "100", gainPaise: "0" })).toBe("Cost basis ₹1.00 · no gain or loss")
  })
})

describe("quantityText", () => {
  it("puts the unit after the quantity, when there is one", () => {
    expect(quantityText("15", "g")).toBe("15 g")
    expect(quantityText("142.3871", null)).toBe("142.3871")
    expect(quantityText("3", "")).toBe("3")
  })
})

describe("priceText", () => {
  it("prices a unit, or the whole of a lump", () => {
    expect(priceText("780000", "g", false)).toBe("₹7,800.00 per g")
    expect(priceText("780000", null, false)).toBe("₹7,800.00 per unit")
    expect(priceText("520000000", "flat", true)).toBe("₹52,00,000.00")
  })
})

describe("describeRevaluation", () => {
  it("says the value before and after, and the change with its sign and tone", () => {
    expect(describeRevaluation({ beforePaise: "11700000", afterPaise: "12000000", changePaise: "300000" })).toEqual({
      lead: "Value now ₹1,17,000.00 → ₹1,20,000.00",
      change: { amount: "+₹3,000.00", qualifier: null, tone: "positive" },
    })
    expect(describeRevaluation({ beforePaise: "11700000", afterPaise: "11250000", changePaise: "-450000" })).toEqual({
      lead: "Value now ₹1,17,000.00 → ₹1,12,500.00",
      change: { amount: "-₹4,500.00", qualifier: null, tone: "negative" },
    })
    expect(describeRevaluation({ beforePaise: "100", afterPaise: "100", changePaise: "0" })?.change).toEqual({
      amount: "no change",
      qualifier: null,
      tone: "muted",
    })
  })

  it("has no before figure for an investment that was not valued", () => {
    expect(describeRevaluation({ beforePaise: null, afterPaise: "11700000", changePaise: null })).toEqual({
      lead: "Not valued yet → ₹1,17,000.00",
      change: null,
    })
  })

  it("has nothing to print when no price can value the investment", () => {
    expect(describeRevaluation({ beforePaise: null, afterPaise: null, changePaise: null })).toBeNull()
  })
})
