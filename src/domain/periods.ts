// The date ranges reports are drawn over. A RangeChoice is what the person picked (and what the URL says);
// resolveRange turns it into concrete days, clamped so a report never reaches into the future. Buckets
// slice a range into the months or days a chart plots. Everything is CalendarDate arithmetic, which goes
// through UTC-midnight Dates, so the process timezone cannot move a boundary.

import {
  type CalendarDate,
  CalendarDateError,
  addDays,
  calendarDate,
  compareDates,
  daysBetween,
  financialYearRange,
  monthRange,
} from "./calendar-date"

export type RangeChoice =
  | { kind: "month"; year: number; month: number }
  | { kind: "fy"; startYear: number }
  | { kind: "last12" }
  | { kind: "custom"; from: CalendarDate; to: CalendarDate }

/** A range the person asked for that cannot be reported on; the message is safe to show them. */
export class ReportRangeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ReportRangeError"
  }
}

/** Longest range a report will cover (about ten years), so a custom range cannot ask for unbounded work. */
export const MAX_RANGE_DAYS = 3660

export interface ResolvedRange {
  from: CalendarDate
  /** The last day reported on: `requestedTo`, or today when that is still in the future. */
  to: CalendarDate
  requestedTo: CalendarDate
  clampedToToday: boolean
}

const pad = (n: number, width: number) => String(n).padStart(width, "0")

const minDate = (a: CalendarDate, b: CalendarDate) => (compareDates(a, b) <= 0 ? a : b)
const maxDate = (a: CalendarDate, b: CalendarDate) => (compareDates(a, b) >= 0 ? a : b)

function requestedRange(
  choice: RangeChoice,
  today: CalendarDate,
  fyStartMonth: number,
): { from: CalendarDate; requestedTo: CalendarDate } {
  switch (choice.kind) {
    case "month": {
      const { start, end } = monthRange(choice.year, choice.month)
      return { from: start, requestedTo: end }
    }
    case "fy": {
      const { start, end } = financialYearRange(
        calendarDate(`${pad(choice.startYear, 4)}-${pad(fyStartMonth, 2)}-01`),
        fyStartMonth,
      )
      return { from: start, requestedTo: end }
    }
    case "last12": {
      // The 1st of the month eleven months back, so the window is twelve calendar months ending in this one.
      const year = Number(today.slice(0, 4))
      const month = Number(today.slice(5, 7))
      const first = month - 11 >= 1 ? { year, month: month - 11 } : { year: year - 1, month: month + 1 }
      return { from: monthRange(first.year, first.month).start, requestedTo: today }
    }
    case "custom":
      return { from: choice.from, requestedTo: choice.to }
  }
}

/**
 * The concrete days a choice covers. The end is clamped to `today`. Throws ReportRangeError when the range
 * ends before it starts, starts after today, or is longer than MAX_RANGE_DAYS.
 */
export function resolveRange(choice: RangeChoice, today: CalendarDate, fyStartMonth: number): ResolvedRange {
  const { from, requestedTo } = requestedRange(choice, today, fyStartMonth)
  if (compareDates(requestedTo, from) < 0) {
    throw new ReportRangeError("The end date is before the start date")
  }
  if (compareDates(from, today) > 0) {
    throw new ReportRangeError("The start date is after today")
  }
  const to = minDate(requestedTo, today)
  if (daysBetween(from, to) + 1 > MAX_RANGE_DAYS) {
    throw new ReportRangeError("A report can cover at most 10 years")
  }
  return { from, to, requestedTo, clampedToToday: compareDates(to, requestedTo) < 0 }
}

const MONTH_PARAM = /^month-(\d{4})-(\d{2})$/
const FY_PARAM = /^fy-(\d{4})$/

function parseCustomDate(name: string, value: string | undefined): CalendarDate {
  if (value === undefined) throw new ReportRangeError(`A custom range needs a "${name}" date`)
  try {
    return calendarDate(value)
  } catch (error) {
    if (error instanceof CalendarDateError) {
      throw new ReportRangeError(`"${value}" is not a valid "${name}" date (expected YYYY-MM-DD)`)
    }
    throw error
  }
}

/** Read a RangeChoice from URL search params. Absent `range` means last12; anything unrecognised throws ReportRangeError. */
export function parseRangeChoice(params: { range?: string; from?: string; to?: string }): RangeChoice {
  const { range } = params
  if (range === undefined || range === "last12") return { kind: "last12" }

  const month = MONTH_PARAM.exec(range)
  if (month) {
    const [year, monthNumber] = [Number(month[1]), Number(month[2])]
    if (year >= 1000 && monthNumber >= 1 && monthNumber <= 12) {
      return { kind: "month", year, month: monthNumber }
    }
  }

  const fy = FY_PARAM.exec(range)
  if (fy && Number(fy[1]) >= 1000) return { kind: "fy", startYear: Number(fy[1]) }

  if (range === "custom") {
    return { kind: "custom", from: parseCustomDate("from", params.from), to: parseCustomDate("to", params.to) }
  }

  throw new ReportRangeError(`"${range}" is not a recognised date range`)
}

/** The URL search params that parseRangeChoice reads back into the same choice. */
export function rangeParams(choice: RangeChoice): { range: string; from?: string; to?: string } {
  switch (choice.kind) {
    case "last12":
      return { range: "last12" }
    case "month":
      return { range: `month-${pad(choice.year, 4)}-${pad(choice.month, 2)}` }
    case "fy":
      return { range: `fy-${pad(choice.startYear, 4)}` }
    case "custom":
      return { range: "custom", from: choice.from, to: choice.to }
  }
}

export interface Bucket {
  /** "YYYY-MM" for a month bucket, "YYYY-MM-DD" for a day bucket. */
  key: string
  from: CalendarDate
  to: CalendarDate
  /** True when the bucket covers only part of its calendar month because the range cuts it short. */
  partial: boolean
}

/** One bucket per calendar month the range touches; the first and last are partial when the range cuts into them. */
export function monthBuckets(range: { from: CalendarDate; to: CalendarDate }): Bucket[] {
  const buckets: Bucket[] = []
  let year = Number(range.from.slice(0, 4))
  let month = Number(range.from.slice(5, 7))
  const lastKey = range.to.slice(0, 7)
  for (;;) {
    const key = `${pad(year, 4)}-${pad(month, 2)}`
    const { start, end } = monthRange(year, month)
    buckets.push({
      key,
      from: maxDate(range.from, start),
      to: minDate(range.to, end),
      partial: compareDates(range.from, start) > 0 || compareDates(range.to, end) < 0,
    })
    if (key >= lastKey) return buckets
    month += 1
    if (month > 12) {
      month = 1
      year += 1
    }
  }
}

/** One single-day bucket per day in the range, inclusive. */
export function dayBuckets(range: { from: CalendarDate; to: CalendarDate }): Bucket[] {
  const buckets: Bucket[] = []
  for (let day = range.from; compareDates(day, range.to) <= 0; day = addDays(day, 1)) {
    buckets.push({ key: day, from: day, to: day, partial: false })
  }
  return buckets
}

/**
 * Trim a range so it does not begin before the ledger does: when the first transaction falls inside the range,
 * the start moves to the 1st of that transaction's month and `historyBegins` reports the transaction's day.
 * Otherwise (no transactions, history starting on or before the range, or only after it) nothing changes.
 */
export function clipToHistory(
  range: { from: CalendarDate; to: CalendarDate },
  firstTransaction: CalendarDate | null,
): { from: CalendarDate; to: CalendarDate; historyBegins: CalendarDate | null } {
  if (
    firstTransaction === null ||
    compareDates(firstTransaction, range.from) <= 0 ||
    compareDates(firstTransaction, range.to) > 0
  ) {
    return { from: range.from, to: range.to, historyBegins: null }
  }
  const monthStart = calendarDate(`${firstTransaction.slice(0, 7)}-01`)
  return { from: maxDate(range.from, monthStart), to: range.to, historyBegins: firstTransaction }
}

/** Every calendar month from the first transaction's to today's, newest first; empty if history starts in the future. */
export function selectableMonths(first: CalendarDate, today: CalendarDate): { year: number; month: number }[] {
  const months: { year: number; month: number }[] = []
  let year = Number(today.slice(0, 4))
  let month = Number(today.slice(5, 7))
  const firstKey = first.slice(0, 7)
  while (`${pad(year, 4)}-${pad(month, 2)}` >= firstKey) {
    months.push({ year, month })
    month -= 1
    if (month < 1) {
      month = 12
      year -= 1
    }
  }
  return months
}

/** Start years of every financial year from the one containing the first transaction to the one containing today, newest first. */
export function selectableFinancialYears(first: CalendarDate, today: CalendarDate, fyStartMonth: number): number[] {
  const startYear = (date: CalendarDate) => Number(financialYearRange(date, fyStartMonth).start.slice(0, 4))
  const years: number[] = []
  for (let year = startYear(today); year >= startYear(first); year -= 1) years.push(year)
  return years
}
