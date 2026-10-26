import { formatPaise } from "../domain/money"
import { basisPoints } from "../domain/valuation"
import type { HoldingView, SalePreviewView } from "./investment-view"
import type { BalanceText } from "./node-money"
import { deserialisePaise } from "./serialise"

// The words the investments screen is made of: a gain with its sign and percentage, what a sale will post, a quantity
// with its unit. Money arrives as paise text and is read back into a bigint only to be printed; the one number is a gain
// in basis points, a small integer, so a percentage is printed by integer division and never by float arithmetic.

/** 935 basis points as "9.35%", -1429 as "-14.29%". */
export function formatBasisPoints(points: number): string {
  const magnitude = Math.abs(points)
  const hundredths = magnitude % 100
  return `${points < 0 ? "-" : ""}${(magnitude - hundredths) / 100}.${String(hundredths).padStart(2, "0")}%`
}

/**
 * An unrealised gain as the screen prints it: "+₹10,000.00 (9.35%)", a loss as "-₹500.00 (-1.20%)" in the negative
 * tone, nothing either way unsigned. The percentage is left out when there is none (nothing held at a cost).
 */
export function describeGain(gainPaise: string, points: number | null): BalanceText {
  const gain = deserialisePaise(gainPaise)
  const percent = points === null ? "" : ` (${formatBasisPoints(points)})`
  const amount = `${gain > 0n ? "+" : ""}${formatPaise(gain)}${percent}`
  return { amount, qualifier: null, tone: gain > 0n ? "positive" : gain < 0n ? "negative" : "muted" }
}

/** What a sale posts, in a line: "Cost basis ₹56,000.00 · gain ₹12,000.00", or "· loss ₹500.00". */
export function describeSaleFigures(preview: Pick<SalePreviewView, "costBasisPaise" | "gainPaise">): string {
  const gain = deserialisePaise(preview.gainPaise)
  const outcome = gain > 0n ? `gain ${formatPaise(gain)}` : gain < 0n ? `loss ${formatPaise(-gain)}` : "no gain or loss"
  return `Cost basis ${formatPaiseText(preview.costBasisPaise)} · ${outcome}`
}

const formatPaiseText = (paise: string) => formatPaise(deserialisePaise(paise))

/** "15 g"; a quantity alone for an investment with no unit. */
export const quantityText = (quantity: string, unit: string | null): string => (unit ? `${quantity} ${unit}` : quantity)

/**
 * The portfolio's unrealised gain as basis points of what its gain is measured against: the cost of the holdings that
 * are revalued (by quantity or as a lump) and have a value. One valued by what was put into it has no gain to measure,
 * and one not valued has none to count, so neither dilutes the figure. Null when that cost is nothing.
 */
export function portfolioGainBasisPoints(holdings: readonly HoldingView[]): number | null {
  let cost = 0n
  let gain = 0n
  for (const holding of holdings) {
    if (holding.valuationMode === "CONTRIBUTION_ONLY" || holding.unrealisedGainPaise === null) continue
    cost += deserialisePaise(holding.costBasisPaise)
    gain += deserialisePaise(holding.unrealisedGainPaise)
  }
  // A handful of digits (see HoldingView.gainBasisPoints), far inside what a number holds exactly.
  return cost > 0n ? Number(basisPoints(gain, cost)) : null
}
