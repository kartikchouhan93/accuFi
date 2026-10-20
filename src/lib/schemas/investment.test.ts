import { describe, expect, it } from "vitest"
import { previewSaleSchema, sellSchema } from "./investment"

const valid = {
  nodeId: "gold",
  toNodeId: "bank",
  quantity: "8.125",
  proceeds: "68,000.50",
  occurredAt: "2026-03-01",
  idempotencyKey: "0123456789abcdef",
}
const issuePaths = (result: { success: boolean; error?: { issues: { path: PropertyKey[] }[] } }) =>
  result.success ? [] : (result.error?.issues ?? []).map((issue) => issue.path.join("."))

describe("sellSchema", () => {
  it("turns rupee text into paise, quantity text into micro-units and the day into a CalendarDate", () => {
    const result = sellSchema.safeParse({ ...valid, note: "  Diwali " })
    expect(result.success && result.data).toEqual({
      nodeId: "gold",
      toNodeId: "bank",
      quantity: 8_125_000n,
      proceeds: 68_000_50n,
      occurredAt: "2026-03-01",
      note: "Diwali",
      idempotencyKey: "0123456789abcdef",
    })
  })

  it("holds the request key to the same rules as a transaction's", () => {
    expect(issuePaths(sellSchema.safeParse({ ...valid, idempotencyKey: "" }))).toEqual(["idempotencyKey"])
    expect(issuePaths(sellSchema.safeParse({ ...valid, idempotencyKey: "short" }))).toEqual(["idempotencyKey"])
    expect(issuePaths(sellSchema.safeParse({ ...valid, idempotencyKey: undefined }))).toEqual(["idempotencyKey"])
  })

  it.each(["0", "-1", "1.0000001", "abc", ""])("refuses the quantity %j", (quantity) => {
    expect(issuePaths(sellSchema.safeParse({ ...valid, quantity }))).toEqual(["quantity"])
  })

  it.each(["0", "-5", "1.234", "lots"])("refuses the proceeds %j", (proceeds) => {
    expect(issuePaths(sellSchema.safeParse({ ...valid, proceeds }))).toEqual(["proceeds"])
  })

  it("refuses a bad day, a number where text belongs, and fields it does not know", () => {
    expect(issuePaths(sellSchema.safeParse({ ...valid, occurredAt: "2026-02-30" }))).toEqual(["occurredAt"])
    expect(issuePaths(sellSchema.safeParse({ ...valid, quantity: 8 }))).toEqual(["quantity"])
    expect(issuePaths(sellSchema.safeParse({ ...valid, userId: "someone" }))).toEqual([""])
  })
})

describe("previewSaleSchema", () => {
  it("takes the sale without its key or note", () => {
    const { nodeId, toNodeId, quantity, proceeds, occurredAt } = valid
    const result = previewSaleSchema.safeParse({ nodeId, toNodeId, quantity, proceeds, occurredAt })
    expect(result.success && result.data).toEqual({
      nodeId: "gold",
      toNodeId: "bank",
      quantity: 8_125_000n,
      proceeds: 68_000_50n,
      occurredAt: "2026-03-01",
    })
    expect(previewSaleSchema.safeParse(valid).success).toBe(false)
  })
})
