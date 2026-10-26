import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { LEDGER_KINDS } from "@/domain/ledger-kind"
import { createNodeSchema } from "@/lib/schemas/node"
import { buildInput, isVisible, validateBeforeSending } from "./node-form-input"
import { CONTROLS, FIELDS_BY_KIND, INITIAL_VALUES } from "./node-fields"

const names = (kind: keyof typeof FIELDS_BY_KIND) => FIELDS_BY_KIND[kind].map((field) => field.name)

describe("FIELDS_BY_KIND, read from the schema", () => {
  it("has an entry for every kind the schema knows", () => {
    expect(Object.keys(FIELDS_BY_KIND).sort()).toEqual([...LEDGER_KINDS].sort())
  })

  it("lists each kind's fields in the schema's order, without the discriminator or fields the screen does not offer", () => {
    expect(names("ASSET")).toEqual(["name", "assetSubtype", "institution", "lastFour", "openingBalance", "blockNegative"])
    expect(names("LIABILITY")).toEqual([
      "name",
      "liabilitySubtype",
      "institution",
      "lastFour",
      "creditLimit",
      "statementDay",
      "dueDay",
      "openingBalance",
    ])
    expect(names("INVESTMENT")).toEqual(["name", "valuationMode", "unitLabel", "lotMethod", "stalePriceDays", "institution"])
    expect(names("INCOME_SOURCE")).toEqual(["name"])
    expect(names("EXPENSE")).toEqual(["name"])
    expect(Object.values(CONTROLS).filter((control) => control.type === "none")).toHaveLength(1) // parentId
  })

  it("marks a field optional exactly when the schema does", () => {
    const optional = (kind: keyof typeof FIELDS_BY_KIND) => FIELDS_BY_KIND[kind].filter((f) => f.optional).map((f) => f.name)
    expect(optional("ASSET")).toEqual(["institution", "lastFour", "openingBalance", "blockNegative"])
    expect(optional("INVESTMENT")).toEqual(["lotMethod", "stalePriceDays", "institution"])
  })

  it("starts a required choice on its first option and everything else empty", () => {
    expect(INITIAL_VALUES).toMatchObject({ name: "", assetSubtype: "SAVINGS", liabilitySubtype: "CREDIT_CARD", valuationMode: "QUANTITY" })
    expect(INITIAL_VALUES.lotMethod).toBe("")
    expect(INITIAL_VALUES.openingBalance).toBe("")
  })
})

describe("buildInput, what the form sends", () => {
  const send = (kind: keyof typeof FIELDS_BY_KIND, values: Record<string, string>, direction: "positive" | "negative" = "positive") =>
    buildInput(kind, FIELDS_BY_KIND[kind], { ...INITIAL_VALUES, ...values }, direction)

  it("sends something the server's schema accepts for every kind, whatever the form starts with", () => {
    for (const kind of LEDGER_KINDS) {
      const input = send(kind, { name: "Probe", unitLabel: "gram" })
      expect(createNodeSchema.safeParse(input).success, kind).toBe(true)
    }
  })

  it("joins the direction to the unsigned amount, so an owed balance goes as a negative", () => {
    expect(send("LIABILITY", { name: "Card", openingBalance: "12,000" }, "negative")).toMatchObject({ openingBalance: "-12,000" })
    expect(send("ASSET", { name: "Bank", openingBalance: "12,000" }, "positive")).toMatchObject({ openingBalance: "12,000" })
  })

  it("leaves out empty optional fields and fields that are not on screen for the kind", () => {
    const input = send("ASSET", { name: " Bank ", institution: "  ", unitLabel: "stale" })
    expect(input).toEqual({ kind: "ASSET", name: "Bank", assetSubtype: "SAVINGS" })
  })

  it("sends the overdraft guard only when it is switched on", () => {
    expect(send("ASSET", { name: "Bank", blockNegative: "true" })).toMatchObject({ blockNegative: true })
    expect(send("ASSET", { name: "Bank", blockNegative: "" })).not.toHaveProperty("blockNegative")
    expect(createNodeSchema.safeParse(send("ASSET", { name: "Bank", blockNegative: "true" })).success).toBe(true)
  })

  it("sends the lot method only for an investment valued by quantity, and days as numbers", () => {
    expect(send("INVESTMENT", { name: "Gold", unitLabel: "gram", lotMethod: "LIFO", valuationMode: "LUMP" })).not.toHaveProperty("lotMethod")
    expect(send("INVESTMENT", { name: "Gold", unitLabel: "gram", lotMethod: "LIFO", valuationMode: "QUANTITY" })).toMatchObject({ lotMethod: "LIFO" })
    expect(send("LIABILITY", { name: "Card", statementDay: "12", dueDay: "2" })).toMatchObject({ statementDay: 12, dueDay: 2 })
  })
})

describe("the stale-price window", () => {
  const send = (values: Record<string, string>) => buildInput("INVESTMENT", FIELDS_BY_KIND.INVESTMENT, { ...INITIAL_VALUES, name: "Plot", unitLabel: "plot", ...values }, "positive")
  const field = FIELDS_BY_KIND.INVESTMENT.find((candidate) => candidate.name === "stalePriceDays")

  it("is offered for an investment valued by a price, by quantity or as a lump, and not for one valued by what was put in", () => {
    expect(field?.control.label).toBe("Price goes stale after (days)")
    expect(field?.control.hint).toBe("Leave empty to use your default of 30 days. A plot of land might use 365.")
    expect(field && isVisible(field, { ...INITIAL_VALUES, valuationMode: "QUANTITY" })).toBe(true)
    expect(field && isVisible(field, { ...INITIAL_VALUES, valuationMode: "LUMP" })).toBe(true)
    // No price ever values a contribution-only investment, so there is nothing to go stale.
    expect(field && isVisible(field, { ...INITIAL_VALUES, valuationMode: "CONTRIBUTION_ONLY" })).toBe(false)
  })

  it("is sent as a whole number when given, left out when empty or hidden, and accepted by the server's schema", () => {
    expect(send({ valuationMode: "LUMP", stalePriceDays: " 365 " })).toMatchObject({ stalePriceDays: 365 })
    expect(createNodeSchema.safeParse(send({ valuationMode: "LUMP", stalePriceDays: "365" })).success).toBe(true)
    expect(send({ valuationMode: "QUANTITY", stalePriceDays: "" })).not.toHaveProperty("stalePriceDays")
    expect(send({ valuationMode: "CONTRIBUTION_ONLY", stalePriceDays: "365" })).not.toHaveProperty("stalePriceDays")
  })

  it("is checked before sending: a whole number of days from 1 to 3650", () => {
    const fields = FIELDS_BY_KIND.INVESTMENT
    const check = (stalePriceDays: string) =>
      validateBeforeSending("INVESTMENT", fields, { ...INITIAL_VALUES, name: "Plot", unitLabel: "plot", valuationMode: "LUMP", stalePriceDays })
    for (const good of ["", "1", "365", "3650"]) expect(check(good), good).toEqual({})
    for (const bad of ["0", "3651", "1.5", "-5", "a year", "1e3"]) {
      expect(check(bad), bad).toEqual({ stalePriceDays: ["Enter a whole number of days from 1 to 3650"] })
    }
  })
})

describe("the overdraft guard's label", () => {
  const control = CONTROLS.blockNegative

  it("says what the guard does: it is judged as of today, not across the past", () => {
    expect(control.type).toBe("checkbox")
    expect(control.label).toBe("Block entries that would leave this account overdrawn as of today")
  })

  it("is said in the same words by the module that enforces it", () => {
    // The guard reads balances on one day (src/server/services/transaction-service.ts). The control and that module's
    // header must not drift apart, or the user is promised more than the code does.
    const header = readFileSync("src/server/services/transaction-service.ts", "utf8").split("\n").filter((line) => line.startsWith("//")).join(" ").replace(/\s*\/\/\s*/g, " ")
    expect(header).toContain(control.label)
  })
})
