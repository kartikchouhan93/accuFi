import { describe, expect, it } from "vitest"
import { calendarDate } from "./calendar-date"
import {
  ReportRangeError,
  clipToHistory,
  dayBuckets,
  monthBuckets,
  parseRangeChoice,
  rangeParams,
  resolveRange,
  selectableFinancialYears,
  selectableMonths,
  type RangeChoice,
} from "./periods"

const d = calendarDate
const TODAY = d("2026-10-27")

describe("resolveRange", () => {
  it("resolves a past month in full", () => {
    expect(resolveRange({ kind: "month", year: 2026, month: 4 }, TODAY, 4)).toEqual({
      from: "2026-04-01",
      to: "2026-04-30",
      requestedTo: "2026-04-30",
      clampedToToday: false,
    })
  })

  it("clamps the current month to today and remembers the requested end", () => {
    expect(resolveRange({ kind: "month", year: 2026, month: 10 }, TODAY, 4)).toEqual({
      from: "2026-10-01",
      to: "2026-10-27",
      requestedTo: "2026-10-31",
      clampedToToday: true,
    })
  })

  it("resolves financial years by their start year and start month", () => {
    expect(resolveRange({ kind: "fy", startYear: 2025 }, TODAY, 4)).toEqual({
      from: "2025-04-01",
      to: "2026-03-31",
      requestedTo: "2026-03-31",
      clampedToToday: false,
    })
    expect(resolveRange({ kind: "fy", startYear: 2026 }, TODAY, 4)).toEqual({
      from: "2026-04-01",
      to: "2026-10-27",
      requestedTo: "2027-03-31",
      clampedToToday: true,
    })
    expect(resolveRange({ kind: "fy", startYear: 2025 }, TODAY, 1)).toMatchObject({
      from: "2025-01-01",
      to: "2025-12-31",
    })
  })

  it("resolves last12 to the 1st of the month eleven months back, through today", () => {
    expect(resolveRange({ kind: "last12" }, TODAY, 4)).toEqual({
      from: "2025-11-01",
      to: "2026-10-27",
      requestedTo: "2026-10-27",
      clampedToToday: false,
    })
    expect(resolveRange({ kind: "last12" }, d("2026-01-15"), 4).from).toBe("2025-02-01")
  })

  it("passes a custom range through and clamps a future end to today", () => {
    expect(resolveRange({ kind: "custom", from: d("2026-01-01"), to: d("2026-03-31") }, TODAY, 4)).toEqual({
      from: "2026-01-01",
      to: "2026-03-31",
      requestedTo: "2026-03-31",
      clampedToToday: false,
    })
    expect(resolveRange({ kind: "custom", from: d("2026-10-01"), to: d("2026-12-31") }, TODAY, 4)).toEqual({
      from: "2026-10-01",
      to: "2026-10-27",
      requestedTo: "2026-12-31",
      clampedToToday: true,
    })
  })

  it("rejects a custom range that ends before it starts", () => {
    const choice: RangeChoice = { kind: "custom", from: d("2026-03-01"), to: d("2026-01-01") }
    expect(() => resolveRange(choice, TODAY, 4)).toThrow(ReportRangeError)
    expect(() => resolveRange(choice, TODAY, 4)).toThrow(/before/)
  })

  it("rejects a custom range longer than ten years", () => {
    const choice: RangeChoice = { kind: "custom", from: d("2000-01-01"), to: d("2026-01-01") }
    expect(() => resolveRange(choice, TODAY, 4)).toThrow(ReportRangeError)
    expect(() => resolveRange(choice, TODAY, 4)).toThrow(/10 years/)
  })

  it("accepts a custom range of exactly 3660 days and rejects 3661, counting both ends", () => {
    // 1 Jan 2010 to 1 Jan 2020 is 3652 days (ten years of 365, plus 29 Feb 2012 and 2016), so 1 Jan 2010 to 8 Jan 2020
    // is 3659 days apart: 3660 days counting both ends. One more day is 3661. Today is far ahead, so nothing is clamped.
    const today = d("2030-06-30")
    const most: RangeChoice = { kind: "custom", from: d("2010-01-01"), to: d("2020-01-08") }
    expect(resolveRange(most, today, 4)).toEqual({ from: "2010-01-01", to: "2020-01-08", requestedTo: "2020-01-08", clampedToToday: false })
    const over: RangeChoice = { kind: "custom", from: d("2010-01-01"), to: d("2020-01-09") }
    expect(() => resolveRange(over, today, 4)).toThrow(ReportRangeError)
    expect(() => resolveRange(over, today, 4)).toThrow(/10 years/)
  })

  it("rejects a custom range that starts after today", () => {
    const choice: RangeChoice = { kind: "custom", from: d("2026-11-01"), to: d("2026-12-01") }
    expect(() => resolveRange(choice, TODAY, 4)).toThrow(ReportRangeError)
    expect(() => resolveRange(choice, TODAY, 4)).toThrow(/after today/)
  })

  it("rejects a month that has not started yet", () => {
    expect(() => resolveRange({ kind: "month", year: 2026, month: 11 }, TODAY, 4)).toThrow(/after today/)
  })
})

describe("parseRangeChoice", () => {
  it("treats an absent range as last12", () => {
    expect(parseRangeChoice({})).toEqual({ kind: "last12" })
    expect(parseRangeChoice({ range: "last12" })).toEqual({ kind: "last12" })
  })

  it("parses month, financial year and custom choices", () => {
    expect(parseRangeChoice({ range: "month-2026-04" })).toEqual({ kind: "month", year: 2026, month: 4 })
    expect(parseRangeChoice({ range: "fy-2025" })).toEqual({ kind: "fy", startYear: 2025 })
    expect(parseRangeChoice({ range: "custom", from: "2026-01-01", to: "2026-03-31" })).toEqual({
      kind: "custom",
      from: "2026-01-01",
      to: "2026-03-31",
    })
  })

  it("rejects anything outside the grammar with ReportRangeError", () => {
    const bad = [
      { range: "month-2026-13" },
      { range: "month-2026-00" },
      { range: "month-2026-4" },
      { range: "fy-abc" },
      { range: "fy-26" },
      { range: "bogus" },
      { range: "" },
      { range: "custom", from: "2026-01-01" },
      { range: "custom", to: "2026-01-01" },
      { range: "custom", from: "2026-02-30", to: "2026-03-01" },
    ]
    for (const params of bad) {
      expect(() => parseRangeChoice(params), JSON.stringify(params)).toThrow(ReportRangeError)
    }
  })
})

describe("rangeParams", () => {
  it("round-trips every valid choice through parseRangeChoice", () => {
    const choices: RangeChoice[] = [
      { kind: "last12" },
      { kind: "month", year: 2026, month: 4 },
      { kind: "month", year: 2025, month: 12 },
      { kind: "fy", startYear: 2025 },
      { kind: "custom", from: d("2026-01-01"), to: d("2026-03-31") },
    ]
    for (const choice of choices) {
      expect(parseRangeChoice(rangeParams(choice)), JSON.stringify(choice)).toEqual(choice)
    }
  })

  it("writes the URL grammar", () => {
    expect(rangeParams({ kind: "last12" })).toEqual({ range: "last12" })
    expect(rangeParams({ kind: "month", year: 2026, month: 4 })).toEqual({ range: "month-2026-04" })
    expect(rangeParams({ kind: "fy", startYear: 2025 })).toEqual({ range: "fy-2025" })
    expect(rangeParams({ kind: "custom", from: d("2026-01-01"), to: d("2026-03-31") })).toEqual({
      range: "custom",
      from: "2026-01-01",
      to: "2026-03-31",
    })
  })
})

describe("monthBuckets", () => {
  it("splits a range into calendar months, marking the cut ends partial", () => {
    expect(monthBuckets({ from: d("2026-01-15"), to: d("2026-03-10") })).toEqual([
      { key: "2026-01", from: "2026-01-15", to: "2026-01-31", partial: true },
      { key: "2026-02", from: "2026-02-01", to: "2026-02-28", partial: false },
      { key: "2026-03", from: "2026-03-01", to: "2026-03-10", partial: true },
    ])
  })

  it("ends February on the leap day in a leap year", () => {
    const buckets = monthBuckets({ from: d("2024-02-01"), to: d("2024-02-29") })
    expect(buckets).toEqual([{ key: "2024-02", from: "2024-02-01", to: "2024-02-29", partial: false }])
  })

  it("gives a one-day range a single partial bucket", () => {
    expect(monthBuckets({ from: d("2026-05-10"), to: d("2026-05-10") })).toEqual([
      { key: "2026-05", from: "2026-05-10", to: "2026-05-10", partial: true },
    ])
  })

  it("crosses a year boundary", () => {
    expect(monthBuckets({ from: d("2025-12-01"), to: d("2026-01-31") }).map((b) => b.key)).toEqual([
      "2025-12",
      "2026-01",
    ])
  })
})

describe("dayBuckets", () => {
  it("makes one single-day bucket per day, across a month end", () => {
    const buckets = dayBuckets({ from: d("2026-02-27"), to: d("2026-03-02") })
    expect(buckets.map((b) => b.key)).toEqual(["2026-02-27", "2026-02-28", "2026-03-01", "2026-03-02"])
    expect(buckets[0]).toEqual({ key: "2026-02-27", from: "2026-02-27", to: "2026-02-27", partial: false })
  })
})

describe("clipToHistory", () => {
  const range = { from: d("2025-11-01"), to: d("2026-10-27") }

  it("moves the start to the 1st of the first transaction's month and reports where history begins", () => {
    expect(clipToHistory(range, d("2026-03-18"))).toEqual({
      from: "2026-03-01",
      to: "2026-10-27",
      historyBegins: "2026-03-18",
    })
  })

  it("leaves the range alone when history starts before it, or there is none, or it starts after it", () => {
    const unchanged = { ...range, historyBegins: null }
    expect(clipToHistory(range, d("2025-06-10"))).toEqual(unchanged)
    expect(clipToHistory(range, null)).toEqual(unchanged)
    expect(clipToHistory(range, d("2026-11-02"))).toEqual(unchanged)
  })

  it("never clips earlier than the range start", () => {
    expect(clipToHistory({ from: d("2025-11-15"), to: d("2026-10-27") }, d("2025-11-20"))).toEqual({
      from: "2025-11-15",
      to: "2026-10-27",
      historyBegins: "2025-11-20",
    })
  })
})

describe("selectableMonths", () => {
  it("lists every month from the first transaction's to today's, newest first", () => {
    expect(selectableMonths(d("2026-02-10"), d("2026-04-02"))).toEqual([
      { year: 2026, month: 4 },
      { year: 2026, month: 3 },
      { year: 2026, month: 2 },
    ])
  })

  it("is empty when the first transaction is in the future", () => {
    expect(selectableMonths(d("2026-06-01"), d("2026-04-02"))).toEqual([])
  })
})

describe("selectableFinancialYears", () => {
  it("lists the start year of each financial year touched, newest first", () => {
    expect(selectableFinancialYears(d("2025-11-05"), d("2026-10-27"), 4)).toEqual([2026, 2025])
    expect(selectableFinancialYears(d("2026-04-01"), d("2026-10-27"), 4)).toEqual([2026])
    expect(selectableFinancialYears(d("2025-11-05"), d("2026-10-27"), 1)).toEqual([2026, 2025])
  })
})
