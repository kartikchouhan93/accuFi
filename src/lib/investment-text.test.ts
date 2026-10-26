import { describe, expect, it } from "vitest"
import type { HoldingView } from "./investment-view"
import { describeGain, describeSaleFigures, formatBasisPoints, portfolioGainBasisPoints, quantityText } from "./investment-text"

const holding = (over: Partial<HoldingView>): HoldingView => ({
  nodeId: "n",
  name: "n",
  unitLabel: "g",
  valuationMode: "QUANTITY",
  archived: false,
  quantityHeld: "1",
  costBasisPaise: "0",
  valuePaise: null,
  unrealisedGainPaise: null,
  gainBasisPoints: null,
  price: null,
  notValued: null,
  lotCount: 0,
  ...over,
})

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

describe("portfolioGainBasisPoints", () => {
  it("is the gain over the cost of the revalued holdings that have a value", () => {
    const holdings = [
      holding({ costBasisPaise: "10700000", unrealisedGainPaise: "1000000" }), // gold, valued
      holding({ costBasisPaise: "2000000", notValued: "NO_PRICE" }), // left out: no value, no gain
      holding({ valuationMode: "CONTRIBUTION_ONLY", costBasisPaise: "15000000", unrealisedGainPaise: "0" }), // not revalued
    ]
    expect(portfolioGainBasisPoints(holdings)).toBe(935)
  })

  it("is null when nothing revalued has a value or a cost", () => {
    expect(portfolioGainBasisPoints([holding({ notValued: "NO_PRICE" })])).toBeNull()
    expect(portfolioGainBasisPoints([holding({ costBasisPaise: "0", unrealisedGainPaise: "0" })])).toBeNull()
    expect(portfolioGainBasisPoints([])).toBeNull()
  })
})
