import { describe, expect, it } from "vitest"
import { budgetIdSchema, budgetSettingsSchema, createBudgetSchema, monthField, reviseBudgetSchema } from "@/lib/schemas/budget"

const valid = { nodeId: "food", amount: "5,000", startMonth: "2026-11", rollover: false }

const messagesOf = (result: { success: boolean; error?: { issues: { message: string; path: PropertyKey[] }[] } }) =>
  result.error?.issues.map((i) => `${i.path.join(".")}: ${i.message}`) ?? []

describe("monthField", () => {
  it("turns YYYY-MM into the first of the month", () => {
    expect(monthField.parse("2026-11")).toBe("2026-11-01")
    expect(monthField.parse("2024-02")).toBe("2024-02-01")
  })

  it.each(["2026-11-15", "2026-11-01", "11/2026", "2026-13", "2026-00", "2026-1", "", "november", " 2026-11", "0999-01"])(
    "refuses %j",
    (text) => {
      const result = monthField.safeParse(text)
      expect(result.success).toBe(false)
      expect(messagesOf(result)).toEqual([": Enter a month"])
    },
  )

  it("refuses a non-string", () => {
    expect(monthField.safeParse(202611).success).toBe(false)
  })
})

describe("createBudgetSchema", () => {
  it("parses rupee text to paise and month text to first-of-month dates", () => {
    const parsed = createBudgetSchema.parse({ ...valid, amount: "1,000.50", endMonth: "2027-03" })
    expect(parsed).toEqual({ nodeId: "food", amount: 100_050n, startMonth: "2026-11-01", endMonth: "2027-03-01", rollover: false })
  })

  it("takes an absent or null end month", () => {
    expect(createBudgetSchema.parse(valid).endMonth).toBeUndefined()
    expect(createBudgetSchema.parse({ ...valid, endMonth: null }).endMonth).toBeNull()
  })

  it.each(["0", "-1", "", "abc", "1.234"])("refuses the amount %j", (amount) => {
    expect(createBudgetSchema.safeParse({ ...valid, amount }).success).toBe(false)
  })

  it("says why a zero amount is refused", () => {
    expect(messagesOf(createBudgetSchema.safeParse({ ...valid, amount: "0" }))).toEqual(["amount: The amount must be greater than zero"])
  })

  it("refuses a bad month under the field it was typed in", () => {
    expect(messagesOf(createBudgetSchema.safeParse({ ...valid, startMonth: "2026-11-15" }))).toEqual(["startMonth: Enter a month"])
    expect(messagesOf(createBudgetSchema.safeParse({ ...valid, endMonth: "2026-13" }))).toEqual(["endMonth: Enter a month"])
  })

  it("refuses a rollover that is not a boolean", () => {
    for (const rollover of ["true", 1, null, undefined]) {
      expect(createBudgetSchema.safeParse({ ...valid, rollover }).success).toBe(false)
    }
  })

  it("refuses an empty ledger id and unknown keys", () => {
    expect(createBudgetSchema.safeParse({ ...valid, nodeId: "" }).success).toBe(false)
    expect(createBudgetSchema.safeParse({ ...valid, userId: "someone-else" }).success).toBe(false)
    expect(createBudgetSchema.safeParse({ ...valid, id: "b1" }).success).toBe(false)
  })
})

describe("reviseBudgetSchema", () => {
  const revise = { id: "b1", amount: "6,000", appliesFrom: "2026-11" }

  it("parses the amount and the month", () => {
    expect(reviseBudgetSchema.parse(revise)).toEqual({ id: "b1", amount: 600_000n, appliesFrom: "2026-11-01" })
  })

  it("refuses unknown keys: a revise cannot move the start month or name a user", () => {
    expect(reviseBudgetSchema.safeParse({ ...revise, startMonth: "2026-01" }).success).toBe(false)
    expect(reviseBudgetSchema.safeParse({ ...revise, userId: "u" }).success).toBe(false)
  })

  it("refuses a missing id, a bad month and a zero amount", () => {
    expect(reviseBudgetSchema.safeParse({ ...revise, id: "" }).success).toBe(false)
    expect(reviseBudgetSchema.safeParse({ ...revise, appliesFrom: "2026-11-15" }).success).toBe(false)
    expect(reviseBudgetSchema.safeParse({ ...revise, amount: "0" }).success).toBe(false)
  })
})

describe("budgetSettingsSchema", () => {
  it("takes an end month or null, and a rollover", () => {
    expect(budgetSettingsSchema.parse({ id: "b1", endMonth: "2027-01", rollover: true })).toEqual({ id: "b1", endMonth: "2027-01-01", rollover: true })
    expect(budgetSettingsSchema.parse({ id: "b1", endMonth: null, rollover: false }).endMonth).toBeNull()
  })

  it("requires the end month to be stated (null removes it) and refuses what it does not know", () => {
    expect(budgetSettingsSchema.safeParse({ id: "b1", rollover: false }).success).toBe(false)
    expect(budgetSettingsSchema.safeParse({ id: "b1", endMonth: null, rollover: "yes" }).success).toBe(false)
    expect(budgetSettingsSchema.safeParse({ id: "b1", endMonth: null, rollover: false, amount: "1" }).success).toBe(false)
    expect(budgetSettingsSchema.safeParse({ id: "b1", endMonth: "2027-01-31", rollover: false }).success).toBe(false)
  })
})

describe("budgetIdSchema", () => {
  it("is the id alone", () => {
    expect(budgetIdSchema.parse({ id: "b1" })).toEqual({ id: "b1" })
    expect(budgetIdSchema.safeParse({ id: "" }).success).toBe(false)
    expect(budgetIdSchema.safeParse({ id: "b1", userId: "u" }).success).toBe(false)
  })
})
