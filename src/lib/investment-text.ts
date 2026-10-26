import { formatPaise } from "../domain/money"
import type { HoldingView, QuantityGap, RevaluationPreviewView, SalePreviewView } from "./investment-view"
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
 * A price as the price screen prints it: "₹7,800.00 per g" for an investment valued by quantity ("per unit" without a
 * unit), the figure alone for a lump, whose price is the whole asset's.
 */
export function priceText(paise: string, unit: string | null, lump: boolean): string {
  return lump ? formatPaiseText(paise) : `${formatPaiseText(paise)} per ${unit ?? "unit"}`
}

/**
 * What saving a price would do to today's value, from `previewRevaluation`: the lead ("Value now ₹A → ₹B", or "Not
 * valued yet → ₹B" when there was no value) and the change, signed ("+₹C", "-₹C" in the negative tone, "no change"), or
 * none when there was nothing to change from. Null when no price can value the investment (`afterPaise` is null: some
 * purchases have no quantity), so a screen says why in words and never prints a figure it does not have.
 */
export function describeRevaluation(preview: RevaluationPreviewView): { lead: string; change: BalanceText | null } | null {
  if (preview.afterPaise === null) return null
  const after = formatPaiseText(preview.afterPaise)
  if (preview.beforePaise === null || preview.changePaise === null) return { lead: `Not valued yet → ${after}`, change: null }
  const change = deserialisePaise(preview.changePaise)
  return {
    lead: `Value now ${formatPaiseText(preview.beforePaise)} → ${after}`,
    change:
      change === 0n
        ? { amount: "no change", qualifier: null, tone: "muted" }
        : { amount: `${change > 0n ? "+" : ""}${formatPaise(change)}`, qualifier: null, tone: change > 0n ? "positive" : "negative" },
  }
}

/**
 * How to put right one kind of entry that keeps an investment from being valued (`QuantityGap`), in a sentence. A lump has
 * no quantity to add: its purchase is saved as it is, which records it as the single holding.
 */
export function quantityGapCopy(gap: QuantityGap, lump: boolean): string {
  switch (gap) {
    case "PURCHASE":
      return lump
        ? "Its purchase was recorded before lots existed. Open it on the Transactions screen and save it, and it is recorded as the single holding."
        : "Some purchases have no quantity, so how much is held is not known."
    case "SPLIT_LEG":
      return `A purchase sits inside a split. Take it out of the split first, then ${lump ? "save it" : "add its quantity"}.`
    case "WITHDRAWAL":
      return "A withdrawal was recorded before lots existed. Delete it and record it again with Sell."
  }
}

/** Which purchases a sale takes first, by the investment's lot method (first in, first out when it says nothing). */
export function saleOrderText(method: HoldingView["lotMethod"]): string {
  switch (method) {
    case "LIFO":
      return "Taken from the newest purchases first."
    case "HIGHEST_COST_FIRST":
      return "Taken from the dearest purchases first."
    default:
      return "Taken from the oldest purchases first."
  }
}
