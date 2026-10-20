import type { CalendarDate } from "../domain/calendar-date"
import { allocate, formatPaise, MoneyParseError, parseRupees, type Paise } from "../domain/money"
import { deserialisePaise, serialisePaise } from "./serialise"

// The small pieces of text the transaction form and list are made of: amounts as typed, days as read, tags as a
// comma-separated field. Paise appear here only as locals: nothing in this file returns or stores a bigint, because
// what it returns goes into form fields and component props.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

/** "20 Oct 2026". Reads the text itself: a Date would shift the day for a browser west of UTC. */
export function formatDay(date: CalendarDate): string {
  const [year, month, day] = date.split("-")
  return `${Number(day)} ${MONTHS[Number(month) - 1]} ${year}`
}

/** Paise as a form field holds them, with no sign, symbol or grouping: 3334n is "33.34". */
function plainRupees(paise: Paise): string {
  return `${paise / 100n}.${String(paise % 100n).padStart(2, "0")}`
}

/** An amount that crossed to the browser as paise text, as the rupee text a form field holds: "123450" is "1234.50". */
export function paiseTextToRupees(paise: string): string {
  return plainRupees(deserialisePaise(paise))
}

/** The sum of amounts given as paise text, as paise text: for a figure that is the total of several rows. */
export function sumPaiseText(amounts: readonly string[]): string {
  return serialisePaise(amounts.reduce((sum, amount) => sum + deserialisePaise(amount), 0n))
}

function tryParse(text: string): Paise | null {
  try {
    return parseRupees(text)
  } catch (error) {
    if (error instanceof MoneyParseError) return null
    throw error
  }
}

/**
 * `total` shared out equally across `count` legs, as the text to put in each leg's amount field, or null while the
 * total is not a usable amount. The legs always add up to the total exactly: the odd paise are handed out by
 * `allocate`, one each to the first legs (spec 6.3), so 100.00 in three is 33.34, 33.33 and 33.33.
 */
export function divideEqually(totalText: string, count: number): string[] | null {
  const total = tryParse(totalText)
  if (total === null || total <= 0n || count < 1) return null
  return allocate(total, Array.from({ length: count }, () => 1n)).map(plainRupees)
}

/**
 * Where the legs stand against the total, in words, or null while the total is not a usable amount. A leg that is not
 * a usable amount yet counts for nothing. The form shows this live, so the user sees what is left as they type; the
 * server still checks the sum (SplitTotalMismatchError), this only saves the round trip.
 */
export function describeTally(totalText: string, legTexts: readonly string[]): string | null {
  const total = tryParse(totalText)
  if (total === null || total <= 0n) return null
  const assigned = legTexts.reduce((sum, text) => sum + (tryParse(text) ?? 0n), 0n)
  if (assigned === total) return "Nothing left to assign."
  return assigned < total ? `${formatPaise(total - assigned)} left to assign.` : `${formatPaise(assigned - total)} over the total.`
}

/** The tags field ("food, trip") as the list of tags it names: trimmed, blanks dropped. */
export function parseTags(text: string): string[] {
  return text
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag !== "")
}
