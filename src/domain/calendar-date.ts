// A transaction happens on a day, not at an instant. CalendarDate is that day as a "YYYY-MM-DD" string.
// The database column is a DATE, which Prisma returns as a JS Date pinned to UTC midnight; reading its
// local-time components (or building one with local-time constructors) shifts the day for any process
// not running in UTC. Every crossing between the two representations goes through toDbDate/fromDbDate,
// which use only UTC components, so that bug cannot be written by accident.

export type CalendarDate = string & { readonly __brand: "CalendarDate" }

export class CalendarDateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CalendarDateError"
  }
}

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/

// Years before 1000 are rejected: Date.UTC silently maps years 0-99 to 1900-1999, and no ledger needs them.
const MIN_YEAR = 1000

const pad = (n: number, width: number) => String(n).padStart(width, "0")

/** Validate a "YYYY-MM-DD" string (a real calendar day, years 1000-9999). Throws CalendarDateError. */
export function calendarDate(value: string): CalendarDate {
  const match = DATE_PATTERN.exec(value)
  if (match) {
    const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
    const utc = new Date(Date.UTC(year, month - 1, day))
    if (
      year >= MIN_YEAR &&
      utc.getUTCFullYear() === year &&
      utc.getUTCMonth() === month - 1 &&
      utc.getUTCDate() === day
    ) {
      return value as CalendarDate
    }
  }
  throw new CalendarDateError(`"${value}" is not a valid calendar date (expected YYYY-MM-DD)`)
}

/** Today's date in an IANA timezone, e.g. "Asia/Kolkata". Uses Intl, so DST and zone rules are honoured. */
export function todayIn(timezone: string): CalendarDate {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date())
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? ""
  return calendarDate(`${part("year")}-${part("month")}-${part("day")}`)
}

/** The value to store in a DATE column: midnight UTC on that day. */
export function toDbDate(date: CalendarDate): Date {
  const [, year, month, day] = DATE_PATTERN.exec(date)!.map(Number)
  return new Date(Date.UTC(year, month - 1, day))
}

/** Read a DATE column value. UTC components only: the local-time getters would shift the day outside UTC. */
export function fromDbDate(date: Date): CalendarDate {
  return calendarDate(
    `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1, 2)}-${pad(date.getUTCDate(), 2)}`,
  )
}

export function compareDates(a: CalendarDate, b: CalendarDate): number {
  // Zero-padded YYYY-MM-DD sorts chronologically as plain text.
  return a < b ? -1 : a > b ? 1 : 0
}

const MS_PER_DAY = 86_400_000

/**
 * Whole calendar days from `from` to `to`; negative when `to` is earlier. Both dates become UTC midnight, which
 * has no daylight-saving gaps, so every day is exactly 86,400,000 ms and the process timezone cannot matter.
 */
export function daysBetween(from: CalendarDate, to: CalendarDate): number {
  return (toDbDate(to).getTime() - toDbDate(from).getTime()) / MS_PER_DAY
}

/** The day `days` after `date` (negative for earlier). UTC midnight maths, so no daylight-saving or timezone effect. */
export function addDays(date: CalendarDate, days: number): CalendarDate {
  const moved = toDbDate(date)
  moved.setUTCDate(moved.getUTCDate() + days)
  return fromDbDate(moved)
}

/** ISO weekday of a date: Monday 1 through Sunday 7. getUTCDay counts Sunday as 0, so that is mapped to 7. */
export function isoWeekday(date: CalendarDate): number {
  return toDbDate(date).getUTCDay() || 7
}

function assertMonth(month: number): void {
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new CalendarDateError(`Month must be an integer from 1 to 12, got ${month}`)
  }
}

// Day 0 of the following month is the last day of this one, so the Date constructor does the leap-year maths.
function lastDayOfMonthBefore(year: number, month: number): CalendarDate {
  return fromDbDate(new Date(Date.UTC(year, month - 1, 0)))
}

/** First and last day of a calendar month (month is 1-12). */
export function monthRange(year: number, month: number): { start: CalendarDate; end: CalendarDate } {
  assertMonth(month)
  return {
    start: calendarDate(`${pad(year, 4)}-${pad(month, 2)}-01`),
    end: lastDayOfMonthBefore(year, month + 1),
  }
}

/**
 * The financial year containing `date`, for a year that begins on the 1st of `startMonth` (1-12; April in
 * India). A date earlier in the calendar year than the start month belongs to the year that began the
 * previous calendar year, so 2026-01-15 falls in the year starting 2025-04-01.
 */
export function financialYearRange(
  date: CalendarDate,
  startMonth = 4,
): { start: CalendarDate; end: CalendarDate } {
  assertMonth(startMonth)
  const year = Number(date.slice(0, 4))
  const month = Number(date.slice(5, 7))
  const startYear = month >= startMonth ? year : year - 1
  return {
    start: calendarDate(`${pad(startYear, 4)}-${pad(startMonth, 2)}-01`),
    end: lastDayOfMonthBefore(startYear + 1, startMonth),
  }
}
