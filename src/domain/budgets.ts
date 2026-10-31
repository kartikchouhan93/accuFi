// Budget arithmetic: what a monthly cap leaves, how far through it the spending is, and where the month is heading.
// Pure: the caller sums spending per month in SQL and passes it in. A budget warns; it never blocks or borrows, so
// overspending shows as OVER and does not reduce the next month's allowance. Months are CalendarDates of the first
// day, and every step goes through the UTC-only helpers in calendar-date.ts, so the process timezone cannot matter.
// Money stays Paise (bigint) throughout: percent and projection use the half-up integer form `shareTenths` does.

import { addMonths, compareDates, daysBetween, daysInMonth, monthOf, type CalendarDate } from "./calendar-date"
import type { LedgerKind, SystemNodeRole } from "./ledger-kind"
import type { Paise } from "./money"

/** From this share of what is available, a budget is NEAR (80.0%, in tenths of a percent). */
export const NEAR_PERCENT_TENTHS = 800n

/** A projection from fewer days of data than this is noise (one big shop on the 2nd forecasts an absurd month). */
export const PROJECTION_MIN_DAYS = 7

/** One budget of one ledger: a monthly cap for a run of months. `endMonth` is inclusive; null runs on indefinitely. */
export interface BudgetSpan {
  id: string
  nodeId: string
  amountPaise: Paise
  startMonth: CalendarDate
  endMonth: CalendarDate | null
  rollover: boolean
}

export type BudgetStatus = "ON_TRACK" | "NEAR" | "OVER"

type MonthSpan = Pick<BudgetSpan, "startMonth" | "endMonth">

/** True when the two spans share at least one month. Ends are inclusive and null is open-ended. */
export function spansOverlap(a: MonthSpan, b: MonthSpan): boolean {
  const aStartsBeforeBEnds = b.endMonth === null || compareDates(a.startMonth, b.endMonth) <= 0
  const bStartsBeforeAEnds = a.endMonth === null || compareDates(b.startMonth, a.endMonth) <= 0
  return aStartsBeforeBEnds && bStartsBeforeAEnds
}

/**
 * The ledgers a budget on `nodeId` counts: the node itself, then its children that are expenses and not system nodes,
 * in input order. Archived children are included on purpose: what was spent on them still happened. A system node (a
 * realised loss, say) is never budgetable and never counted, and a child of another parent is not this one's.
 */
export function countedNodeIds(
  nodeId: string,
  nodes: readonly { id: string; parentId: string | null; kind: LedgerKind; systemRole: SystemNodeRole | null }[],
): string[] {
  const children = nodes.filter((n) => n.parentId === nodeId && n.kind === "EXPENSE" && n.systemRole === null)
  return [nodeId, ...children.map((n) => n.id)]
}

/**
 * `used` as tenths of a percent of `available` (852 is 85.2%), rounded half up: `used × 1000 ÷ available`, computed as
 * `(used × 2000 + available) ÷ (2 × available)` so it stays exact in bigint. Null when nothing positive is available
 * to take a share of, or when `used` is negative (a net refund has no share).
 */
export function percentTenths(used: Paise, available: Paise): bigint | null {
  if (available <= 0n || used < 0n) return null
  return (used * 2000n + available) / (2n * available)
}

/**
 * OVER when used exceeds available, by comparison and not by the rounded percent (10,001 of 10,000 rounds to 100.0%
 * but is over). NEAR from 80.0% up to and including the cap. Otherwise ON_TRACK, which includes a net refund and
 * nothing spent against nothing available (neither has a percent).
 */
export function statusOf(used: Paise, available: Paise): BudgetStatus {
  if (used > available) return "OVER"
  const percent = percentTenths(used, available)
  return percent !== null && percent >= NEAR_PERCENT_TENTHS ? "NEAR" : "ON_TRACK"
}

/**
 * Where the month ends up at the current pace: `used × days in month ÷ days elapsed`, half up. Only for the month
 * `today` is in, only once PROJECTION_MIN_DAYS days have elapsed (today counts), and only when something was spent.
 * Null otherwise: a finished month is already its own total and a future one has no pace.
 */
export function projectionOf(used: Paise, month: CalendarDate, today: CalendarDate): Paise | null {
  if (monthOf(today) !== month || used <= 0n) return null
  const elapsed = daysBetween(month, today) + 1
  if (elapsed < PROJECTION_MIN_DAYS) return null
  const wholeMonth = BigInt(daysInMonth(month))
  const days = BigInt(elapsed)
  return (used * wholeMonth * 2n + days) / (2n * days)
}

export interface MonthFigures {
  month: CalendarDate
  budgetId: string
  capPaise: Paise
  carryPaise: Paise
  availablePaise: Paise
  usedPaise: Paise
  remainingPaise: Paise
  percentTenths: bigint | null
  status: BudgetStatus
  projectionPaise: Paise | null
  /** The projection exceeds what is available: heading over although not over yet. */
  overAtPace: boolean
}

/**
 * Every budgeted month of one ledger, from the earliest span's start through the current month, oldest first. A span
 * covers its start month through its end month (or open); months after the current one are never listed, and a month
 * no span covers is skipped. `usedByMonth` is keyed by first-of-month; a missing month has used 0.
 *
 * Rollover: the carry into a month is `max(0, available − used)` of the month before, but only when that month is
 * budgeted and both months have rollover on. A gap month or a rollover-off month resets it to 0. The chain follows
 * months, not spans, so it runs on across a split where the amount changes. Overspending carries 0, not a debt.
 * Spans of a ledger must not overlap (the service enforces it); were they to, the earliest-starting one wins a month.
 */
export function evaluateMonths(
  spans: readonly BudgetSpan[],
  usedByMonth: ReadonlyMap<CalendarDate, Paise>,
  today: CalendarDate,
): MonthFigures[] {
  const currentMonth = monthOf(today)
  const ordered = [...spans].sort((a, b) => compareDates(a.startMonth, b.startMonth))
  if (ordered.length === 0 || compareDates(ordered[0].startMonth, currentMonth) > 0) return []

  const spanFor = (month: CalendarDate) =>
    ordered.find(
      (s) => compareDates(s.startMonth, month) <= 0 && (s.endMonth === null || compareDates(month, s.endMonth) <= 0),
    )

  const rows: MonthFigures[] = []
  // What the previous month hands on, or null when the previous month was unbudgeted or has rollover off.
  let carryOut: Paise | null = null

  for (let month = ordered[0].startMonth; compareDates(month, currentMonth) <= 0; month = addMonths(month, 1)) {
    const budget = spanFor(month)
    if (!budget) {
      carryOut = null
      continue
    }

    const carryPaise: Paise = budget.rollover && carryOut !== null ? carryOut : 0n
    const availablePaise: Paise = budget.amountPaise + carryPaise
    const usedPaise = usedByMonth.get(month) ?? 0n
    const remainingPaise: Paise = availablePaise - usedPaise
    const projectionPaise = projectionOf(usedPaise, month, today)

    rows.push({
      month,
      budgetId: budget.id,
      capPaise: budget.amountPaise,
      carryPaise,
      availablePaise,
      usedPaise,
      remainingPaise,
      percentTenths: percentTenths(usedPaise, availablePaise),
      status: statusOf(usedPaise, availablePaise),
      projectionPaise,
      overAtPace: projectionPaise !== null && projectionPaise > availablePaise,
    })

    carryOut = budget.rollover ? (remainingPaise > 0n ? remainingPaise : 0n) : null
  }

  return rows
}
