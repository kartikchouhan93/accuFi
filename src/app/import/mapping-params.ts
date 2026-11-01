import { IMPORT_DELIMITERS, IMPORT_ENCODINGS, type ImportDelimiter, type ImportEncoding } from "@/domain/import-csv"
import { IMPORT_DATE_FORMATS, type ImportDateFormat, type ImportMapping, type SignConvention } from "@/domain/import-map"
import { SKIP_ROWS_MAX } from "@/lib/schemas/import"

// The map screen is GET-driven: every mapping field lives in a search parameter, so changing a control is a plain
// navigation (no scripting) and the preview is recomputed on the server from the URL alone. This module is the one
// place that reads and writes those parameters; it never throws, because a hand-edited or stale URL is not a server
// error, just a reason to fall back to the given defaults field by field.
//
// Column indexes ("not chosen yet" is -1 for date/description, absent for amount/debit/credit) are carried as plain
// digit strings; an empty or negative or non-numeric value is simply unreadable and falls back. The amount and
// debit/credit controls are both always present in the form (never swapped by scripting): a valid `camount` wins,
// otherwise a valid pair of `cdebit`/`ccredit` is used, otherwise the given defaults' own shape is kept whole (never a
// mix of one new column with the other half of the old shape).
//
// `profile` is deliberately not read here: it names a saved mapping, not a field of one, and the page resolves it
// to a full `ImportMapping` itself (Task 9's loaders have no "mapping of profile X" lookup of their own).

export type MappingParams = Record<string, string | undefined>

const DECIMAL_SEPARATORS = [".", ","] as const
const SIGN_CONVENTIONS = ["POSITIVE_OUT", "POSITIVE_IN"] as const

function enumValue<T extends string>(value: string | undefined, allowed: readonly T[], fallback: T): T {
  return value !== undefined && (allowed as readonly string[]).includes(value) ? (value as T) : fallback
}

/** A non-negative integer in `[min, max]`, read from plain digits only (no sign, no decimal); else `undefined`. */
function intValue(value: string | undefined, min: number, max: number): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) return undefined
  const n = Number(value)
  return n >= min && n <= max ? n : undefined
}

/** A zero-based column index: any non-negative integer is a real answer, with no upper bound known here. */
const columnValue = (value: string | undefined): number | undefined => intValue(value, 0, Number.MAX_SAFE_INTEGER)

/** The mapping the URL's search parameters describe, falling back to `defaults` field by field. Never throws. */
export function mappingFromParams(params: MappingParams, defaults: ImportMapping): ImportMapping {
  const delimiter = enumValue<ImportDelimiter>(params.delim, IMPORT_DELIMITERS, defaults.delimiter)
  const encoding = enumValue<ImportEncoding>(params.enc, IMPORT_ENCODINGS, defaults.encoding)
  const skipRows = intValue(params.skip, 0, SKIP_ROWS_MAX) ?? defaults.skipRows
  const dateFormat = enumValue<ImportDateFormat>(params.datefmt, IMPORT_DATE_FORMATS, defaults.dateFormat)
  const decimalSeparator = enumValue<"." | ",">(params.dec, DECIMAL_SEPARATORS, defaults.decimalSeparator)
  const signConvention = enumValue<SignConvention>(params.sign, SIGN_CONVENTIONS, defaults.signConvention)

  const date = columnValue(params.cdate) ?? defaults.columns.date
  const description = columnValue(params.cdesc) ?? defaults.columns.description
  const amount = columnValue(params.camount)
  const debit = columnValue(params.cdebit)
  const credit = columnValue(params.ccredit)

  const columns: ImportMapping["columns"] =
    amount !== undefined
      ? { date, description, amount }
      : debit !== undefined && credit !== undefined
        ? { date, description, debit, credit }
        : defaults.columns.amount !== undefined
          ? { date, description, amount: defaults.columns.amount }
          : { date, description, debit: defaults.columns.debit, credit: defaults.columns.credit }

  return { delimiter, encoding, skipRows, dateFormat, decimalSeparator, signConvention, columns }
}

/** The search parameters a mapping reads back as, for a link or a form's current values. Never includes `profile`. */
export function paramsFromMapping(mapping: ImportMapping): Record<string, string> {
  const params: Record<string, string> = {
    delim: mapping.delimiter,
    enc: mapping.encoding,
    skip: String(mapping.skipRows),
    datefmt: mapping.dateFormat,
    dec: mapping.decimalSeparator,
    sign: mapping.signConvention,
    cdate: String(mapping.columns.date),
    cdesc: String(mapping.columns.description),
  }
  if (mapping.columns.amount !== undefined) params.camount = String(mapping.columns.amount)
  if (mapping.columns.debit !== undefined) params.cdebit = String(mapping.columns.debit)
  if (mapping.columns.credit !== undefined) params.ccredit = String(mapping.columns.credit)
  return params
}

/** Every search parameter the mapping controls submit: the names `paramsFromMapping` writes. */
export const MAPPING_PARAM_NAMES = ["delim", "enc", "skip", "datefmt", "dec", "sign", "cdate", "cdesc", "camount", "cdebit", "ccredit"] as const

/**
 * Whether the mapping controls, as they read now, ask for something other than the mapping the preview was made with
 * (`previewed`, from `paramsFromMapping`). Compared as the strings the form would submit, with an absent value the same
 * as an empty one (an unused amount, debit or credit column submits ""). The map screen holds "Stage rows" back while
 * this is true: staging always uses the previewed mapping, so staging with changed controls would stage something
 * other than what the controls show — the very misread date this screen exists to prevent.
 */
export function mappingControlsDiffer(current: MappingParams, previewed: Record<string, string>): boolean {
  return MAPPING_PARAM_NAMES.some((name) => (current[name] ?? "") !== (previewed[name] ?? ""))
}
