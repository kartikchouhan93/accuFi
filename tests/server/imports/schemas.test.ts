import { describe, expect, it } from "vitest"
import { batchIdSchema, importMappingSchema, saveProfileSchema, stageBatchSchema } from "@/lib/schemas/import"

// The import schemas, on their own: strict parsing of a column mapping (enums from the domain's own lists, a
// non-negative column index, exactly one of an amount column or a debit/credit pair), and the thin wrappers around it
// used to stage a batch, save a profile, or name a batch by id.

const validColumns = { date: 0, description: 1, amount: 2 }
const validMapping = {
  delimiter: ",",
  encoding: "utf-8",
  skipRows: 1,
  dateFormat: "DD/MM/YYYY",
  decimalSeparator: ".",
  signConvention: "POSITIVE_OUT",
  columns: validColumns,
}

describe("importMappingSchema", () => {
  it("parses a valid mapping unchanged", () => {
    expect(importMappingSchema.parse(validMapping)).toEqual(validMapping)
  })

  it("refuses an unknown key, at the top level and inside columns", () => {
    expect(importMappingSchema.safeParse({ ...validMapping, extra: 1 }).success).toBe(false)
    expect(importMappingSchema.safeParse({ ...validMapping, columns: { ...validColumns, extra: 1 } }).success).toBe(false)
  })

  it.each(["delimiter", "encoding", "dateFormat", "decimalSeparator", "signConvention"])("refuses a bad %s", (field) => {
    expect(importMappingSchema.safeParse({ ...validMapping, [field]: "not-a-real-value" }).success).toBe(false)
  })

  it("accepts every delimiter, encoding and date format the domain lists", () => {
    for (const delimiter of [",", ";", "\t", "|"]) {
      expect(importMappingSchema.safeParse({ ...validMapping, delimiter }).success).toBe(true)
    }
    for (const encoding of ["utf-8", "windows-1252", "utf-16le"]) {
      expect(importMappingSchema.safeParse({ ...validMapping, encoding }).success).toBe(true)
    }
    for (const dateFormat of ["DD/MM/YYYY", "MM/DD/YYYY", "YYYY-MM-DD", "DD-MM-YYYY", "DD/MM/YY", "MM/DD/YY", "DD-MMM-YYYY", "D MMM YYYY"]) {
      expect(importMappingSchema.safeParse({ ...validMapping, dateFormat }).success).toBe(true)
    }
    for (const decimalSeparator of [".", ","]) {
      expect(importMappingSchema.safeParse({ ...validMapping, decimalSeparator }).success).toBe(true)
    }
    for (const signConvention of ["POSITIVE_OUT", "POSITIVE_IN"]) {
      expect(importMappingSchema.safeParse({ ...validMapping, signConvention }).success).toBe(true)
    }
  })

  it("refuses skipRows above 50, and accepts 0 and 50", () => {
    expect(importMappingSchema.safeParse({ ...validMapping, skipRows: 51 }).success).toBe(false)
    expect(importMappingSchema.safeParse({ ...validMapping, skipRows: -1 }).success).toBe(false)
    expect(importMappingSchema.safeParse({ ...validMapping, skipRows: 0 }).success).toBe(true)
    expect(importMappingSchema.safeParse({ ...validMapping, skipRows: 50 }).success).toBe(true)
  })

  it("refuses a negative column index, on any column", () => {
    expect(importMappingSchema.safeParse({ ...validMapping, columns: { ...validColumns, date: -1 } }).success).toBe(false)
    expect(importMappingSchema.safeParse({ ...validMapping, columns: { ...validColumns, description: -1 } }).success).toBe(false)
    expect(importMappingSchema.safeParse({ ...validMapping, columns: { ...validColumns, amount: -1 } }).success).toBe(false)
  })

  it("refuses an amount column together with a debit column", () => {
    const columns = { date: 0, description: 1, amount: 2, debit: 3 }
    expect(importMappingSchema.safeParse({ ...validMapping, columns }).success).toBe(false)
  })

  it("refuses a debit column alone, with no credit column", () => {
    const columns = { date: 0, description: 1, debit: 2 }
    expect(importMappingSchema.safeParse({ ...validMapping, columns }).success).toBe(false)
  })

  it("refuses neither an amount column nor a debit/credit pair", () => {
    const columns = { date: 0, description: 1 }
    expect(importMappingSchema.safeParse({ ...validMapping, columns }).success).toBe(false)
  })

  it("accepts a debit and credit pair with no amount column", () => {
    const columns = { date: 0, description: 1, debit: 2, credit: 3 }
    expect(importMappingSchema.safeParse({ ...validMapping, columns }).success).toBe(true)
  })
})

describe("stageBatchSchema", () => {
  it("parses id, mapping and confirmedRepeat", () => {
    const parsed = stageBatchSchema.parse({ id: "b1", mapping: validMapping, confirmedRepeat: true })
    expect(parsed).toEqual({ id: "b1", mapping: validMapping, confirmedRepeat: true })
  })

  it("refuses an unknown key, a missing id, and a non-boolean confirmedRepeat", () => {
    expect(stageBatchSchema.safeParse({ id: "b1", mapping: validMapping, confirmedRepeat: true, extra: 1 }).success).toBe(false)
    expect(stageBatchSchema.safeParse({ id: "", mapping: validMapping, confirmedRepeat: true }).success).toBe(false)
    expect(stageBatchSchema.safeParse({ id: "b1", mapping: validMapping, confirmedRepeat: "yes" }).success).toBe(false)
  })
})

describe("saveProfileSchema", () => {
  it("refuses a blank name and a name of 61 characters, and accepts one of 60", () => {
    expect(saveProfileSchema.safeParse({ name: "", mapping: validMapping }).success).toBe(false)
    expect(saveProfileSchema.safeParse({ name: "   ", mapping: validMapping }).success).toBe(false)
    expect(saveProfileSchema.safeParse({ name: "x".repeat(61), mapping: validMapping }).success).toBe(false)
    expect(saveProfileSchema.safeParse({ name: "x".repeat(60), mapping: validMapping }).success).toBe(true)
  })

  it("takes an optional nodeId, and refuses an unknown key", () => {
    expect(saveProfileSchema.safeParse({ name: "HDFC", nodeId: "n1", mapping: validMapping }).success).toBe(true)
    expect(saveProfileSchema.safeParse({ name: "HDFC", mapping: validMapping }).success).toBe(true)
    expect(saveProfileSchema.safeParse({ name: "HDFC", mapping: validMapping, extra: 1 }).success).toBe(false)
  })
})

describe("batchIdSchema", () => {
  it("takes an id, and nothing else", () => {
    expect(batchIdSchema.parse({ id: "b1" })).toEqual({ id: "b1" })
    expect(batchIdSchema.safeParse({ id: "" }).success).toBe(false)
    expect(batchIdSchema.safeParse({ id: "b1", userId: "u" }).success).toBe(false)
  })
})
