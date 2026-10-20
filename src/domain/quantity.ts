// Quantity primitives for lot-tracked investments. A quantity is a scaled bigint of micro-units
// (1 unit === 1_000_000n), matching Decimal(18,6) in Postgres. No floats (EC-27), no I/O.
// Display precision (gold 3 dp, mutual funds 4 dp, lump assets 1) is a presentation concern; the
// domain accepts up to six decimals.

import type { Paise } from "./money"

export type Quantity = bigint

export const QUANTITY_SCALE = 1_000_000n

export class QuantityParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "QuantityParseError"
  }
}

// Up to 12 integer digits and 6 decimals (Decimal(18,6)); no sign, exponent, grouping or bare point.
const QUANTITY_PATTERN = /^(\d{1,12})(?:\.(\d{1,6}))?$/

/** Parse a decimal string such as "142.3871" into micro-units. Throws QuantityParseError on bad input or zero. */
export function parseQuantity(text: string): Quantity {
  const match = QUANTITY_PATTERN.exec(text.trim())
  if (!match) {
    throw new QuantityParseError(`Cannot parse "${text}" as a quantity (up to 12 digits and 6 decimal places)`)
  }
  const [, whole, fraction = ""] = match
  const micro = BigInt(whole) * QUANTITY_SCALE + BigInt(fraction.padEnd(6, "0"))
  if (micro === 0n) {
    throw new QuantityParseError("A quantity must be greater than zero")
  }
  return micro
}

/** Format micro-units as a plain decimal string with trailing zeros dropped: 142_387_100n -> "142.3871". */
export function formatQuantity(q: Quantity): string {
  const negative = q < 0n
  const magnitude = negative ? -q : q
  const whole = magnitude / QUANTITY_SCALE
  const fraction = String(magnitude % QUANTITY_SCALE)
    .padStart(6, "0")
    .replace(/0+$/, "")
  return `${negative ? "-" : ""}${whole}${fraction === "" ? "" : `.${fraction}`}`
}

/** round_half_up(numerator / denominator) for a non-negative numerator and a positive denominator. */
function divideRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  return (numerator * 2n + denominator) / (2n * denominator)
}

function requireNonNegative(name: string, value: bigint): void {
  if (value < 0n) throw new RangeError(`${name} must not be negative`)
}

function requirePositive(name: string, value: bigint): void {
  if (value <= 0n) throw new RangeError(`${name} must be greater than zero`)
}

/** Value of `q` units at `pricePerUnit` paise a unit, rounded half up to whole paise. */
export function valueOf(q: Quantity, pricePerUnit: Paise): Paise {
  requireNonNegative("quantity", q)
  requireNonNegative("price", pricePerUnit)
  return divideRoundHalfUp(q * pricePerUnit, QUANTITY_SCALE)
}

/** Price per unit implied by paying `amount` for `q` units, rounded half up to whole paise. */
export function unitPriceOf(amount: Paise, q: Quantity): Paise {
  requireNonNegative("amount", amount)
  requirePositive("quantity", q)
  return divideRoundHalfUp(amount * QUANTITY_SCALE, q)
}

/** Quantity that `amount` buys at `pricePerUnit` paise a unit, rounded half up to a micro-unit. */
export function quantityFor(amount: Paise, pricePerUnit: Paise): Quantity {
  requireNonNegative("amount", amount)
  requirePositive("price", pricePerUnit)
  return divideRoundHalfUp(amount * QUANTITY_SCALE, pricePerUnit)
}
