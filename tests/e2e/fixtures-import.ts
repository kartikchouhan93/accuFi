import { addDays, calendarDate, type CalendarDate } from "@/domain/calendar-date"

// Synthetic statement-string builders for the import e2e specs: invented in the shape of common bank and card exports,
// never a real statement, and built from plain functions so a spec can see exactly what bytes it is uploading. Every
// date is derived from the seed's `today` (so a test passes on any day the suite runs); `safeAnchor` caps the
// anchor's own day-of-month at 28 first, so a handful of days either side of it never needs month-length arithmetic
// to stay a real calendar date, and every expected value a spec works out by hand stays simple.
//
// Three shapes, matching the plan: a bank export with separate Debit and Credit columns and DD/MM/YY dates, a bank
// export with one signed Amount column and DD-MMM-YYYY dates, and a card export with one signed Amount column
// (POSITIVE_OUT) in plain DD/MM/YYYY. `row()` builds a raw line from its own cells for the one case a spec needs full
// control of the text (a deliberately bad date, for the errored-row scenario).

const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

const pad2 = (n: number) => String(n).padStart(2, "0")
const pad4 = (n: number) => String(n).padStart(4, "0")

function parts(date: CalendarDate): { y: number; m: number; d: number } {
  const [y, m, d] = date.split("-").map(Number)
  return { y, m, d }
}

/** `today`, with its day-of-month capped at 28: never a 29th, 30th or 31st, so offsetting it by a handful of days in
 * either direction, or reading its day-of-month back out by hand, never has to account for how long the month is. */
export function safeAnchor(today: CalendarDate): CalendarDate {
  const { y, m, d } = parts(today)
  return calendarDate(`${pad4(y)}-${pad2(m)}-${pad2(Math.min(d, 28))}`)
}

export const ddmmyy = (date: CalendarDate): string => {
  const { y, m, d } = parts(date)
  return `${pad2(d)}/${pad2(m)}/${pad2(y % 100)}`
}

export const ddmmmyyyy = (date: CalendarDate): string => {
  const { y, m, d } = parts(date)
  return `${pad2(d)}-${MONTH_ABBR[m - 1]}-${pad4(y)}`
}

export const ddmmyyyy = (date: CalendarDate): string => {
  const { y, m, d } = parts(date)
  return `${pad2(d)}/${pad2(m)}/${pad4(y)}`
}

/** A day `offsetDays` from `anchor`, formatted by `format`: the one line every row builder below shares. */
const at = (anchor: CalendarDate, offsetDays: number, format: (date: CalendarDate) => string) => format(addDays(anchor, offsetDays))

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

/** A raw statement line from its own cells, quoted only where a cell needs it: the escape hatch for a row a spec
 * wants full control of, such as a date that is deliberately not a real one. */
export const row = (cells: readonly string[]): string => cells.map(csvCell).join(",")

/** One line of a Debit/Credit statement: DD/MM/YY, the description, and the amount in whichever column `flow` names. */
export function splitRow(anchor: CalendarDate, offsetDays: number, description: string, rupees: string, flow: "DEBIT" | "CREDIT"): string {
  const date = at(anchor, offsetDays, ddmmyy)
  return row([date, description, flow === "DEBIT" ? rupees : "", flow === "CREDIT" ? rupees : ""])
}

/** One line of a single-signed-column statement: DD-MMM-YYYY, the description, and a signed amount. */
export function signedRow(anchor: CalendarDate, offsetDays: number, description: string, rupees: string, sign: "+" | "-" = "+"): string {
  const date = at(anchor, offsetDays, ddmmmyyyy)
  return row([date, description, `${sign === "-" ? "-" : ""}${rupees}`])
}

/** One line of a card statement: DD/MM/YYYY, the description, and a signed amount (positive is a charge: POSITIVE_OUT). */
export function cardRow(anchor: CalendarDate, offsetDays: number, description: string, rupees: string, sign: "+" | "-" = "+"): string {
  const date = at(anchor, offsetDays, ddmmyyyy)
  return row([date, description, `${sign === "-" ? "-" : ""}${rupees}`])
}

/** A bank export with separate Debit and Credit columns and DD/MM/YY dates. */
export const bankSplitColumnsCsv = (rows: readonly string[]): string => ["Date,Description,Debit,Credit", ...rows].join("\r\n")

/** A bank export with one signed Amount column and DD-MMM-YYYY dates. */
export const bankSignedColumnCsv = (rows: readonly string[]): string => ["Date,Description,Amount", ...rows].join("\r\n")

/** A card export with one signed Amount column (positive is a charge) and DD/MM/YYYY dates. */
export const cardCsv = (rows: readonly string[]): string => ["Date,Description,Amount", ...rows].join("\r\n")
