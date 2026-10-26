// Valuing a holding: the open lots of one investment, the latest price on or before a day, and the gain.
// Pure: the caller loads lots (with their live consumptions) and price points and passes them in. Valuation is
// "as of a day": lots acquired after it and disposals made after it do not exist yet at that day.

import { compareDates, daysBetween, type CalendarDate } from "./calendar-date"
import type { OpenLot } from "./lots"
import type { Paise } from "./money"
import { valueOf, type Quantity } from "./quantity"

export interface HoldingLot {
  id: string
  acquiredAt: CalendarDate
  /** Tie-break between lots acquired on the same day: the order they were entered. */
  seq: number
  quantity: Quantity
  costBasisPaise: Paise
  /** Live disposals taken from this lot, each with the cost basis that went with it. */
  consumptions: { quantity: Quantity; costBasisPaise: Paise; disposedAt: CalendarDate }[]
}

/**
 * The lots that still hold something, with remaining quantity and remaining cost basis. With `asOf`, only lots
 * acquired on or before it and consumptions disposed on or before it count. Without it every consumption
 * counts, which is what a new disposal allocates from.
 */
export function openLots(lots: readonly HoldingLot[], asOf?: CalendarDate): OpenLot[] {
  const open: OpenLot[] = []
  for (const lot of lots) {
    if (asOf !== undefined && compareDates(lot.acquiredAt, asOf) > 0) continue
    let quantityRemaining = lot.quantity
    let costBasisRemainingPaise = lot.costBasisPaise
    for (const c of lot.consumptions) {
      if (asOf !== undefined && compareDates(c.disposedAt, asOf) > 0) continue
      quantityRemaining -= c.quantity
      costBasisRemainingPaise -= c.costBasisPaise
    }
    if (quantityRemaining > 0n) {
      open.push({ id: lot.id, acquiredAt: lot.acquiredAt, seq: lot.seq, quantityRemaining, costBasisRemainingPaise })
    }
  }
  return open
}

export interface PricePoint {
  asOf: CalendarDate
  pricePerUnitPaise: Paise
}

/** The point with the latest date on or before `asOf`, whatever order `points` are in (EC-25); null if none. */
export function latestPrice(points: readonly PricePoint[], asOf: CalendarDate): PricePoint | null {
  let latest: PricePoint | null = null
  for (const p of points) {
    if (compareDates(p.asOf, asOf) > 0) continue
    if (latest === null || compareDates(p.asOf, latest.asOf) > 0) latest = p
  }
  return latest
}

export interface Holding {
  quantityHeld: Quantity
  /** Remaining cost basis of the open lots. */
  costBasisPaise: Paise
  price: (PricePoint & { stale: boolean }) | null
  /** Null when quantity is held but no price applies: not valued, never zero or cost (EC-23, EC-24). */
  valuePaise: Paise | null
  unrealisedGainPaise: Paise | null
  /** Gain as basis points of cost (100 = 1%), rounded half away from zero; null when cost is 0 or not valued. */
  gainBasisPoints: bigint | null
}

/**
 * A gain as basis points of its cost (935 is 9.35%): round_half_up on the magnitude, so a loss rounds exactly as the
 * matching gain does. `cost` must be positive.
 */
export function basisPoints(gain: bigint, cost: bigint): bigint {
  const magnitude = gain < 0n ? -gain : gain
  const rounded = (magnitude * 10_000n * 2n + cost) / (2n * cost)
  return gain < 0n ? -rounded : rounded
}

/**
 * The holding on `asOf`: the lots acquired and the disposals made by then. It is priced at the latest point on or before
 * `priceAsOf`, which is `asOf` unless given, and the price is stale once older than `stalePriceDays` on that day. A
 * separate price day values a holding projected to a later day at the prices known today (plan call 6).
 */
export function valueHolding(input: {
  lots: readonly HoldingLot[]
  points: readonly PricePoint[]
  asOf: CalendarDate
  stalePriceDays: number
  priceAsOf?: CalendarDate
}): Holding {
  const open = openLots(input.lots, input.asOf)
  const quantityHeld = open.reduce((sum, l) => sum + l.quantityRemaining, 0n)
  const costBasisPaise = open.reduce((sum, l) => sum + l.costBasisRemainingPaise, 0n)

  const priceAsOf = input.priceAsOf ?? input.asOf
  const latest = latestPrice(input.points, priceAsOf)
  const price = latest && {
    ...latest,
    stale: daysBetween(latest.asOf, priceAsOf) > input.stalePriceDays,
  }

  // Nothing held is worth exactly nothing, priced or not; only a held quantity with no price is "not valued".
  const valuePaise = quantityHeld === 0n ? 0n : latest ? valueOf(quantityHeld, latest.pricePerUnitPaise) : null
  const unrealisedGainPaise = valuePaise === null ? null : valuePaise - costBasisPaise
  const gainBasisPoints =
    unrealisedGainPaise === null || costBasisPaise === 0n ? null : basisPoints(unrealisedGainPaise, costBasisPaise)

  return { quantityHeld, costBasisPaise, price, valuePaise, unrealisedGainPaise, gainBasisPoints }
}
