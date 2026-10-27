import { describe, expect, it } from "vitest"
import { calendarDate } from "../domain/calendar-date"
import { transactionsHref } from "./report-drill"

const from = calendarDate("2026-01-01")
const to = calendarDate("2026-01-31")

describe("transactionsHref", () => {
  it("joins several nodes with a comma and encodes it", () => {
    expect(transactionsHref({ node: ["a", "b"], from, to })).toBe("/transactions?node=a%2Cb&from=2026-01-01&to=2026-01-31")
  })

  it("carries a flow", () => {
    expect(transactionsHref({ flow: "spending", from, to })).toBe("/transactions?flow=spending&from=2026-01-01&to=2026-01-31")
    expect(transactionsHref({ flow: "income", from, to })).toBe("/transactions?flow=income&from=2026-01-01&to=2026-01-31")
  })

  it("carries a kind", () => {
    expect(transactionsHref({ kind: "ASSET", from, to })).toBe("/transactions?kind=ASSET&from=2026-01-01&to=2026-01-31")
  })

  it("writes node, flow, kind, from, to in that order whatever order the object was built in", () => {
    expect(transactionsHref({ to, from, kind: "EXPENSE", flow: "spending", node: ["x"] })).toBe(
      "/transactions?node=x&flow=spending&kind=EXPENSE&from=2026-01-01&to=2026-01-31",
    )
  })

  it("omits an empty node list", () => {
    expect(transactionsHref({ node: [], from, to })).toBe("/transactions?from=2026-01-01&to=2026-01-31")
  })
})
