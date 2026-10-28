import { describe, expect, it } from "vitest"
import { createRuleSchema, editRuleSchema, ruleIdSchema } from "@/lib/schemas/recurring"

const KEY = "0123456789abcdef"
const ruleFields = {
  name: "Rent",
  fromNodeId: "bank",
  toNodeId: "rent",
  amount: "12,500.50",
  frequency: "MONTHLY",
  interval: 1,
  autoPost: false,
}
const valid = { ...ruleFields, startDate: "2026-06-01", idempotencyKey: KEY }
const validEdit = { id: "r1", expectedVersion: 3, rule: { ...ruleFields, nextDue: "2026-06-15" } }

const messageOf = (result: { success: boolean; error?: { issues: { message: string; path: PropertyKey[] }[] } }) =>
  result.error?.issues.map((i) => `${i.path.join(".")}: ${i.message}`) ?? []

describe("createRuleSchema", () => {
  it("parses rupee text to paise and day text to calendar dates", () => {
    const parsed = createRuleSchema.parse({ ...valid, endDate: "2027-01-01", occurrenceLimit: 12, dayOfMonth: 31, note: "  hi ", tags: [" a "] })
    expect(parsed.amount).toBe(1_250_050n)
    expect(parsed.startDate).toBe("2026-06-01")
    expect(parsed.endDate).toBe("2027-01-01")
    expect(parsed.note).toBe("hi")
    expect(parsed.tags).toEqual(["a"])
    expect(parsed.dayOfMonth).toBe(31)
  })

  it.each(["userId", "version", "nextDueOn", "pausedAt", "id"])("refuses the unknown key %s", (key) => {
    const result = createRuleSchema.safeParse({ ...valid, [key]: "x" })
    expect(result.success).toBe(false)
  })

  it("refuses a blank name, a name of 61 characters, and trims one", () => {
    expect(createRuleSchema.safeParse({ ...valid, name: "   " }).success).toBe(false)
    expect(createRuleSchema.safeParse({ ...valid, name: "x".repeat(61) }).success).toBe(false)
    expect(createRuleSchema.parse({ ...valid, name: "x".repeat(60) }).name).toHaveLength(60)
    expect(createRuleSchema.parse({ ...valid, name: "  Rent  " }).name).toBe("Rent")
  })

  it("refuses bad dates, under the field they are in", () => {
    for (const field of ["startDate", "endDate"]) {
      for (const bad of ["2026-02-30", "June 1", "", "2026-6-1"]) {
        const result = createRuleSchema.safeParse({ ...valid, [field]: bad })
        expect(result.success).toBe(false)
        expect(messageOf(result)[0]).toContain(`${field}: Enter a valid date`)
      }
    }
  })

  it("refuses an interval that is not a whole number of at least 1", () => {
    for (const bad of [0, -1, 1.5, 100, "2", null]) {
      expect(createRuleSchema.safeParse({ ...valid, interval: bad }).success).toBe(false)
    }
    expect(createRuleSchema.parse({ ...valid, interval: 99 }).interval).toBe(99)
  })

  it("refuses a day of month or week out of range, and a limit below 1", () => {
    expect(createRuleSchema.safeParse({ ...valid, dayOfMonth: 0 }).success).toBe(false)
    expect(createRuleSchema.safeParse({ ...valid, dayOfMonth: 32 }).success).toBe(false)
    expect(createRuleSchema.safeParse({ ...valid, frequency: "WEEKLY", dayOfWeek: 8 }).success).toBe(false)
    expect(createRuleSchema.safeParse({ ...valid, occurrenceLimit: 0 }).success).toBe(false)
    expect(createRuleSchema.safeParse({ ...valid, frequency: "FORTNIGHTLY" }).success).toBe(false)
  })

  it("refuses amounts that are not positive rupees", () => {
    for (const bad of ["0", "-5", "abc", "1.234", ""]) {
      expect(createRuleSchema.safeParse({ ...valid, amount: bad }).success).toBe(false)
    }
    expect(createRuleSchema.parse({ ...valid, amount: "0.01" }).amount).toBe(1n)
  })

  it("holds the request key to the transaction form's floor", () => {
    expect(messageOf(createRuleSchema.safeParse({ ...valid, idempotencyKey: "" }))).toEqual(["idempotencyKey: A request key is required"])
    expect(createRuleSchema.safeParse({ ...valid, idempotencyKey: "short" }).success).toBe(false)
    expect(createRuleSchema.safeParse({ ...valid, idempotencyKey: "k".repeat(129) }).success).toBe(false)
    expect(createRuleSchema.safeParse({ ...valid, idempotencyKey: "k".repeat(16) }).success).toBe(true)
  })

  it("requires autoPost to be a switch, and refuses more than 20 tags or a 41-character tag", () => {
    expect(createRuleSchema.safeParse({ ...valid, autoPost: "yes" }).success).toBe(false)
    expect(createRuleSchema.safeParse({ ...valid, tags: Array.from({ length: 21 }, (_, i) => `t${i}`) }).success).toBe(false)
    expect(createRuleSchema.safeParse({ ...valid, tags: ["x".repeat(41)] }).success).toBe(false)
  })
})

describe("editRuleSchema", () => {
  it("takes the rule with a next due date in place of a start date", () => {
    const parsed = editRuleSchema.parse(validEdit)
    expect(parsed.rule.nextDue).toBe("2026-06-15")
    expect(parsed.expectedVersion).toBe(3)
    expect(parsed.rule.amount).toBe(1_250_050n)
  })

  it("refuses a start date, a request key, and unknown keys, inside the rule and beside it", () => {
    expect(editRuleSchema.safeParse({ ...validEdit, rule: { ...validEdit.rule, startDate: "2026-06-01" } }).success).toBe(false)
    expect(editRuleSchema.safeParse({ ...validEdit, rule: { ...validEdit.rule, idempotencyKey: KEY } }).success).toBe(false)
    expect(editRuleSchema.safeParse({ ...validEdit, userId: "u" }).success).toBe(false)
    expect(editRuleSchema.safeParse({ ...validEdit, rule: { ...validEdit.rule, nextDueOn: "2026-06-15" } }).success).toBe(false)
  })

  it("needs a bad next due date flagged, a whole non-negative version, and an id", () => {
    expect(messageOf(editRuleSchema.safeParse({ ...validEdit, rule: { ...validEdit.rule, nextDue: "nope" } }))).toEqual(["rule.nextDue: Enter a valid date"])
    expect(editRuleSchema.safeParse({ ...validEdit, expectedVersion: -1 }).success).toBe(false)
    expect(editRuleSchema.safeParse({ ...validEdit, expectedVersion: 1.5 }).success).toBe(false)
    expect(editRuleSchema.safeParse({ ...validEdit, id: "" }).success).toBe(false)
  })
})

describe("ruleIdSchema", () => {
  it("takes an id, and nothing else", () => {
    expect(ruleIdSchema.parse({ id: "r1" })).toEqual({ id: "r1" })
    expect(ruleIdSchema.safeParse({ id: "" }).success).toBe(false)
    expect(ruleIdSchema.safeParse({ id: "r1", userId: "u" }).success).toBe(false)
    expect(ruleIdSchema.safeParse({ id: "r1", paused: true }).success).toBe(false) // the pause and resume actions are named for the switch, not sent it
  })
})
