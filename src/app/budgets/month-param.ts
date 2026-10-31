import { calendarDate, CalendarDateError, type CalendarDate } from "@/domain/calendar-date"

/**
 * The month a `?month=` value names, as the first of that month; undefined when it is missing or not exactly `YYYY-MM`,
 * so a hand-edited URL shows the current month and never an error. A repeated parameter reads as its first value, as on
 * the other screens. A month before the first budget or after the current one is clamped by the server, not here.
 */
export function monthFromParam(value: string | string[] | undefined): CalendarDate | undefined {
  const text = Array.isArray(value) ? value[0] : value
  if (text === undefined || !/^\d{4}-(0[1-9]|1[0-2])$/.test(text)) return undefined
  try {
    return calendarDate(`${text}-01`)
  } catch (error) {
    if (error instanceof CalendarDateError) return undefined
    throw error
  }
}
