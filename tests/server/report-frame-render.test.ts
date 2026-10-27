import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import { calendarDate } from "@/domain/calendar-date"
import type { RangeView } from "@/lib/report-view"

// The parts of a report screen around the report itself: the tabs, the range control and the notes on what the range
// leaves out. The router is stubbed: rendering to markup has no app router to push to.

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }))

const { ReportTabs } = await import("@/app/reports/report-tabs")
const { RangeControl } = await import("@/app/reports/range-control")
const { NothingToReport, ReportNotes } = await import("@/app/reports/report-notes")

const visibleText = (html: string) => html.replace(/<[^>]+>/g, "")

const range = (over: Partial<RangeView> = {}): RangeView => ({
  from: calendarDate("2025-11-01"),
  to: calendarDate("2026-10-28"),
  clampedToToday: false,
  historyBegins: null,
  futureCount: 0,
  ...over,
})

describe("ReportTabs", () => {
  const html = renderToStaticMarkup(createElement(ReportTabs, { current: "spending", choice: { kind: "month", year: 2026, month: 1 } }))

  it("links every report, keeping the range, and marks the current one", () => {
    const links = [...html.matchAll(/<a[^>]*href="([^"]*)"[^>]*>/g)].map((m) => m[0])
    expect(links).toHaveLength(6)
    const current = links.filter((link) => link.includes('aria-current="page"'))
    expect(current).toHaveLength(1)
    expect(current[0]).toContain('href="/reports/spending?range=month-2026-01"')
    expect(html).toContain('href="/reports/net-worth?range=month-2026-01"')
    expect(visibleText(html)).toMatch(/Net worth.*Income vs expense.*Spending.*Income.*Account history.*Investment growth/)
  })
})

describe("RangeControl", () => {
  const options = { months: [{ year: 2026, month: 10 }, { year: 2026, month: 9 }], fys: [2026, 2025] }

  it("offers every kind of range", () => {
    const html = renderToStaticMarkup(createElement(RangeControl, { current: "income", choice: { kind: "last12" }, range: range(), options, rangeError: null }))
    const text = visibleText(html)
    for (const label of ["Last 12 months", "Month", "Financial year", "Custom"]) expect(text).toContain(label)
    expect(html).not.toContain("aria-invalid")
  })

  it("says what is wrong with a range beside the control, tied to it for a screen reader", () => {
    const html = renderToStaticMarkup(
      createElement(RangeControl, {
        current: "income",
        choice: { kind: "last12" },
        range: range(),
        options,
        rangeError: '"month-2026-13" is not a recognised date range',
      }),
    )
    const id = /<p[^>]*id="([^"]+)"[^>]*>[^<]*is not a recognised date range/.exec(html.replaceAll("&quot;", '"'))?.[1]
    expect(id).toBeTruthy()
    expect(html).toContain(`aria-describedby="${id}"`)
  })

  it("starts on the month that was asked for", () => {
    const html = renderToStaticMarkup(
      createElement(RangeControl, { current: "income", choice: { kind: "month", year: 2026, month: 9 }, range: range(), options, rangeError: null }),
    )
    expect(html).toMatch(/type="month"[^>]*value="2026-09"|value="2026-09"[^>]*type="month"/)
  })
})

describe("ReportNotes", () => {
  it("says nothing when the range leaves nothing out", () => {
    expect(visibleText(renderToStaticMarkup(createElement(ReportNotes, { range: range() })))).toBe("")
  })

  it("says where history begins", () => {
    const text = visibleText(renderToStaticMarkup(createElement(ReportNotes, { range: range({ historyBegins: calendarDate("2026-04-04") }) })))
    expect(text).toContain("History begins 4 Apr 2026.")
  })

  it("counts future-dated entries and links to them", () => {
    const html = renderToStaticMarkup(createElement(ReportNotes, { range: range({ futureCount: 3 }) }))
    expect(visibleText(html)).toContain("3 future-dated entries are not included.")
    expect(html).toContain('href="/transactions?from=2026-10-29&amp;to="')
    expect(visibleText(renderToStaticMarkup(createElement(ReportNotes, { range: range({ futureCount: 1 }) })))).toContain(
      "1 future-dated entry is not included.",
    )
  })
})

describe("NothingToReport", () => {
  it("points to recording a transaction", () => {
    const html = renderToStaticMarkup(createElement(NothingToReport))
    expect(visibleText(html)).toContain("Nothing to report yet")
    // The link's text follows an icon, so match up to the link's end rather than up to the next tag.
    expect(html).toMatch(/<a[^>]*href="\/transactions"[^>]*>(?:(?!<\/a>).)*Record a transaction<\/a>/)
  })
})
