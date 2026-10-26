import type { LedgerNode } from "@prisma/client"
import { compareDates, type CalendarDate } from "@/domain/calendar-date"
import type { Paise } from "@/domain/money"
import { deletePrice as deletePriceRow, upsertPrice } from "@/server/repositories/price-repository"
import { todayFor } from "@/server/services/clock"
import { readHoldingInputs, valueAt } from "@/server/services/investment-service"
import { lotModeOf } from "@/server/services/lot-rules"
import { requireNode } from "@/server/services/transaction-service"

// Entering prices by hand (spec §7.3, plan calls 8 and 9, EC-25, EC-26). A price is the value of one unit of an investment
// valued by quantity, or of the whole asset for one valued as a lump (EC-30), on a day. Only those two are revalued: an
// investment valued by what was put into it has no price. A price may be dated any day up to the user's today, earlier
// than prices already entered included (EC-25: the value on a day is always the latest price on or before it); a day
// after today is a forecast, not a price (call 8). Entering a day again replaces its price (EC-26).

/** Each refusal belongs to one form field: NOT_REVALUED to the investment, PRICE_AFTER_TODAY to the date, PRICE_NOT_POSITIVE to the price. */
export type PriceRuleCode = "NOT_REVALUED" | "PRICE_AFTER_TODAY" | "PRICE_NOT_POSITIVE"

/** The price breaks a rule. Nothing was written; the message is safe to show the user. */
export class InvalidPriceError extends Error {
  constructor(
    readonly code: PriceRuleCode,
    message: string,
  ) {
    super(message)
    this.name = "InvalidPriceError"
  }
}

export interface PriceInput {
  nodeId: string
  asOf: CalendarDate
  /** Paise for one unit (for a lump, the whole asset). */
  pricePerUnit: Paise
}

/** The caller's investment the price is for, and the user's today, once every rule is met. */
async function checkPrice(userId: string, input: PriceInput): Promise<{ node: LedgerNode; today: CalendarDate }> {
  const node = await requireNode(userId, input.nodeId) // another user's node is NotFoundError (EC-8)
  if (lotModeOf(node) === null) {
    throw new InvalidPriceError(
      "NOT_REVALUED",
      node.kind === "INVESTMENT"
        ? "This investment is not revalued: it is valued by what was put into it."
        : `${node.name} is not an investment, so it has no price.`,
    )
  }
  const today = await todayFor(userId)
  if (compareDates(input.asOf, today) > 0) {
    throw new InvalidPriceError("PRICE_AFTER_TODAY", "A price cannot be dated after today.")
  }
  if (input.pricePerUnit <= 0n) throw new InvalidPriceError("PRICE_NOT_POSITIVE", "Enter a price greater than zero.")
  return { node, today }
}

/**
 * Record the price of one unit of an investment on a day, replacing any price that day already has (EC-26). Throws
 * InvalidPriceError for an investment that is not revalued (or a node that is not an investment), a day after today
 * (call 8) or a price of zero or less; NotFoundError for another user's node (EC-8). Nothing is written when refused.
 */
export async function recordPrice(userId: string, input: PriceInput): Promise<void> {
  await checkPrice(userId, input)
  await upsertPrice(userId, { nodeId: input.nodeId, asOf: input.asOf, pricePerUnitPaise: input.pricePerUnit })
}

/** Delete the investment's price for one day. NotFoundError if the node is not the user's, or has no price that day. */
export async function deletePrice(userId: string, nodeId: string, asOf: CalendarDate): Promise<void> {
  await requireNode(userId, nodeId)
  await deletePriceRow(userId, nodeId, asOf)
}

export interface RevaluationPreview {
  /** Today's value with the prices as they are; null when not valued. */
  beforePaise: Paise | null
  /**
   * Today's value with the proposed price saved. Null only for an investment with entries that carry no quantity
   * (call 7): no price values it until they have one.
   */
  afterPaise: Paise | null
  /** After minus before; null when either is. */
  changePaise: Paise | null
}

/**
 * What saving the price would do to the investment's value today, before it is saved: the price-entry screen shows it.
 * Writes nothing. Refuses exactly what recordPrice refuses, with the same errors. The proposed price replaces any of the
 * same day, as saving it would; one dated before the latest price changes nothing today (EC-25), and says so.
 */
export async function previewRevaluation(userId: string, input: PriceInput): Promise<RevaluationPreview> {
  const { node, today } = await checkPrice(userId, input)
  const inputs = await readHoldingInputs(userId, node.id)
  const proposed = [
    ...inputs.points.filter((point) => point.asOf !== input.asOf),
    { asOf: input.asOf, pricePerUnitPaise: input.pricePerUnit },
  ]
  const beforePaise = valueAt(inputs, today)
  const afterPaise = valueAt({ ...inputs, points: proposed }, today)
  return {
    beforePaise,
    afterPaise,
    changePaise: beforePaise === null || afterPaise === null ? null : afterPaise - beforePaise,
  }
}
