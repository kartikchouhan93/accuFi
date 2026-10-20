// Lot allocation: which open lots a disposal consumes, and the cost basis that comes with them.
// Pure and deterministic; the caller supplies each lot's remaining quantity and remaining basis (both derived
// from the ledger, never stored) and gets back one allocation per lot touched, in consumption order.

import { compareDates, type CalendarDate } from "./calendar-date"
import type { LotMethod } from "./ledger-kind"
import type { Paise } from "./money"
import { formatQuantity, type Quantity } from "./quantity"

export interface OpenLot {
  id: string
  acquiredAt: CalendarDate
  /** Tie-break between lots acquired on the same day: the order they were entered. */
  seq: number
  quantityRemaining: Quantity
  costBasisRemainingPaise: Paise
}

export interface LotAllocation {
  lotId: string
  quantity: Quantity
  costBasisPaise: Paise
}

/**
 * More was asked for than the open lots hold (EC-21). The message states both quantities in units (never micro-units),
 * so it can be shown as it is; a caller that knows the investment's name and unit passes a message of its own.
 */
export class InsufficientQuantityError extends Error {
  readonly available: Quantity
  readonly requested: Quantity
  constructor(available: Quantity, requested: Quantity, message?: string) {
    super(message ?? `Only ${formatQuantity(available)} is held, so ${formatQuantity(requested)} cannot be disposed of.`)
    this.name = "InsufficientQuantityError"
    this.available = available
    this.requested = requested
  }
}

const byAcquisition = (a: OpenLot, b: OpenLot): number => compareDates(a.acquiredAt, b.acquiredAt) || a.seq - b.seq

// Remaining unit cost compared by cross-multiplication, so no division and no rounding decides the order.
// Higher unit cost sorts first; equal unit cost falls back to FIFO.
const byHighestCost = (a: OpenLot, b: OpenLot): number => {
  const left = a.costBasisRemainingPaise * b.quantityRemaining
  const right = b.costBasisRemainingPaise * a.quantityRemaining
  if (left !== right) return left > right ? -1 : 1
  return byAcquisition(a, b)
}

const ORDER: Record<LotMethod, (a: OpenLot, b: OpenLot) => number> = {
  FIFO: byAcquisition,
  LIFO: (a, b) => byAcquisition(b, a),
  HIGHEST_COST_FIRST: byHighestCost,
}

// round_half_up(numerator / denominator) for a non-negative numerator and a positive denominator.
function divideRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  return (numerator * 2n + denominator) / (2n * denominator)
}

/**
 * Consume `quantity` from `lots` in the order `method` dictates. A lot taken whole yields its remaining basis
 * exactly; a lot taken in part yields round_half_up(basisRemaining × take ÷ remaining), so successive partial
 * sales of a lot always add up to its true cost. Throws RangeError for a non-positive quantity and
 * InsufficientQuantityError when the lots hold less than asked.
 */
export function allocateLots(lots: readonly OpenLot[], method: LotMethod, quantity: Quantity): LotAllocation[] {
  if (quantity <= 0n) throw new RangeError("quantity must be greater than zero")

  const open = lots.filter((lot) => lot.quantityRemaining > 0n)
  const available = open.reduce((sum, lot) => sum + lot.quantityRemaining, 0n)
  if (quantity > available) throw new InsufficientQuantityError(available, quantity)

  const allocations: LotAllocation[] = []
  let needed = quantity
  for (const lot of open.sort(ORDER[method])) {
    if (needed === 0n) break
    const take = lot.quantityRemaining < needed ? lot.quantityRemaining : needed
    const costBasisPaise =
      take === lot.quantityRemaining
        ? lot.costBasisRemainingPaise
        : divideRoundHalfUp(lot.costBasisRemainingPaise * take, lot.quantityRemaining)
    allocations.push({ lotId: lot.id, quantity: take, costBasisPaise })
    needed -= take
  }
  return allocations
}
