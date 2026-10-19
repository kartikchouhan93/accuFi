import { describe, expect, it } from "vitest"
import { createNodeSchema, nodeIdSchema, renameNodeSchema } from "./node"

const parse = (input: unknown) => createNodeSchema.safeParse(input)
const fieldsWithIssues = (input: unknown) => {
  const result = parse(input)
  return result.success ? [] : result.error.issues.map((issue) => issue.path.join("."))
}

describe("createNodeSchema", () => {
  it("accepts a bank account and turns the opening balance from rupees into paise", () => {
    const result = parse({ kind: "ASSET", name: " HDFC ", assetSubtype: "SAVINGS", lastFour: "1234", openingBalance: "1,23,456.78" })
    expect(result.success && result.data).toEqual({
      kind: "ASSET",
      name: "HDFC",
      assetSubtype: "SAVINGS",
      lastFour: "1234",
      openingBalance: 12_345_678n,
    })
  })

  it("requires assetSubtype for an ASSET", () => {
    expect(fieldsWithIssues({ kind: "ASSET", name: "Bank" })).toEqual(["assetSubtype"])
  })

  it("requires liabilitySubtype for a LIABILITY", () => {
    expect(fieldsWithIssues({ kind: "LIABILITY", name: "Card" })).toEqual(["liabilitySubtype"])
  })

  it("requires valuationMode and unitLabel for an INVESTMENT", () => {
    expect(fieldsWithIssues({ kind: "INVESTMENT", name: "Gold" }).sort()).toEqual(["unitLabel", "valuationMode"])
    expect(parse({ kind: "INVESTMENT", name: "Gold", valuationMode: "QUANTITY", unitLabel: "gram" }).success).toBe(true)
  })

  it("needs nothing beyond a name for an INCOME_SOURCE or EXPENSE, and accepts a parent", () => {
    expect(parse({ kind: "EXPENSE", name: "Food" }).success).toBe(true)
    expect(parse({ kind: "INCOME_SOURCE", name: "Salary", parentId: "abc" }).success).toBe(true)
  })

  it("rejects an unknown or missing kind", () => {
    expect(parse({ kind: "BANK", name: "x" }).success).toBe(false)
    expect(parse({ name: "x" }).success).toBe(false)
  })

  it("rejects a field that belongs to another kind, rather than silently dropping it", () => {
    expect(parse({ kind: "ASSET", name: "Bank", assetSubtype: "CASH", creditLimit: "100" }).success).toBe(false)
    expect(parse({ kind: "EXPENSE", name: "Food", openingBalance: "10" }).success).toBe(false)
    expect(parse({ kind: "ASSET", name: "Bank", assetSubtype: "CASH", parentId: "abc" }).success).toBe(false)
  })

  it("rejects fields a caller must never set", () => {
    for (const forged of [{ userId: "x" }, { systemRole: "OPENING_BALANCE" }, { archivedAt: "2026-01-01" }, { id: "x" }]) {
      expect(parse({ kind: "EXPENSE", name: "Food", ...forged }).success).toBe(false)
    }
  })

  it("rejects a blank or over-long name", () => {
    expect(fieldsWithIssues({ kind: "EXPENSE", name: "   " })).toEqual(["name"])
    expect(fieldsWithIssues({ kind: "EXPENSE", name: "x".repeat(101) })).toEqual(["name"])
  })

  it("rejects a malformed or non-positive opening balance", () => {
    const base = { kind: "ASSET", name: "Bank", assetSubtype: "CASH" }
    for (const openingBalance of ["", "abc", "1.234", "1e3", "-5", "0", "0.00", "1,2,3"]) {
      expect(fieldsWithIssues({ ...base, openingBalance }), openingBalance).toEqual(["openingBalance"])
    }
    // a number is not rupees-as-text; money does not travel as a float
    expect(fieldsWithIssues({ ...base, openingBalance: 100 })).toEqual(["openingBalance"])
  })

  it("validates the liability fields", () => {
    const base = { kind: "LIABILITY", name: "Card", liabilitySubtype: "CREDIT_CARD" }
    expect(parse({ ...base, creditLimit: "2,00,000", statementDay: 5, dueDay: 25 }).success).toBe(true)
    expect(fieldsWithIssues({ ...base, statementDay: 0 })).toEqual(["statementDay"])
    expect(fieldsWithIssues({ ...base, dueDay: 32 })).toEqual(["dueDay"])
    expect(fieldsWithIssues({ ...base, dueDay: 2.5 })).toEqual(["dueDay"])
    expect(fieldsWithIssues({ ...base, creditLimit: "-1" })).toEqual(["creditLimit"])
    expect(fieldsWithIssues({ ...base, lastFour: "12" })).toEqual(["lastFour"])
  })

  it("renames creditLimit to paise in the parsed output", () => {
    const result = parse({ kind: "LIABILITY", name: "Card", liabilitySubtype: "CREDIT_CARD", creditLimit: "2,00,000" })
    expect(result.success && result.data).toMatchObject({ creditLimitPaise: 2_00_000_00n })
    expect(result.success && "creditLimit" in result.data).toBe(false)
  })
})

describe("renameNodeSchema", () => {
  it("accepts an id and a name, trimming the name", () => {
    const result = renameNodeSchema.safeParse({ nodeId: "abc", name: " New " })
    expect(result.success && result.data).toEqual({ nodeId: "abc", name: "New" })
  })

  it("refuses to carry a kind, so a rename can never change one", () => {
    // EC-34
    expect(renameNodeSchema.safeParse({ nodeId: "abc", name: "New", kind: "EXPENSE" }).success).toBe(false)
  })

  it("rejects a blank name and a missing id", () => {
    expect(renameNodeSchema.safeParse({ nodeId: "abc", name: " " }).success).toBe(false)
    expect(renameNodeSchema.safeParse({ name: "New" }).success).toBe(false)
  })
})

describe("nodeIdSchema", () => {
  it("accepts only a non-empty id", () => {
    expect(nodeIdSchema.safeParse({ nodeId: "abc" }).success).toBe(true)
    expect(nodeIdSchema.safeParse({ nodeId: "" }).success).toBe(false)
    expect(nodeIdSchema.safeParse({ nodeId: 5 }).success).toBe(false)
    expect(nodeIdSchema.safeParse({ nodeId: "abc", userId: "x" }).success).toBe(false)
  })
})
