import type { LedgerNode } from "@prisma/client"
import type { CalendarDate } from "../domain/calendar-date"

// Investments as they cross to the browser (spec §7.3, plan calls 6-9): money as paise text (`serialisePaise`), quantities
// as decimal text in units ("142.3871", `formatQuantity`, never micro-units), days as CalendarDate; never a bigint or a
// Date. The one number is `gainBasisPoints`, a small integer the domain computed in bigint.

/**
 * Why an investment has no value (EC-23): it holds a quantity but has no price on or before the day, or some of its
 * entries carry no quantity (made before lots existed, call 7), so its holding is not known.
 */
export type NotValuedReason = "NO_PRICE" | "NEEDS_QUANTITY"

/** What a screen says in place of a figure it does not have. */
export const NOT_VALUED_COPY: Record<NotValuedReason, string> = {
  NO_PRICE: "No price yet",
  NEEDS_QUANTITY: "Some entries need a quantity",
}

/** The day of the price behind a value, and whether it is older than the investment's window (EC-24). */
export interface PriceState {
  asOf: CalendarDate
  stale: boolean
}

export interface HoldingView {
  nodeId: string
  name: string
  unitLabel: string | null
  valuationMode: LedgerNode["valuationMode"]
  archived: boolean
  /** Units held, as decimal text. "0" for an investment valued by what was put into it, which counts no units. */
  quantityHeld: string
  /**
   * Paise. What the units still held cost (the open lots' remaining cost basis); for an investment valued by what was put
   * in, that net contribution. For one that needs a quantity, only the entries that have lots.
   */
  costBasisPaise: string
  /** Paise; null when not valued (see `notValued`), never zero or cost. */
  valuePaise: string | null
  unrealisedGainPaise: string | null
  /** Gain as basis points of cost (935 = 9.35%); null when not valued or nothing is held at a cost. */
  gainBasisPoints: number | null
  /** The price that values the holding: the latest on or before the day. `stale` once older than the node's window. */
  price: { asOf: CalendarDate; pricePerUnitPaise: string; stale: boolean } | null
  notValued: NotValuedReason | null
  /** Live lots acquired by the day, sold out or not: the rows of `HoldingDetail.lots`. */
  lotCount: number
}

export interface LotView {
  id: string
  acquiredAt: CalendarDate
  quantity: string
  quantityRemaining: string
  costBasisPaise: string
  costBasisRemainingPaise: string
}

export interface HoldingDetail extends HoldingView {
  /** Oldest first, as FIFO takes them. */
  lots: LotView[]
  /** Every price of the investment, newest first. */
  prices: { asOf: CalendarDate; pricePerUnitPaise: string }[]
}

export interface Portfolio {
  /** Every investment, archived ones included (`archived` says which): hiding them is the screen's choice. */
  holdings: HoldingView[]
  totals: {
    /** The sum of every holding's `costBasisPaise`. */
    contributedPaise: string
    /** The sum of the holdings that have a value: the ones not valued are left out, and counted in `notValuedCount`. */
    valuePaise: string
    /** The sum of the holdings that have a gain. */
    unrealisedGainPaise: string
    notValuedCount: number
  }
}

/** What a sale would post (`previewSale`), as it crosses to the browser: paise text, quantities in units, days as CalendarDate. */
export interface SalePreviewView {
  /** Paise. What the units sold cost. */
  costBasisPaise: string
  proceedsPaise: string
  /** Paise: proceeds minus cost basis, with a leading "-" for a loss. */
  gainPaise: string
  /** What the sale takes from each lot, in the order the lot method takes them. */
  allocations: { acquiredAt: CalendarDate; quantity: string; costBasisPaise: string }[]
}

/**
 * What entering a price would do to the investment's value today (`previewRevaluation`), as paise text. A figure the
 * investment cannot have is null, never "0" (EC-23): see `RevaluationPreview`.
 */
export interface RevaluationPreviewView {
  beforePaise: string | null
  afterPaise: string | null
  changePaise: string | null
}
