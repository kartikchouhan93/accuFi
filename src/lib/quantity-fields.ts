// Relative (not "@/") imports: these are value imports and Vitest does not resolve the tsconfig alias in src/lib.
import { MoneyParseError, parseRupees, type Paise } from "../domain/money"
import { formatQuantity, parseQuantity, QuantityParseError, quantityFor, unitPriceOf, valueOf, type Quantity } from "../domain/quantity"
import { serialisePaise } from "./serialise"
import { paiseTextToRupees } from "./transaction-text"

// The purchase form's three linked fields (spec §8.2): enter any two of the amount, the quantity and the price per unit,
// and the third is worked out. Everything is the text of a field, in and out: the arithmetic is the domain's, on paise
// and micro-units, so a figure is exact or rounded half up once, never through a float (EC-1, EC-27). The amount is
// what the form sends with the quantity; the price per unit is only a way of entering them.

export type TripleField = "amount" | "quantity" | "unitPrice"

export interface TripleValues {
  amount: string
  quantity: string
  unitPrice: string
}

// What is worked out when only the field just edited is known: the price, from an amount; the amount, from a quantity
// or a price (a purchase is usually "this many at that price").
const DEFAULT_TARGET: Record<TripleField, TripleField> = { amount: "unitPrice", quantity: "amount", unitPrice: "amount" }
const FIELDS: readonly TripleField[] = ["amount", "quantity", "unitPrice"]

function rupeesOf(text: string): Paise | null {
  try {
    const paise = parseRupees(text)
    return paise > 0n ? paise : null
  } catch (error) {
    if (error instanceof MoneyParseError) return null
    throw error
  }
}

function quantityOf(text: string): Quantity | null {
  try {
    return parseQuantity(text) // never zero; the pattern has no sign
  } catch (error) {
    if (error instanceof QuantityParseError) return null
    throw error
  }
}

const rupeesText = (paise: Paise): string => paiseTextToRupees(serialisePaise(paise))

/**
 * Fill in the third of the linked fields from the two edited most recently: `edited`, the one just changed, and
 * `previous`, the one changed before it (left out, or the same field again, when there was none). The rupee figures
 * are written to 2 places and the quantity to at most 6, trailing zeros dropped. If either of the two does not parse
 * (empty, zero, negative, not a number) or the result would round to zero, the values are returned as they are.
 */
export function completeTriple(edited: TripleField, values: TripleValues, previous?: TripleField): TripleValues {
  const target =
    previous !== undefined && previous !== edited
      ? (FIELDS.find((field) => field !== edited && field !== previous) as TripleField)
      : DEFAULT_TARGET[edited]
  const amount = rupeesOf(values.amount)
  const quantity = quantityOf(values.quantity)
  const price = rupeesOf(values.unitPrice)

  switch (target) {
    case "unitPrice": {
      if (amount === null || quantity === null) return values
      const worked = unitPriceOf(amount, quantity)
      return worked > 0n ? { ...values, unitPrice: rupeesText(worked) } : values
    }
    case "quantity": {
      if (amount === null || price === null) return values
      const worked = quantityFor(amount, price)
      return worked > 0n ? { ...values, quantity: formatQuantity(worked) } : values
    }
    case "amount": {
      if (quantity === null || price === null) return values
      const worked = valueOf(quantity, price)
      return worked > 0n ? { ...values, amount: rupeesText(worked) } : values
    }
  }
}
