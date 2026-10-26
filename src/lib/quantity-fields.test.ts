import { describe, expect, it } from "vitest"
import { completeTriple } from "./quantity-fields"

// The purchase form's three linked fields: enter any two of amount, quantity and price per unit and the third is worked
// out, in text, exactly (bigint arithmetic, never a float).

describe("completeTriple", () => {
  it("works out the price per unit from the amount and the quantity", () => {
    expect(completeTriple("amount", { amount: "70000", quantity: "10", unitPrice: "" })).toEqual({
      amount: "70000",
      quantity: "10",
      unitPrice: "7000.00",
    })
  })

  it("recomputes the amount when the quantity is edited with the amount and price present", () => {
    expect(completeTriple("quantity", { amount: "70000", quantity: "5", unitPrice: "7400" })).toEqual({
      amount: "37000.00",
      quantity: "5",
      unitPrice: "7400",
    })
  })

  it("recomputes the amount when the price is edited", () => {
    expect(completeTriple("unitPrice", { amount: "", quantity: "2.5", unitPrice: "7,800.50" })).toEqual({
      amount: "19501.25",
      quantity: "2.5",
      unitPrice: "7,800.50",
    })
  })

  it("fills the field that was not one of the two edited last", () => {
    // Amount, then price: the quantity is what is left to work out, to 6 places with trailing zeros dropped.
    expect(completeTriple("unitPrice", { amount: "70,000", quantity: "", unitPrice: "7000" }, "amount")).toEqual({
      amount: "70,000",
      quantity: "10",
      unitPrice: "7000",
    })
    expect(completeTriple("unitPrice", { amount: "1000", quantity: "", unitPrice: "3" }, "amount").quantity).toBe("333.333333")
    // Quantity, then amount: the price.
    expect(completeTriple("amount", { amount: "37000", quantity: "5", unitPrice: "1" }, "quantity").unitPrice).toBe("7400.00")
    // Price, then quantity: the amount.
    expect(completeTriple("quantity", { amount: "1", quantity: "0.25", unitPrice: "96000" }, "unitPrice").amount).toBe("24000.00")
  })

  it("rounds half up to whole paise and to a micro-unit", () => {
    expect(completeTriple("amount", { amount: "100", quantity: "3", unitPrice: "" }).unitPrice).toBe("33.33")
    expect(completeTriple("amount", { amount: "200", quantity: "3", unitPrice: "" }).unitPrice).toBe("66.67")
    expect(completeTriple("quantity", { amount: "", quantity: "0.001", unitPrice: "4999.99" }).amount).toBe("5.00") // 4.99999
    expect(completeTriple("unitPrice", { amount: "100", quantity: "", unitPrice: "3" }, "amount").quantity).toBe("33.333333")
    expect(completeTriple("unitPrice", { amount: "200", quantity: "", unitPrice: "3" }, "amount").quantity).toBe("66.666667")
  })

  it("leaves everything as it was when either input does not parse", () => {
    const cases = [
      { amount: "70000", quantity: "", unitPrice: "" },
      { amount: "70000", quantity: "0", unitPrice: "" },
      { amount: "70000", quantity: "-1", unitPrice: "" },
      { amount: "70000", quantity: "ten", unitPrice: "" },
      { amount: "70000", quantity: "1.1234567", unitPrice: "" },
      { amount: "0", quantity: "10", unitPrice: "" },
      { amount: "-5", quantity: "10", unitPrice: "" },
      { amount: "1.234", quantity: "10", unitPrice: "" },
    ]
    for (const values of cases) expect(completeTriple("amount", values), JSON.stringify(values)).toEqual(values)
    const noPrice = { amount: "", quantity: "10", unitPrice: "abc" }
    expect(completeTriple("quantity", noPrice)).toEqual(noPrice)
  })

  it("never writes a zero: a figure too small to round to a paisa or a micro-unit is left alone", () => {
    const tiny = { amount: "", quantity: "0.000001", unitPrice: "4" }
    expect(completeTriple("quantity", tiny)).toEqual(tiny) // 0.000004 rupees is no paisa
    const cheap = { amount: "0.01", quantity: "", unitPrice: "1,00,00,000" }
    expect(completeTriple("unitPrice", cheap, "amount")).toEqual(cheap) // a tenth of a micro-unit
  })

  it("treats a repeat of the edited field as no earlier field", () => {
    expect(completeTriple("amount", { amount: "70000", quantity: "10", unitPrice: "1" }, "amount").unitPrice).toBe("7000.00")
  })
})
