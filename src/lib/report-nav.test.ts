import { describe, expect, it } from "vitest"
import { calendarDate } from "../domain/calendar-date"
import { isReportSlug, REPORTS, reportHref } from "./report-nav"

describe("REPORTS", () => {
  it("lists six unique reports in the order the tabs show them", () => {
    expect(REPORTS.map((report) => report.slug)).toEqual(["net-worth", "cash-flow", "spending", "income", "accounts", "investments"])
    expect(REPORTS.map((report) => report.label)).toEqual([
      "Net worth",
      "Income vs expense",
      "Spending",
      "Income",
      "Account history",
      "Investment growth",
    ])
    expect(new Set(REPORTS.map((report) => report.slug)).size).toBe(6)
  })

  it("recognises only those slugs", () => {
    expect(isReportSlug("spending")).toBe(true)
    expect(isReportSlug("Spending")).toBe(false)
    expect(isReportSlug("constructor")).toBe(false)
  })
})

describe("reportHref", () => {
  it("names the range in the URL", () => {
    expect(reportHref("spending", { kind: "last12" })).toBe("/reports/spending?range=last12")
    expect(reportHref("income", { kind: "month", year: 2026, month: 1 })).toBe("/reports/income?range=month-2026-01")
    expect(reportHref("cash-flow", { kind: "fy", startYear: 2025 })).toBe("/reports/cash-flow?range=fy-2025")
    expect(reportHref("net-worth", { kind: "custom", from: calendarDate("2026-01-01"), to: calendarDate("2026-03-31") })).toBe(
      "/reports/net-worth?range=custom&from=2026-01-01&to=2026-03-31",
    )
  })

  it("keeps the chosen node, and leaves out a blank one", () => {
    expect(reportHref("accounts", { kind: "last12" }, { node: "ck123" })).toBe("/reports/accounts?range=last12&node=ck123")
    expect(reportHref("accounts", { kind: "last12" }, { node: "" })).toBe("/reports/accounts?range=last12")
  })
})
