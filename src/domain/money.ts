// Money primitives. Every monetary value is integer paise held as a bigint
// (₹1,234.56 === 123456n). No floats, no decimal libraries, no I/O.

export type Paise = bigint

export class MoneyParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "MoneyParseError"
  }
}

// Plain digits, Indian grouping (1,23,456) or Western grouping (123,456), then up to two decimals.
const RUPEES_PATTERN = /^(-?)(\d+|\d{1,2}(?:,\d{2})*,\d{3}|\d{1,3}(?:,\d{3})+)(?:\.(\d{1,2}))?$/

/** Parse a rupee string such as "1,23,456.78" into paise. Throws MoneyParseError on bad input. */
export function parseRupees(input: string): Paise {
  const match = RUPEES_PATTERN.exec(input.trim())
  if (!match) {
    throw new MoneyParseError(`Cannot parse "${input}" as a rupee amount (use at most two decimal places)`)
  }
  const [, sign, whole, fraction = ""] = match
  const magnitude = BigInt(whole.replaceAll(",", "")) * 100n + BigInt(fraction.padEnd(2, "0"))
  return sign === "-" ? -magnitude : magnitude
}

const GROUPING = new Intl.NumberFormat("en-IN")

/** Format paise as "₹1,23,456.78"; negatives render as "-₹1,23,456.78". */
export function formatPaise(amount: Paise): string {
  const negative = amount < 0n
  const magnitude = negative ? -amount : amount
  const rupees = GROUPING.format(magnitude / 100n)
  const paise = String(magnitude % 100n).padStart(2, "0")
  return `${negative ? "-" : ""}₹${rupees}.${paise}`
}

/**
 * Split `total` across `weights` proportionally, in whole paise, so the legs sum to `total` exactly.
 * Each leg starts at floor(|total| * weight / totalWeight); the leftover paise are handed out one at a
 * time to the legs with the largest fractional remainder, ties broken by lower index. A negative total
 * is allocated by magnitude and negated. Zero-weight legs always receive zero.
 */
export function allocate(total: Paise, weights: readonly bigint[]): Paise[] {
  if (weights.length === 0) throw new RangeError("allocate requires at least one weight")
  if (weights.some((w) => w < 0n)) throw new RangeError("allocate weights must not be negative")
  const totalWeight = weights.reduce((sum, w) => sum + w, 0n)
  if (totalWeight === 0n) throw new RangeError("allocate requires at least one positive weight")

  const negative = total < 0n
  const magnitude = negative ? -total : total

  const legs = weights.map((w) => (magnitude * w) / totalWeight)
  const remainders = weights.map((w) => (magnitude * w) % totalWeight)

  let leftover = magnitude - legs.reduce((sum, leg) => sum + leg, 0n)
  const order = weights
    .map((_, index) => index)
    .sort((a, b) => (remainders[a] === remainders[b] ? a - b : remainders[a] > remainders[b] ? -1 : 1))
  for (const index of order) {
    if (leftover === 0n) break
    legs[index] += 1n
    leftover -= 1n
  }

  const result = negative ? legs.map((leg) => -leg) : legs
  if (result.reduce((sum, leg) => sum + leg, 0n) !== total) {
    throw new Error("allocate invariant violated: legs do not sum to the total")
  }
  return result
}
