import { describe, expect, it } from "vitest"
import { describeBalance, describeOpening, describeResidual, formatPaiseText } from "./node-money"

describe("describeBalance", () => {
  it("shows a liability you owe on as the amount owed, negated once", () => {
    expect(describeBalance("LIABILITY", "-1200000")).toEqual({ amount: "₹12,000.00", qualifier: "owed", tone: "negative" })
  })

  it("shows a liability in credit as credit", () => {
    expect(describeBalance("LIABILITY", "50000")).toEqual({ amount: "₹500.00", qualifier: "in credit", tone: "positive" })
  })

  it("shows an overdrawn account with its sign, in the negative tone", () => {
    expect(describeBalance("ASSET", "-200000")).toEqual({ amount: "-₹2,000.00", qualifier: null, tone: "negative" })
  })

  it("shows an account with money in it plainly", () => {
    expect(describeBalance("ASSET", "12500050")).toEqual({ amount: "₹1,25,000.50", qualifier: null, tone: "neutral" })
  })

  it("shows income as received and expense as spent, the way round a reader expects", () => {
    // Income flows out of its node, so its balance is negative; "received" is the magnitude, not the signed figure.
    expect(describeBalance("INCOME_SOURCE", "-3000000")).toMatchObject({ amount: "₹30,000.00", qualifier: "received" })
    expect(describeBalance("EXPENSE", "45000")).toMatchObject({ amount: "₹450.00", qualifier: "spent" })
  })

  it("calls an expense that has been refunded past what was spent a net refund, not a negative amount spent", () => {
    // EC-20 allows the total to go below zero (a refund larger than the spend). "-₹500.00 spent" is the wrong word for it.
    expect(describeBalance("EXPENSE", "-50000")).toEqual({ amount: "₹500.00", qualifier: "net refund", tone: "neutral" })
    expect(describeBalance("EXPENSE", "-1")).toMatchObject({ amount: "₹0.01", qualifier: "net refund" })
    // Anything above zero is still spend.
    expect(describeBalance("EXPENSE", "1")).toMatchObject({ amount: "₹0.01", qualifier: "spent" })
  })

  it("mutes a zero balance whatever the kind, with no qualifier", () => {
    for (const kind of ["ASSET", "INVESTMENT", "LIABILITY", "INCOME_SOURCE", "EXPENSE"] as const) {
      expect(describeBalance(kind, "0")).toEqual({ amount: "₹0.00", qualifier: null, tone: "muted" })
    }
  })

  it("reads a figure beyond the safe integer range exactly", () => {
    expect(formatPaiseText("900719925474099300")).toBe("₹9,00,71,99,25,47,40,993.00")
  })
})

describe("describeResidual", () => {
  it("phrases what each holding kind still has", () => {
    expect(describeResidual("ASSET", "500000")).toBe("still holds ₹5,000.00")
    expect(describeResidual("ASSET", "-100")).toBe("is still overdrawn by ₹1.00")
    expect(describeResidual("INVESTMENT", "250000")).toBe("still holds ₹2,500.00")
    expect(describeResidual("LIABILITY", "-1200000")).toBe("still has ₹12,000.00 owed")
    expect(describeResidual("LIABILITY", "100")).toBe("is still ₹1.00 in credit")
  })

  it("has nothing to say about a zero balance or a flow node", () => {
    expect(describeResidual("ASSET", "0")).toBeNull()
    expect(describeResidual("EXPENSE", "99900")).toBeNull()
    expect(describeResidual("INCOME_SOURCE", "-99900")).toBeNull()
  })
})

describe("describeOpening", () => {
  it("says which way the sign goes for an account", () => {
    expect(describeOpening("ASSET", "positive", "2,000")).toBe("You hold ₹2,000.00 in this account")
    expect(describeOpening("ASSET", "negative", "2,000")).toBe("You owe ₹2,000.00 on this account")
  })

  it("says which way the sign goes for a liability", () => {
    expect(describeOpening("LIABILITY", "negative", "12000.5")).toBe("You owe ₹12,000.50 on this liability")
    expect(describeOpening("LIABILITY", "positive", "10")).toBe("You are ₹10.00 in credit on this liability")
  })

  it("says nothing while the amount is not a usable amount", () => {
    for (const text of ["", "abc", "0", "0.00", "-5", "1.234"]) expect(describeOpening("ASSET", "positive", text), text).toBeNull()
  })
})
