import { describe, expect, it } from "vitest"
import type { ImportMapping } from "@/domain/import-map"
import { mappingFromParams, paramsFromMapping } from "./mapping-params"

// mappingFromParams/paramsFromMapping: the pure heart of the GET-driven map screen. mappingFromParams must never
// throw, whatever a hand-edited URL hands it, and must fall back to the given defaults field by field, not as a whole.

const BASE_DEFAULTS: ImportMapping = {
  delimiter: ",",
  encoding: "utf-8",
  skipRows: 1,
  dateFormat: "DD/MM/YYYY",
  decimalSeparator: ".",
  signConvention: "POSITIVE_IN",
  columns: { date: -1, description: -1 },
}

const AMOUNT_MAPPING: ImportMapping = {
  delimiter: ";",
  encoding: "windows-1252",
  skipRows: 2,
  dateFormat: "YYYY-MM-DD",
  decimalSeparator: ",",
  signConvention: "POSITIVE_OUT",
  columns: { date: 0, description: 1, amount: 2 },
}

const SPLIT_MAPPING: ImportMapping = {
  delimiter: "\t",
  encoding: "utf-16le",
  skipRows: 0,
  dateFormat: "D MMM YYYY",
  decimalSeparator: ".",
  signConvention: "POSITIVE_IN",
  columns: { date: 3, description: 4, debit: 5, credit: 6 },
}

describe("paramsFromMapping then mappingFromParams", () => {
  it("round-trips a full single-amount mapping exactly", () => {
    const params = paramsFromMapping(AMOUNT_MAPPING)
    expect(mappingFromParams(params, BASE_DEFAULTS)).toEqual(AMOUNT_MAPPING)
  })

  it("round-trips a full debit/credit mapping exactly", () => {
    const params = paramsFromMapping(SPLIT_MAPPING)
    expect(mappingFromParams(params, BASE_DEFAULTS)).toEqual(SPLIT_MAPPING)
  })

  it("never writes a profile parameter", () => {
    const params = paramsFromMapping(AMOUNT_MAPPING)
    expect(params.profile).toBeUndefined()
    expect(Object.keys(params)).not.toContain("profile")
  })

  it("reproduces the given defaults from no parameters at all", () => {
    expect(mappingFromParams({}, AMOUNT_MAPPING)).toEqual(AMOUNT_MAPPING)
    expect(mappingFromParams({}, SPLIT_MAPPING)).toEqual(SPLIT_MAPPING)
  })
})

describe("mappingFromParams falling back", () => {
  it("falls back to the default for each field individually when its own value is unreadable, keeping the rest", () => {
    const params = paramsFromMapping(AMOUNT_MAPPING)
    expect(mappingFromParams({ ...params, delim: "nonsense" }, BASE_DEFAULTS).delimiter).toBe(BASE_DEFAULTS.delimiter)
    expect(mappingFromParams({ ...params, enc: "ascii" }, BASE_DEFAULTS).encoding).toBe(BASE_DEFAULTS.encoding)
    expect(mappingFromParams({ ...params, datefmt: "not-a-format" }, BASE_DEFAULTS).dateFormat).toBe(BASE_DEFAULTS.dateFormat)
    expect(mappingFromParams({ ...params, dec: ";" }, BASE_DEFAULTS).decimalSeparator).toBe(BASE_DEFAULTS.decimalSeparator)
    expect(mappingFromParams({ ...params, sign: "SIDEWAYS" }, BASE_DEFAULTS).signConvention).toBe(BASE_DEFAULTS.signConvention)
    expect(mappingFromParams({ ...params, cdate: "-3" }, BASE_DEFAULTS).columns.date).toBe(BASE_DEFAULTS.columns.date)
    expect(mappingFromParams({ ...params, cdesc: "abc" }, BASE_DEFAULTS).columns.description).toBe(BASE_DEFAULTS.columns.description)
    // The other fields of the same mapping are untouched by one bad field.
    const withBadDelim = mappingFromParams({ ...params, delim: "nonsense" }, BASE_DEFAULTS)
    expect(withBadDelim.encoding).toBe(AMOUNT_MAPPING.encoding)
    expect(withBadDelim.columns).toEqual(AMOUNT_MAPPING.columns)
  })

  it("falls back to the default's own column shape when no column parameter reads at all", () => {
    expect(mappingFromParams({}, AMOUNT_MAPPING).columns).toEqual(AMOUNT_MAPPING.columns)
    expect(mappingFromParams({}, SPLIT_MAPPING).columns).toEqual(SPLIT_MAPPING.columns)
  })

  it("prefers a readable single amount column over a readable debit/credit pair", () => {
    const columns = mappingFromParams({ cdate: "0", cdesc: "1", camount: "2", cdebit: "3", ccredit: "4" }, BASE_DEFAULTS).columns
    expect(columns).toEqual({ date: 0, description: 1, amount: 2 })
  })

  it("uses the debit/credit pair when the amount column is unreadable but both of those read", () => {
    const columns = mappingFromParams({ cdate: "0", cdesc: "1", camount: "", cdebit: "3", ccredit: "4" }, BASE_DEFAULTS).columns
    expect(columns).toEqual({ date: 0, description: 1, debit: 3, credit: 4 })
  })

  it("never throws for garbage, empty, or missing values, and always falls back cleanly", () => {
    expect(() => mappingFromParams({ delim: "", enc: "", skip: "", datefmt: "", dec: "", sign: "", cdate: "", cdesc: "" }, BASE_DEFAULTS)).not.toThrow()
    expect(mappingFromParams({ skip: "-1" }, BASE_DEFAULTS).skipRows).toBe(BASE_DEFAULTS.skipRows)
    expect(mappingFromParams({ skip: "abc" }, BASE_DEFAULTS).skipRows).toBe(BASE_DEFAULTS.skipRows)
    expect(mappingFromParams({ skip: "1.5" }, BASE_DEFAULTS).skipRows).toBe(BASE_DEFAULTS.skipRows)
  })

  it("ignores unknown parameters entirely", () => {
    const params = paramsFromMapping(AMOUNT_MAPPING)
    const withExtra = { ...params, unknownThing: "whatever", mode: "amount", extra: "123" }
    expect(mappingFromParams(withExtra, BASE_DEFAULTS)).toEqual(AMOUNT_MAPPING)
  })

  it("falls back for a skip of 99, which is past the maximum", () => {
    expect(mappingFromParams({ skip: "99" }, BASE_DEFAULTS).skipRows).toBe(BASE_DEFAULTS.skipRows)
    expect(mappingFromParams({ skip: "50" }, BASE_DEFAULTS).skipRows).toBe(50) // the maximum itself is readable
  })
})
