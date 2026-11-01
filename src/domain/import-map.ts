// The second step of an import: turn one row of cells into a date, an exact amount, a direction and a
// description, using a mapping the person chose. Nothing here guesses.
//
// Three rules shape the module. First, a date format is always chosen, never inferred: "03/04/2026" is the
// 3rd of April or the 4th of March depending on the bank, and a wrong guess records a real transaction on the
// wrong day with no warning. A day that does not exist ("31/02/2026") is an error, not March. Second, amounts
// are exact: they are read from digit strings into bigint paise and never pass through Number, and anything
// that would need rounding (a third decimal), a zero, or text that is not an amount is an error. Third,
// statement text is sensitive, so an error names the column role and the reason ("The date column is not a
// valid DD/MM/YYYY date") and never contains any of the cell's text.
//
// Direction is relative to the account the file is for, in ledger terms: OUT means the account is the source
// of the transaction (money leaves a bank account, or a charge increases what a card owes) and IN means it is
// the destination. The statement only says debit or credit, positive or negative, so the mapping carries the
// convention that turns those into OUT or IN.

import { calendarDate, type CalendarDate } from "./calendar-date"
import type { ImportDelimiter, ImportEncoding } from "./import-csv"
import type { Paise } from "./money"

export type Result<T> = { ok: true; value: T } | { ok: false; error: string }

export const IMPORT_DATE_FORMATS = [
  "DD/MM/YYYY",
  "MM/DD/YYYY",
  "YYYY-MM-DD",
  "DD-MM-YYYY",
  "DD/MM/YY",
  "MM/DD/YY",
  "DD-MMM-YYYY",
  "D MMM YYYY",
] as const
export type ImportDateFormat = (typeof IMPORT_DATE_FORMATS)[number]

export const IMPORT_DIRECTIONS = ["OUT", "IN"] as const
export type ImportDirection = (typeof IMPORT_DIRECTIONS)[number]

export type SignConvention = "POSITIVE_OUT" | "POSITIVE_IN"

/**
 * A card statement lists charges as positive numbers and a charge increases what the card owes (OUT of the
 * liability); a bank statement lists deposits as positive, which are IN to the asset.
 */
export function defaultSignConvention(accountKind: "ASSET" | "LIABILITY"): SignConvention {
  return accountKind === "ASSET" ? "POSITIVE_IN" : "POSITIVE_OUT"
}

type DatePart = "day" | "month" | "year"

interface DateShape {
  pattern: RegExp
  /** What each capture group of `pattern` holds, in order. */
  parts: readonly [DatePart, DatePart, DatePart]
  /** The year has two digits and means 20yy: a statement is recent, and the ledger accepts no year before 1000. */
  shortYear?: true
}

// Separators are exact and a day or month may omit its leading zero (banks do), but the year width is fixed
// by the format, so "03/04/26" does not slip through DD/MM/YYYY as the year 26.
const DATE_SHAPES: Record<ImportDateFormat, DateShape> = {
  "DD/MM/YYYY": { pattern: /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/, parts: ["day", "month", "year"] },
  "MM/DD/YYYY": { pattern: /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/, parts: ["month", "day", "year"] },
  "YYYY-MM-DD": { pattern: /^(\d{4})-(\d{1,2})-(\d{1,2})$/, parts: ["year", "month", "day"] },
  "DD-MM-YYYY": { pattern: /^(\d{1,2})-(\d{1,2})-(\d{4})$/, parts: ["day", "month", "year"] },
  "DD/MM/YY": { pattern: /^(\d{1,2})\/(\d{1,2})\/(\d{2})$/, parts: ["day", "month", "year"], shortYear: true },
  "MM/DD/YY": { pattern: /^(\d{1,2})\/(\d{1,2})\/(\d{2})$/, parts: ["month", "day", "year"], shortYear: true },
  "DD-MMM-YYYY": { pattern: /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/, parts: ["day", "month", "year"] },
  "D MMM YYYY": { pattern: /^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})$/, parts: ["day", "month", "year"] },
}

const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]

const pad2 = (n: number) => String(n).padStart(2, "0")

/** Read a date in the one format the person chose. Exact: a day that does not exist is an error, not rolled over. */
export function parseImportDate(text: string, format: ImportDateFormat): Result<CalendarDate> {
  const trimmed = text.trim()
  if (trimmed === "") return { ok: false, error: "The date column is empty" }
  const invalid: Result<CalendarDate> = { ok: false, error: `The date column is not a valid ${format} date` }

  const shape = DATE_SHAPES[format]
  const match = shape.pattern.exec(trimmed)
  if (!match) return invalid

  const fields: Record<DatePart, number> = { day: 0, month: 0, year: 0 }
  for (let i = 0; i < 3; i++) {
    const raw = match[i + 1]
    const part = shape.parts[i]
    if (part === "month" && /^[A-Za-z]+$/.test(raw)) {
      const index = MONTH_NAMES.indexOf(raw.toLowerCase())
      if (index === -1) return invalid
      fields.month = index + 1
    } else {
      fields[part] = Number(raw)
    }
  }
  if (shape.shortYear) fields.year += 2000

  try {
    // calendarDate owns the leap-year and month-length rules; it throws for a day that does not exist.
    return { ok: true, value: calendarDate(`${String(fields.year).padStart(4, "0")}-${pad2(fields.month)}-${pad2(fields.day)}`) }
  } catch {
    return invalid
  }
}

export type AmountSign = "NEGATIVE" | "POSITIVE" | "NONE"
export type AmountSuffix = "DR" | "CR" | null
export interface ParsedAmount {
  paise: Paise
  sign: AmountSign
  suffix: AmountSuffix
}

type AmountFailure = "empty" | "invalid" | "decimals" | "zero" | "tooLarge"
type AmountRead = { ok: true; value: ParsedAmount } | { ok: false; reason: AmountFailure }

/**
 * The largest amount one statement row may carry: ₹10,00,00,00,00,000.00 (one lakh crore rupees), in paise. Far beyond
 * any real statement line, and small enough that even `IMPORT_MAX_ROWS` rows of it stay well inside the database's
 * BIGINT column (about 9.22e18): a garbage or hostile cell of forty digits must be one row's parse error, never a raw
 * database overflow that fails every other row of the file with it.
 */
export const IMPORT_AMOUNT_MAX_PAISE: Paise = 10n ** 14n

const FAILURE_TEXT: Record<AmountFailure, string> = {
  empty: "is empty",
  invalid: "is not a valid amount",
  decimals: "has more than two decimal places",
  zero: "is zero",
  tooLarge: "is too large",
}

// Grouping is validated, not just stripped: under "." as the decimal mark, "1,5" is almost certainly a
// comma-decimal file read with the wrong setting, and silently reading it as 15 rupees would be a bad
// surprise. Plain digits, Indian grouping (1,23,456) or international grouping (123,456) are accepted.
function amountBodyPattern(decimalSeparator: "." | ","): RegExp {
  const group = decimalSeparator === "." ? "," : "\\."
  const decimal = decimalSeparator === "." ? "\\." : ","
  const whole = `\\d+|\\d{1,2}(?:${group}\\d{2})*${group}\\d{3}|\\d{1,3}(?:${group}\\d{3})+`
  return new RegExp(`^(?:(${whole}))?(?:${decimal}(\\d+))?$`)
}

const BODY_PATTERNS = { ".": amountBodyPattern("."), ",": amountBodyPattern(",") }

// An optional sign, an optional currency marker, an optional sign again ("-₹500" and "₹-500" both occur),
// the digits, and an optional trailing sign ("500-").
const AMOUNT_SHAPE = /^([+-])?\s*(?:₹|rs\.?|inr)?\s*([+-])?\s*([\d.,]+)\s*([+-])?$/i

function readAmount(text: string, decimalSeparator: "." | ","): AmountRead {
  let rest = text.trim()
  if (rest === "") return { ok: false, reason: "empty" }

  let suffix: AmountSuffix = null
  const suffixMatch = /^(.*?)\s*(dr|cr)\.?$/is.exec(rest)
  if (suffixMatch) {
    suffix = suffixMatch[2].toUpperCase() as "DR" | "CR"
    rest = suffixMatch[1].trim()
  }

  let signs = 0
  let negative = false
  let positive = false
  const parenthesised = /^\((.*)\)$/s.exec(rest)
  if (parenthesised) {
    rest = parenthesised[1].trim()
    negative = true
    signs++
  }

  const shape = AMOUNT_SHAPE.exec(rest)
  if (!shape) return { ok: false, reason: "invalid" }
  for (const mark of [shape[1], shape[2], shape[4]]) {
    if (mark === undefined) continue
    signs++
    if (mark === "-") negative = true
    else positive = true
  }
  // One sign at most: "--500", "+500-" and "(500)-" contradict themselves and are not guessed at.
  if (signs > 1) return { ok: false, reason: "invalid" }

  const body = BODY_PATTERNS[decimalSeparator].exec(shape[3])
  if (!body || (body[1] === undefined && body[2] === undefined)) return { ok: false, reason: "invalid" }
  const fraction = body[2] ?? ""
  if (fraction.length > 2) return { ok: false, reason: "decimals" }

  const groupMark = decimalSeparator === "." ? "," : "."
  const whole = (body[1] ?? "0").replaceAll(groupMark, "")
  const paise = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"))
  if (paise === 0n) return { ok: false, reason: "zero" }
  if (paise > IMPORT_AMOUNT_MAX_PAISE) return { ok: false, reason: "tooLarge" }

  const sign: AmountSign = negative ? "NEGATIVE" : positive ? "POSITIVE" : "NONE"
  return { ok: true, value: { paise, sign, suffix } }
}

/**
 * Read a bank amount into unsigned exact paise plus the sign and Dr/Cr suffix it carried. `role` only changes
 * the wording of the error, so a debit column's problem is reported as the debit column's.
 */
export function parseImportAmount(
  text: string,
  decimalSeparator: "." | ",",
  role: "amount" | "debit" | "credit" = "amount",
): Result<ParsedAmount> {
  const read = readAmount(text, decimalSeparator)
  return read.ok ? read : { ok: false, error: `The ${role} column ${FAILURE_TEXT[read.reason]}` }
}

export interface ImportMapping {
  delimiter: ImportDelimiter
  encoding: ImportEncoding
  skipRows: number
  dateFormat: ImportDateFormat
  decimalSeparator: "." | ","
  signConvention: SignConvention
  /** Zero-based cell indexes. Either `amount`, or both `debit` and `credit`. */
  columns: { date: number; description: number; amount?: number; debit?: number; credit?: number }
}

// Reference and channel words that differ on every statement line for the same merchant, so keeping them would
// stop "UPI/SWIGGY/ref 1" and "UPI/SWIGGY/ref 2" from matching each other.
const NOISE_TOKENS = new Set(["UPI", "NEFT", "IMPS", "RTGS", "POS", "ATM", "ACH", "ECS", "NACH", "REF", "TXN"])

/**
 * A normalised form of a description for matching the same payee across rows: upper-cased, punctuation as
 * spaces, tokens with any digit and the channel words above dropped, truncated to 40 characters.
 */
export function descriptionKey(text: string): string {
  const tokens = text
    .toUpperCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token !== "" && !/\p{N}/u.test(token) && !NOISE_TOKENS.has(token))
  return tokens.join(" ").slice(0, 40).trimEnd()
}

export interface ParsedRow {
  occurredOn: CalendarDate
  amountPaise: Paise
  direction: ImportDirection
  description: string
  descriptionKey: string
}

type SplitAmount = { kind: "amount"; paise: Paise; direction: ImportDirection } | { kind: "error"; error: string }

function readSingleAmount(cell: string, mapping: ImportMapping): SplitAmount {
  const parsed = parseImportAmount(cell, mapping.decimalSeparator)
  if (!parsed.ok) return { kind: "error", error: parsed.error }
  const { paise, sign, suffix } = parsed.value
  // Dr and Cr say which way the money moved in the bank's own words, so they win over the sign convention.
  if (suffix !== null) return { kind: "amount", paise, direction: suffix === "DR" ? "OUT" : "IN" }
  const positiveMeansOut = mapping.signConvention === "POSITIVE_OUT"
  const isPositive = sign !== "NEGATIVE"
  return { kind: "amount", paise, direction: isPositive === positiveMeansOut ? "OUT" : "IN" }
}

function readSplitAmount(debitCell: string, creditCell: string, mapping: ImportMapping): SplitAmount {
  // A zero in the unused column ("0.00" beside a real amount) is how many banks write "nothing here".
  const read = (cell: string) => readAmount(cell, mapping.decimalSeparator)
  const debit = read(debitCell)
  const credit = read(creditCell)
  const blank = (r: AmountRead) => !r.ok && (r.reason === "empty" || r.reason === "zero")

  for (const [role, r] of [["debit", debit], ["credit", credit]] as const) {
    if (!r.ok && !blank(r)) return { kind: "error", error: `The ${role} column ${FAILURE_TEXT[r.reason]}` }
  }
  if (debit.ok && credit.ok) return { kind: "error", error: "The debit and credit columns both have an amount" }
  if (debit.ok) return { kind: "amount", paise: debit.value.paise, direction: "OUT" }
  if (credit.ok) return { kind: "amount", paise: credit.value.paise, direction: "IN" }
  return { kind: "error", error: "The debit and credit columns are both empty" }
}

/** Parse one row of cells with the person's mapping. A short row has missing cells, which read as empty. */
export function parseImportRow(cells: readonly string[], mapping: ImportMapping): Result<ParsedRow> {
  const { columns } = mapping
  const cell = (index: number) => cells[index] ?? ""

  const date = parseImportDate(cell(columns.date), mapping.dateFormat)
  if (!date.ok) return date

  let amount: SplitAmount
  if (columns.amount !== undefined) {
    amount = readSingleAmount(cell(columns.amount), mapping)
  } else if (columns.debit !== undefined && columns.credit !== undefined) {
    amount = readSplitAmount(cell(columns.debit), cell(columns.credit), mapping)
  } else {
    return { ok: false, error: "The mapping has no amount column, or no debit and credit pair" }
  }
  if (amount.kind === "error") return { ok: false, error: amount.error }

  const description = cell(columns.description).trim()
  return {
    ok: true,
    value: {
      occurredOn: date.value,
      amountPaise: amount.paise,
      direction: amount.direction,
      description,
      descriptionKey: descriptionKey(description),
    },
  }
}
