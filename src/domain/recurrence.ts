// A recurring entry is a rule, and this file is the whole rule: given a schedule it says which days are due.
// Everything here is a pure function of CalendarDate strings, built on UTC midnight maths, so the process
// timezone and daylight-saving changes cannot move a date (a day is always 24 hours at UTC midnight).
//
// The one design decision that matters: the nth date is computed from the anchor (the start date) and n,
// never from the previous result. Stepping from the previous date would carry a February clamp into every
// later month (31 Jan, 28 Feb, 28 Mar ...); computing from the anchor gives 31 Jan, 28 Feb, 31 Mar.

import { addDays, calendarDate, compareDates, daysBetween, isoWeekday, type CalendarDate } from "./calendar-date"

export const RECURRENCE_FREQUENCIES = ["DAILY", "WEEKLY", "MONTHLY", "QUARTERLY", "YEARLY"] as const
export type RecurrenceFrequency = (typeof RECURRENCE_FREQUENCIES)[number]

/** The most dates one call may produce in a single sweep run: a long outage catches up in bounded batches. */
export const MAX_DUE_PER_RUN = 100
export const INTERVAL_MAX = 99
export const OCCURRENCE_LIMIT_MAX = 1000

export interface Schedule {
  frequency: RecurrenceFrequency
  interval: number
  /** 1-31 for MONTHLY, QUARTERLY and YEARLY; 31 means "the last day" because a short month clamps it. */
  dayOfMonth: number | null
  /** ISO weekday, 1 = Monday ... 7 = Sunday; WEEKLY only. */
  dayOfWeek: number | null
  startDate: CalendarDate
  endDate: CalendarDate | null
  occurrenceLimit: number | null
}

export interface ScheduleViolation {
  field: "interval" | "dayOfMonth" | "dayOfWeek" | "endDate" | "occurrenceLimit"
  message: string
}

const dayOfMonthOf = (date: CalendarDate) => Number(date.slice(8, 10))

/**
 * Fill in what the frequency needs and clear what it does not, so a stored schedule never carries a stale
 * weekday on a monthly rule. A missing day defaults to the start date's own day or weekday.
 */
export function normaliseSchedule(
  input: Omit<Schedule, "dayOfMonth" | "dayOfWeek"> & { dayOfMonth?: number | null; dayOfWeek?: number | null },
): Schedule {
  const { dayOfMonth, dayOfWeek, ...rest } = input
  switch (input.frequency) {
    case "DAILY":
      return { ...rest, dayOfMonth: null, dayOfWeek: null }
    case "WEEKLY":
      return { ...rest, dayOfMonth: null, dayOfWeek: dayOfWeek ?? isoWeekday(input.startDate) }
    default:
      return { ...rest, dayOfMonth: dayOfMonth ?? dayOfMonthOf(input.startDate), dayOfWeek: null }
  }
}

const isIntegerInRange = (value: number | null, min: number, max: number): value is number =>
  value !== null && Number.isInteger(value) && value >= min && value <= max

/** Everything wrong with a schedule, worded for the person filling in the form; empty when it is sound. */
export function scheduleViolations(schedule: Schedule): ScheduleViolation[] {
  const violations: ScheduleViolation[] = []
  if (!isIntegerInRange(schedule.interval, 1, INTERVAL_MAX)) {
    violations.push({ field: "interval", message: `Repeat every must be a whole number between 1 and ${INTERVAL_MAX}.` })
  }
  if (schedule.frequency === "WEEKLY" && !isIntegerInRange(schedule.dayOfWeek, 1, 7)) {
    violations.push({ field: "dayOfWeek", message: "Choose a day of the week." })
  }
  const usesDayOfMonth = schedule.frequency !== "DAILY" && schedule.frequency !== "WEEKLY"
  if (usesDayOfMonth && !isIntegerInRange(schedule.dayOfMonth, 1, 31)) {
    violations.push({ field: "dayOfMonth", message: "The day of the month must be between 1 and 31." })
  }
  if (schedule.endDate !== null && compareDates(schedule.endDate, schedule.startDate) < 0) {
    violations.push({ field: "endDate", message: "The end date cannot be before the start date." })
  }
  if (schedule.occurrenceLimit !== null && !isIntegerInRange(schedule.occurrenceLimit, 1, OCCURRENCE_LIMIT_MAX)) {
    violations.push({
      field: "occurrenceLimit",
      message: `The number of occurrences must be a whole number between 1 and ${OCCURRENCE_LIMIT_MAX}.`,
    })
  }
  return violations
}

const MONTHS_PER_STEP: Record<"MONTHLY" | "QUARTERLY" | "YEARLY", number> = {
  MONTHLY: 1,
  QUARTERLY: 3,
  YEARLY: 12,
}

const monthIndex = (date: CalendarDate) => Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1

/** The day `dayOfMonth` in month `index` (year * 12 + month - 1), clamped to the month's last day. */
function clampedDate(index: number, dayOfMonth: number): CalendarDate {
  const year = Math.floor(index / 12)
  const month = index % 12
  // Day 0 of the next month is this month's last day, so Date.UTC does the leap-year maths.
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  const day = Math.min(dayOfMonth, lastDay)
  return calendarDate(`${String(year).padStart(4, "0")}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`)
}

/**
 * The generator of the schedule's grid: returns the nth date (n = 0, 1, 2 ...) and the first n worth
 * looking at for a window starting at `lowerBound`, so a rule from years ago does not walk its whole history.
 */
function grid(schedule: Schedule, lowerBound: CalendarDate): { nth: (n: number) => CalendarDate; firstIndex: number } {
  const { frequency, interval, startDate } = schedule
  if (frequency === "DAILY" || frequency === "WEEKLY") {
    // Weekly anchors on the first day on or after the start that has the weekday; both then step in whole days.
    const offset =
      frequency === "WEEKLY" ? (((schedule.dayOfWeek ?? isoWeekday(startDate)) - isoWeekday(startDate)) % 7 + 7) % 7 : 0
    const anchor = addDays(startDate, offset)
    const stepDays = frequency === "WEEKLY" ? 7 * interval : interval
    const gap = daysBetween(anchor, lowerBound)
    return { nth: (n) => addDays(anchor, n * stepDays), firstIndex: gap > 0 ? Math.floor(gap / stepDays) : 0 }
  }
  const step = MONTHS_PER_STEP[frequency] * interval
  const anchorIndex = monthIndex(startDate)
  const dayOfMonth = schedule.dayOfMonth ?? dayOfMonthOf(startDate)
  const gap = monthIndex(lowerBound) - anchorIndex
  return {
    nth: (n) => clampedDate(anchorIndex + n * step, dayOfMonth),
    firstIndex: gap > 0 ? Math.floor(gap / step) : 0,
  }
}

/**
 * The scheduled dates on or after `from` (never before the start date), up to `upTo` inclusive when given
 * and never past the end date. `count` is how many occurrences the rule already has, whatever their status,
 * so the occurrence limit is spent by skipped ones too. At most `max` dates, so an open-ended rule terminates.
 */
export function datesDue(
  schedule: Schedule,
  opts: { from: CalendarDate; count: number; upTo?: CalendarDate; max: number },
): CalendarDate[] {
  const remaining = schedule.occurrenceLimit === null ? Infinity : schedule.occurrenceLimit - opts.count
  const room = Math.min(opts.max, remaining)
  // An interval below 1 would never advance; validation rejects it, and here it simply yields nothing.
  if (room <= 0 || !(schedule.interval >= 1)) return []

  const lowerBound = compareDates(opts.from, schedule.startDate) > 0 ? opts.from : schedule.startDate
  const { nth, firstIndex } = grid(schedule, lowerBound)
  const dates: CalendarDate[] = []
  // The estimate lands on or before the first date in the window; step forward over any that precede it.
  for (let n = firstIndex; dates.length < room; n++) {
    const date = nth(n)
    if (compareDates(date, lowerBound) < 0) continue
    if (opts.upTo !== undefined && compareDates(date, opts.upTo) > 0) break
    if (schedule.endDate !== null && compareDates(date, schedule.endDate) > 0) break
    dates.push(date)
  }
  return dates
}

/** The first date the rule fires, or null when it never will (already finished, or the end is before the first date). */
export function firstDue(schedule: Schedule, count = 0): CalendarDate | null {
  return datesDue(schedule, { from: schedule.startDate, count, max: 1 })[0] ?? null
}
