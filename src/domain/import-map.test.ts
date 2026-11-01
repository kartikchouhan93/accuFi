import { describe, expect, it } from "vitest"
import {
  IMPORT_AMOUNT_MAX_PAISE,
  IMPORT_DATE_FORMATS,
  IMPORT_DIRECTIONS,
  defaultSignConvention,
  descriptionKey,
  parseImportAmount,
  parseImportDate,
  parseImportRow,
  type ImportMapping,
} from "./import-map"

describe("IMPORT_DATE_FORMATS and IMPORT_DIRECTIONS", () => {
  it("lists the closed set of formats and the two directions", () => {
    expect([...IMPORT_DATE_FORMATS]).toEqual([
      "DD/MM/YYYY",
      "MM/DD/YYYY",
      "YYYY-MM-DD",
      "DD-MM-YYYY",
      "DD/MM/YY",
      "MM/DD/YY",
      "DD-MMM-YYYY",
      "D MMM YYYY",
    ])
    expect([...IMPORT_DIRECTIONS]).toEqual(["OUT", "IN"])
  })
})

describe("parseImportDate", () => {
  it("reads the same text differently under DD/MM and MM/DD, because the format is never inferred", () => {
    expect(parseImportDate("03/04/2026", "DD/MM/YYYY")).toEqual({ ok: true, value: "2026-04-03" })
    expect(parseImportDate("03/04/2026", "MM/DD/YYYY")).toEqual({ ok: true, value: "2026-03-04" })
  })

  it("rejects a day that does not exist instead of rolling into the next month", () => {
    expect(parseImportDate("31/02/2026", "DD/MM/YYYY").ok).toBe(false)
    expect(parseImportDate("29/02/2026", "DD/MM/YYYY").ok).toBe(false)
    expect(parseImportDate("13/13/2026", "DD/MM/YYYY").ok).toBe(false)
    expect(parseImportDate("00/04/2026", "DD/MM/YYYY").ok).toBe(false)
    expect(parseImportDate("29/02/2028", "DD/MM/YYYY")).toEqual({ ok: true, value: "2028-02-29" })
  })

  it("reads month names case-insensitively", () => {
    expect(parseImportDate("05-Mar-2026", "DD-MMM-YYYY")).toEqual({ ok: true, value: "2026-03-05" })
    expect(parseImportDate("05-MAR-2026", "DD-MMM-YYYY")).toEqual({ ok: true, value: "2026-03-05" })
    expect(parseImportDate("05-mar-2026", "DD-MMM-YYYY")).toEqual({ ok: true, value: "2026-03-05" })
    expect(parseImportDate("5 Mar 2026", "D MMM YYYY")).toEqual({ ok: true, value: "2026-03-05" })
    expect(parseImportDate("5 Xyz 2026", "D MMM YYYY").ok).toBe(false)
  })

  it("reads a two-digit year as 20yy", () => {
    expect(parseImportDate("03/04/26", "DD/MM/YY")).toEqual({ ok: true, value: "2026-04-03" })
    expect(parseImportDate("03/04/26", "MM/DD/YY")).toEqual({ ok: true, value: "2026-03-04" })
    expect(parseImportDate("03/04/99", "DD/MM/YY")).toEqual({ ok: true, value: "2099-04-03" })
  })

  it("reads ISO and dashed day-first dates", () => {
    expect(parseImportDate("2026-04-03", "YYYY-MM-DD")).toEqual({ ok: true, value: "2026-04-03" })
    expect(parseImportDate("03-04-2026", "DD-MM-YYYY")).toEqual({ ok: true, value: "2026-04-03" })
  })

  it("trims surrounding whitespace", () => {
    expect(parseImportDate("  03/04/2026 \t", "DD/MM/YYYY")).toEqual({ ok: true, value: "2026-04-03" })
  })

  it("rejects text that does not match the chosen format", () => {
    expect(parseImportDate("2026/04/03", "YYYY-MM-DD").ok).toBe(false)
    expect(parseImportDate("03-04-2026", "DD/MM/YYYY").ok).toBe(false)
    expect(parseImportDate("03/04/26", "DD/MM/YYYY").ok).toBe(false)
    expect(parseImportDate("03/04/2026", "DD/MM/YY").ok).toBe(false)
    expect(parseImportDate("03/04/2026 10:00", "DD/MM/YYYY").ok).toBe(false)
  })

  it("rejects empty text and names the column role and format, never the cell text", () => {
    expect(parseImportDate("", "DD/MM/YYYY")).toEqual({ ok: false, error: "The date column is empty" })
    expect(parseImportDate("   ", "DD/MM/YYYY")).toEqual({ ok: false, error: "The date column is empty" })
    expect(parseImportDate("31/02/2026", "DD/MM/YYYY")).toEqual({
      ok: false,
      error: "The date column is not a valid DD/MM/YYYY date",
    })
    const secret = parseImportDate("SECRET-TEXT", "D MMM YYYY")
    expect(secret.ok).toBe(false)
    if (!secret.ok) expect(secret.error).not.toContain("SECRET")
  })
})

const amount = (text: string, sep: "." | "," = ".") => parseImportAmount(text, sep)
const okAmount = (paise: bigint, sign: "NEGATIVE" | "POSITIVE" | "NONE" = "NONE", suffix: "DR" | "CR" | null = null) => ({
  ok: true,
  value: { paise, sign, suffix },
})

describe("parseImportAmount", () => {
  it("reads Indian and international grouping into exact paise", () => {
    expect(amount("1,23,456.78")).toEqual(okAmount(12_345_678n))
    expect(amount("123,456.78")).toEqual(okAmount(12_345_678n))
    expect(amount("1,00,000")).toEqual(okAmount(10_000_000n))
    expect(amount("500")).toEqual(okAmount(50_000n))
    expect(amount("500.5")).toEqual(okAmount(50_050n))
    expect(amount("0.05")).toEqual(okAmount(5n))
    expect(amount(".50")).toEqual(okAmount(50n))
  })

  it("strips a rupee symbol or Rs prefix", () => {
    expect(amount("₹1,200.00")).toEqual(okAmount(120_000n))
    expect(amount("Rs. 500")).toEqual(okAmount(50_000n))
    expect(amount("Rs 500")).toEqual(okAmount(50_000n))
    expect(amount("INR 500")).toEqual(okAmount(50_000n))
    expect(amount("-₹500")).toEqual(okAmount(50_000n, "NEGATIVE"))
  })

  it("reads accounting parentheses and leading or trailing signs", () => {
    expect(amount("(500.00)")).toEqual(okAmount(50_000n, "NEGATIVE"))
    expect(amount("-500")).toEqual(okAmount(50_000n, "NEGATIVE"))
    expect(amount("500-")).toEqual(okAmount(50_000n, "NEGATIVE"))
    expect(amount("+500")).toEqual(okAmount(50_000n, "POSITIVE"))
    expect(amount("  -500  ")).toEqual(okAmount(50_000n, "NEGATIVE"))
  })

  it("reads a Dr or Cr suffix, in either case, with the sign left as NONE", () => {
    expect(amount("500.00 Dr")).toEqual(okAmount(50_000n, "NONE", "DR"))
    expect(amount("500 Cr")).toEqual(okAmount(50_000n, "NONE", "CR"))
    expect(amount("500.00DR")).toEqual(okAmount(50_000n, "NONE", "DR"))
    expect(amount("1,200.00 cr")).toEqual(okAmount(120_000n, "NONE", "CR"))
  })

  it("honours a comma decimal separator, where a dot is the grouping mark", () => {
    expect(amount("1.234,50", ",")).toEqual(okAmount(123_450n))
    expect(amount("1.23.456,78", ",")).toEqual(okAmount(12_345_678n))
    expect(amount("500,5", ",")).toEqual(okAmount(50_050n))
    expect(amount("12.345", ",")).toEqual(okAmount(1_234_500n))
  })

  it("rejects more than two decimals rather than rounding", () => {
    expect(amount("12.345").ok).toBe(false)
    expect(amount("0.001").ok).toBe(false)
    expect(amount("500.000").ok).toBe(false)
    expect(amount("12,345", ",").ok).toBe(false)
  })

  it("rejects zero, empty, unparseable and misgrouped text", () => {
    expect(amount("0.00").ok).toBe(false)
    expect(amount("0").ok).toBe(false)
    expect(amount("").ok).toBe(false)
    expect(amount("   ").ok).toBe(false)
    expect(amount("abc").ok).toBe(false)
    expect(amount("12abc").ok).toBe(false)
    expect(amount("1,5").ok).toBe(false)
    expect(amount("1,23,45").ok).toBe(false)
    expect(amount("--500").ok).toBe(false)
    expect(amount("+500-").ok).toBe(false)
    expect(amount("(500)-").ok).toBe(false)
    expect(amount("Dr").ok).toBe(false)
    expect(amount("500 Dr Cr").ok).toBe(false)
  })

  it("keeps an amount up to the cap exact, to the paisa", () => {
    expect(amount("999999999999.99")).toEqual(okAmount(99_999_999_999_999n))
    expect(amount("10,00,00,00,00,000.00")).toEqual(okAmount(IMPORT_AMOUNT_MAX_PAISE))
  })

  it("refuses an amount above the cap as this row's own parse error, never a value too large for the database", () => {
    expect(IMPORT_AMOUNT_MAX_PAISE).toBe(100_000_000_000_000n) // ₹10,00,00,00,00,000.00, one lakh crore
    expect(amount("1000000000000.01")).toEqual({ ok: false, error: "The amount column is too large" })
    // An eighteen-digit cell, and one past BIGINT's own range (about 9.22e18 paise), both refused the same way.
    expect(amount("123456789012345678")).toEqual({ ok: false, error: "The amount column is too large" })
    expect(amount("99999999999999999999999999999999999999")).toEqual({ ok: false, error: "The amount column is too large" })
    expect(parseImportAmount("99999999999999999999", ".", "debit")).toEqual({ ok: false, error: "The debit column is too large" })
  })

  it("names the column role and the reason, never the cell text", () => {
    expect(amount("")).toEqual({ ok: false, error: "The amount column is empty" })
    expect(amount("0.00")).toEqual({ ok: false, error: "The amount column is zero" })
    expect(amount("12.345")).toEqual({ ok: false, error: "The amount column has more than two decimal places" })
    expect(amount("abc")).toEqual({ ok: false, error: "The amount column is not a valid amount" })
    const secret = parseImportAmount("SECRET99", ".")
    expect(secret.ok).toBe(false)
    if (!secret.ok) expect(secret.error).not.toContain("SECRET")
  })
})

describe("defaultSignConvention", () => {
  it("offers positive-in for an asset (a deposit is positive) and positive-out for a liability (a charge is positive)", () => {
    expect(defaultSignConvention("ASSET")).toBe("POSITIVE_IN")
    expect(defaultSignConvention("LIABILITY")).toBe("POSITIVE_OUT")
  })
})

describe("descriptionKey", () => {
  it("drops reference tokens and anything with a digit", () => {
    expect(descriptionKey("UPI/123456789012/SWIGGY BANGALORE/ref 998877")).toBe("SWIGGY BANGALORE")
    expect(descriptionKey("POS 4567 AMAZON PAY")).toBe("AMAZON PAY")
    expect(descriptionKey("upi-swiggy-order77")).toBe("SWIGGY")
  })

  it("is empty when nothing meaningful is left", () => {
    expect(descriptionKey("UPI 123456789012")).toBe("")
    expect(descriptionKey("")).toBe("")
    expect(descriptionKey("  --  ")).toBe("")
  })

  it("upper-cases and collapses whitespace and punctuation", () => {
    expect(descriptionKey("  Big   Bazaar,,  Pune ")).toBe("BIG BAZAAR PUNE")
  })

  it("truncates to at most 40 characters with no trailing space", () => {
    const long = "ALPHA BRAVO CHARLIE DELTA ECHO FOXTROT GOLF HOTEL INDIA"
    expect(long.length).toBeGreaterThan(40)
    const key = descriptionKey(long)
    expect(key.length).toBeLessThanOrEqual(40)
    expect(key).toBe(key.trim())
    expect(long.toUpperCase().startsWith(key)).toBe(true)
    const sixty = "ABCDEFGHIJ ".repeat(6).trim()
    expect(descriptionKey(sixty).length).toBeLessThanOrEqual(40)
    expect(descriptionKey("X".repeat(39) + " Y".repeat(10))).toBe("X".repeat(39))
  })
})

const single: ImportMapping = {
  delimiter: ",",
  encoding: "utf-8",
  skipRows: 1,
  dateFormat: "DD/MM/YYYY",
  decimalSeparator: ".",
  signConvention: "POSITIVE_OUT",
  columns: { date: 0, description: 1, amount: 2 },
}
const split: ImportMapping = { ...single, columns: { date: 0, description: 1, debit: 2, credit: 3 } }
const positiveIn: ImportMapping = { ...single, signConvention: "POSITIVE_IN" }

describe("parseImportRow with one amount column", () => {
  it("reads a row end to end", () => {
    expect(parseImportRow(["03/04/2026", "  UPI/123456789012/SWIGGY  ", "1,250.50"], single)).toEqual({
      ok: true,
      value: {
        occurredOn: "2026-04-03",
        amountPaise: 125_050n,
        direction: "OUT",
        description: "UPI/123456789012/SWIGGY",
        descriptionKey: "SWIGGY",
      },
    })
  })

  it("treats a positive amount as out and a negative as in under POSITIVE_OUT", () => {
    const direction = (cell: string) => {
      const row = parseImportRow(["03/04/2026", "x", cell], single)
      return row.ok ? row.value.direction : row.error
    }
    expect(direction("500.00")).toBe("OUT")
    expect(direction("-500.00")).toBe("IN")
    expect(direction("(500)")).toBe("IN")
  })

  it("reverses that under POSITIVE_IN", () => {
    const direction = (cell: string) => {
      const row = parseImportRow(["03/04/2026", "x", cell], positiveIn)
      return row.ok ? row.value.direction : row.error
    }
    expect(direction("500.00")).toBe("IN")
    expect(direction("-500.00")).toBe("OUT")
  })

  it("lets Dr and Cr override the sign convention, under either", () => {
    for (const mapping of [single, positiveIn]) {
      const dr = parseImportRow(["03/04/2026", "x", "500 Dr"], mapping)
      const cr = parseImportRow(["03/04/2026", "x", "500 Cr"], mapping)
      expect(dr.ok && dr.value.direction).toBe("OUT")
      expect(cr.ok && cr.value.direction).toBe("IN")
    }
  })

  it("keeps the unsigned amount whatever the direction", () => {
    const row = parseImportRow(["03/04/2026", "x", "-500.00"], single)
    expect(row.ok && row.value.amountPaise).toBe(50_000n)
  })

  it("allows an empty description, with an empty key", () => {
    const row = parseImportRow(["03/04/2026", "   ", "500"], single)
    expect(row.ok && row.value.description).toBe("")
    expect(row.ok && row.value.descriptionKey).toBe("")
  })

  it("treats a missing cell as empty", () => {
    expect(parseImportRow(["03/04/2026", "x"], single)).toEqual({ ok: false, error: "The amount column is empty" })
    const noDescription = parseImportRow(["03/04/2026"], { ...single, columns: { date: 0, description: 5, amount: 0 } })
    expect(noDescription.ok).toBe(false)
  })

  it("returns the date error and the amount error naming the role", () => {
    expect(parseImportRow(["31/02/2026", "x", "500"], single)).toEqual({
      ok: false,
      error: "The date column is not a valid DD/MM/YYYY date",
    })
    expect(parseImportRow(["03/04/2026", "x", "abc"], single)).toEqual({
      ok: false,
      error: "The amount column is not a valid amount",
    })
    expect(parseImportRow(["03/04/2026", "x", "0.00"], single)).toEqual({
      ok: false,
      error: "The amount column is zero",
    })
  })

  it("honours the decimal separator from the mapping", () => {
    const row = parseImportRow(["03/04/2026", "x", "1.234,50"], { ...single, decimalSeparator: "," })
    expect(row.ok && row.value.amountPaise).toBe(123_450n)
  })

  it("fails when the mapping names neither an amount column nor a debit and credit pair", () => {
    const row = parseImportRow(["03/04/2026", "x", "500"], { ...single, columns: { date: 0, description: 1 } })
    expect(row.ok).toBe(false)
    const half = parseImportRow(["03/04/2026", "x", "500"], { ...single, columns: { date: 0, description: 1, debit: 2 } })
    expect(half.ok).toBe(false)
  })
})

describe("parseImportRow with debit and credit columns", () => {
  const row = (debit: string, credit: string, mapping = split) => parseImportRow(["03/04/2026", "x", debit, credit], mapping)

  it("reads debit as out and credit as in", () => {
    const out = row("500", "")
    expect(out.ok && out.value.direction).toBe("OUT")
    expect(out.ok && out.value.amountPaise).toBe(50_000n)
    const inn = row("", "700")
    expect(inn.ok && inn.value.direction).toBe("IN")
    expect(inn.ok && inn.value.amountPaise).toBe(70_000n)
  })

  it("refuses a debit or credit above the amount cap as a row error, naming the column", () => {
    expect(row("99999999999999999999", "")).toEqual({ ok: false, error: "The debit column is too large" })
    expect(row("", "99999999999999999999")).toEqual({ ok: false, error: "The credit column is too large" })
  })

  it("ignores the sign convention, which only applies to a single column", () => {
    const out = row("500", "", { ...split, signConvention: "POSITIVE_IN" })
    expect(out.ok && out.value.direction).toBe("OUT")
  })

  it("counts a zero in the unused column as empty", () => {
    const inn = row("0.00", "700")
    expect(inn.ok && inn.value.direction).toBe("IN")
    const out = row("500", "0")
    expect(out.ok && out.value.direction).toBe("OUT")
  })

  it("errors when both columns hold an amount, when neither does, and when one is unreadable", () => {
    expect(row("500", "700")).toEqual({ ok: false, error: "The debit and credit columns both have an amount" })
    expect(row("", "")).toEqual({ ok: false, error: "The debit and credit columns are both empty" })
    expect(row("0.00", "0.00")).toEqual({ ok: false, error: "The debit and credit columns are both empty" })
    expect(row("abc", "")).toEqual({ ok: false, error: "The debit column is not a valid amount" })
    expect(row("", "12.345")).toEqual({ ok: false, error: "The credit column has more than two decimal places" })
  })

  it("still reports a bad date first", () => {
    expect(parseImportRow(["", "x", "500", ""], split)).toEqual({ ok: false, error: "The date column is empty" })
  })
})
