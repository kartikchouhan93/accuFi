import { describe, expect, it } from "vitest"
import { LEDGER_KINDS } from "@/domain/ledger-kind"
import { createNodeSchema } from "@/lib/schemas/node"
import { buildInput } from "./node-form-input"
import { CONTROLS, FIELDS_BY_KIND, INITIAL_VALUES } from "./node-fields"

const names = (kind: keyof typeof FIELDS_BY_KIND) => FIELDS_BY_KIND[kind].map((field) => field.name)

describe("FIELDS_BY_KIND, read from the schema", () => {
  it("has an entry for every kind the schema knows", () => {
    expect(Object.keys(FIELDS_BY_KIND).sort()).toEqual([...LEDGER_KINDS].sort())
  })

  it("lists each kind's fields in the schema's order, without the discriminator or fields the screen does not offer", () => {
    expect(names("ASSET")).toEqual(["name", "assetSubtype", "institution", "lastFour", "openingBalance"])
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
    expect(names("INVESTMENT")).toEqual(["name", "valuationMode", "unitLabel", "lotMethod", "institution"])
    expect(names("INCOME_SOURCE")).toEqual(["name"])
    expect(names("EXPENSE")).toEqual(["name"])
    expect(Object.values(CONTROLS).filter((control) => control.type === "none")).toHaveLength(1) // parentId
  })

  it("marks a field optional exactly when the schema does", () => {
    const optional = (kind: keyof typeof FIELDS_BY_KIND) => FIELDS_BY_KIND[kind].filter((f) => f.optional).map((f) => f.name)
    expect(optional("ASSET")).toEqual(["institution", "lastFour", "openingBalance"])
    expect(optional("INVESTMENT")).toEqual(["lotMethod", "institution"])
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

  it("sends the lot method only for an investment valued by quantity, and days as numbers", () => {
    expect(send("INVESTMENT", { name: "Gold", unitLabel: "gram", lotMethod: "LIFO", valuationMode: "LUMP" })).not.toHaveProperty("lotMethod")
    expect(send("INVESTMENT", { name: "Gold", unitLabel: "gram", lotMethod: "LIFO", valuationMode: "QUANTITY" })).toMatchObject({ lotMethod: "LIFO" })
    expect(send("LIABILITY", { name: "Card", statementDay: "12", dueDay: "2" })).toMatchObject({ statementDay: 12, dueDay: 2 })
  })
})
