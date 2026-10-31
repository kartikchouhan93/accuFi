import { describe, expect, it } from "vitest"
import {
  NEAR_PERCENT_TENTHS,
  PROJECTION_MIN_DAYS,
  countedNodeIds,
  evaluateMonths,
  percentTenths,
  projectionOf,
  spansOverlap,
  statusOf,
  type BudgetSpan,
} from "./budgets"
import { calendarDate, type CalendarDate } from "./calendar-date"
import type { Paise } from "./money"

// The `test` script runs this file under two timezones; month arithmetic here must not notice.
const d = (value: string): CalendarDate => calendarDate(value)
const paise = (n: bigint): Paise => n as Paise

function span(overrides: Partial<BudgetSpan> & Pick<BudgetSpan, "startMonth">): BudgetSpan {
  return { id: "b", nodeId: "n", amountPaise: paise(10_000n), endMonth: null, rollover: true, ...overrides }
}

function used(entries: Record<string, bigint>): Map<CalendarDate, Paise> {
  return new Map(Object.entries(entries).map(([month, amount]) => [d(month), paise(amount)]))
}

describe("constants", () => {
  it("near is 80.0% and a projection needs a week of data", () => {
    expect(NEAR_PERCENT_TENTHS).toBe(800n)
    expect(PROJECTION_MIN_DAYS).toBe(7)
  })
})

describe("percentTenths and statusOf", () => {
  it("is tenths of a percent, half up", () => {
    expect(percentTenths(paise(7_990n), paise(10_000n))).toBe(799n)
    expect(percentTenths(paise(8_000n), paise(10_000n))).toBe(800n)
    expect(percentTenths(paise(1n), paise(3n))).toBe(333n)
    expect(percentTenths(paise(2n), paise(3n))).toBe(667n)
  })

  it("is null for a negative used amount and for no positive available", () => {
    expect(percentTenths(paise(-500n), paise(10_000n))).toBeNull()
    expect(percentTenths(paise(100n), paise(0n))).toBeNull()
    expect(percentTenths(paise(100n), paise(-5n))).toBeNull()
  })

  it("is on track below 80%, near from 80% through exactly 100%, over above", () => {
    expect(statusOf(paise(7_990n), paise(10_000n))).toBe("ON_TRACK")
    expect(statusOf(paise(8_000n), paise(10_000n))).toBe("NEAR")
    // NEAR follows the rounded, displayed percent: 79.96% reads 80.0%, 79.94% reads 79.9%.
    expect(statusOf(paise(7_996n), paise(10_000n))).toBe("NEAR")
    expect(statusOf(paise(7_994n), paise(10_000n))).toBe("ON_TRACK")
    expect(statusOf(paise(10_000n), paise(10_000n))).toBe("NEAR")
    expect(statusOf(paise(10_001n), paise(10_000n))).toBe("OVER")
    // Over is by comparison, not by the rounded percent, which is still 100.0% here.
    expect(percentTenths(paise(10_001n), paise(10_000n))).toBe(1000n)
  })

  it("is on track for a net refund and for nothing spent against nothing available", () => {
    expect(statusOf(paise(-500n), paise(10_000n))).toBe("ON_TRACK")
    expect(statusOf(paise(0n), paise(0n))).toBe("ON_TRACK")
  })

  it("is over for any spend when nothing is available", () => {
    expect(statusOf(paise(1n), paise(0n))).toBe("OVER")
  })

  it("is exact beyond the safe-integer range", () => {
    const part = paise(999_999_999_999_999_999n)
    const whole = paise(1_000_000_000_000_000_000n)
    expect(percentTenths(part, whole)).toBe(1000n)
    // The half-way point is 49.95%: one paise below it rounds down, the point itself rounds up.
    expect(percentTenths(paise(499_499_999_999_999_999n), whole)).toBe(499n)
    expect(percentTenths(paise(499_500_000_000_000_000n), whole)).toBe(500n)
    expect(statusOf(part, whole)).toBe("NEAR")
  })
})

describe("projectionOf", () => {
  it("scales the spend so far to the whole month", () => {
    expect(projectionOf(paise(30_000n), d("2026-11-01"), d("2026-11-10"))).toBe(90_000n)
  })

  it("rounds half up", () => {
    expect(projectionOf(paise(100n), d("2026-11-01"), d("2026-11-07"))).toBe(429n) // 428.57
    expect(projectionOf(paise(1n), d("2026-11-01"), d("2026-11-12"))).toBe(3n) // 2.5
  })

  it("needs seven days elapsed, counting today", () => {
    expect(projectionOf(paise(100n), d("2026-11-01"), d("2026-11-06"))).toBeNull()
    expect(projectionOf(paise(100n), d("2026-11-01"), d("2026-11-07"))).not.toBeNull()
  })

  it("needs something spent", () => {
    expect(projectionOf(paise(0n), d("2026-11-01"), d("2026-11-20"))).toBeNull()
    expect(projectionOf(paise(-500n), d("2026-11-01"), d("2026-11-20"))).toBeNull()
  })

  it("is for the current month only", () => {
    expect(projectionOf(paise(30_000n), d("2026-11-01"), d("2026-12-10"))).toBeNull()
    expect(projectionOf(paise(30_000n), d("2026-11-01"), d("2026-10-20"))).toBeNull()
  })

  it("uses 29 days for February in a leap year", () => {
    expect(projectionOf(paise(10_000n), d("2028-02-01"), d("2028-02-10"))).toBe(29_000n)
    expect(projectionOf(paise(10_000n), d("2027-02-01"), d("2027-02-10"))).toBe(28_000n)
  })

  it("is exact beyond the safe-integer range", () => {
    expect(projectionOf(paise(999_999_999_999_999_999n), d("2026-11-01"), d("2026-11-30"))).toBe(
      999_999_999_999_999_999n,
    )
    // 10^18 spent in 10 days of a 30-day month projects to exactly 3 × 10^18.
    expect(projectionOf(paise(1_000_000_000_000_000_000n), d("2026-11-01"), d("2026-11-10"))).toBe(
      3_000_000_000_000_000_000n,
    )
    // 999_999_999_999_999_999 × 30 = 29_999_999_999_999_999_970, which 7 divides exactly; a Number would round it.
    expect(projectionOf(paise(999_999_999_999_999_999n), d("2026-11-01"), d("2026-11-07"))).toBe(
      4_285_714_285_714_285_710n,
    )
    // Not an exact division: 30 × 10^18 ÷ 7 is 4_285_714_285_714_285_714.28…, so it rounds down to …714.
    expect(projectionOf(paise(1_000_000_000_000_000_000n), d("2026-11-01"), d("2026-11-07"))).toBe(
      4_285_714_285_714_285_714n,
    )
  })
})

describe("spansOverlap", () => {
  it("shares a month, end inclusive", () => {
    expect(spansOverlap({ startMonth: d("2026-01-01"), endMonth: d("2026-03-01") }, { startMonth: d("2026-03-01"), endMonth: null })).toBe(true)
  })

  it("does not overlap when one ends the month before the other starts", () => {
    expect(spansOverlap({ startMonth: d("2026-01-01"), endMonth: d("2026-02-01") }, { startMonth: d("2026-03-01"), endMonth: null })).toBe(false)
    expect(spansOverlap({ startMonth: d("2026-03-01"), endMonth: null }, { startMonth: d("2026-01-01"), endMonth: d("2026-02-01") })).toBe(false)
  })

  it("overlaps when both are open", () => {
    expect(spansOverlap({ startMonth: d("2026-01-01"), endMonth: null }, { startMonth: d("2026-06-01"), endMonth: null })).toBe(true)
  })

  it("overlaps when one sits inside the other", () => {
    expect(spansOverlap({ startMonth: d("2026-01-01"), endMonth: d("2026-12-01") }, { startMonth: d("2026-05-01"), endMonth: d("2026-05-01") })).toBe(true)
  })
})

describe("countedNodeIds", () => {
  const nodes = [
    { id: "P", parentId: null, kind: "EXPENSE" as const, systemRole: null },
    { id: "c1", parentId: "P", kind: "EXPENSE" as const, systemRole: null },
    { id: "other-parent-child", parentId: "Q", kind: "EXPENSE" as const, systemRole: null },
    { id: "wrong-kind", parentId: "P", kind: "ASSET" as const, systemRole: null },
    { id: "system", parentId: "P", kind: "EXPENSE" as const, systemRole: "REALISED_LOSS" as const },
    { id: "c2-archived", parentId: "P", kind: "EXPENSE" as const, systemRole: null },
  ]

  it("is the node then its expense, non-system children in input order", () => {
    expect(countedNodeIds("P", nodes)).toEqual(["P", "c1", "c2-archived"])
  })

  it("is just the node for a leaf", () => {
    expect(countedNodeIds("c1", nodes)).toEqual(["c1"])
  })
})

describe("evaluateMonths", () => {
  it("returns nothing when no span has started by the current month", () => {
    expect(evaluateMonths([span({ startMonth: d("2027-01-01") })], used({}), d("2026-11-15"))).toEqual([])
    expect(evaluateMonths([], used({}), d("2026-11-15"))).toEqual([])
  })

  it("carries what was left over into the next month and not what was overspent", () => {
    const spans = [span({ id: "A", startMonth: d("2026-01-01"), endMonth: d("2026-03-01") })]
    const rows = evaluateMonths(
      spans,
      used({ "2026-01-01": 6_000n, "2026-02-01": 15_000n, "2026-03-01": 0n }),
      d("2026-06-15"),
    )
    expect(rows.map((r) => r.month)).toEqual(["2026-01-01", "2026-02-01", "2026-03-01"])
    const [jan, feb, mar] = rows
    expect(jan).toMatchObject({ budgetId: "A", capPaise: 10_000n, carryPaise: 0n, availablePaise: 10_000n, remainingPaise: 4_000n, status: "ON_TRACK" })
    expect(feb).toMatchObject({ carryPaise: 4_000n, availablePaise: 14_000n, usedPaise: 15_000n, remainingPaise: -1_000n, status: "OVER" })
    expect(mar).toMatchObject({ carryPaise: 0n, availablePaise: 10_000n })
  })

  it("resets the carry across a gap month between two spans", () => {
    const spans = [
      span({ id: "A", startMonth: d("2026-01-01"), endMonth: d("2026-01-01") }),
      span({ id: "B", startMonth: d("2026-03-01"), endMonth: null }),
    ]
    const rows = evaluateMonths(spans, used({ "2026-01-01": 1_000n }), d("2026-03-20"))
    expect(rows.map((r) => r.month)).toEqual(["2026-01-01", "2026-03-01"])
    expect(rows[1]).toMatchObject({ budgetId: "B", carryPaise: 0n, availablePaise: 10_000n })
  })

  it("gives carry 0 to a rollover-off span after a rollover-on span", () => {
    const spans = [
      span({ id: "A", startMonth: d("2026-01-01"), endMonth: d("2026-01-01"), rollover: true }),
      span({ id: "B", startMonth: d("2026-02-01"), rollover: false }),
    ]
    const rows = evaluateMonths(spans, used({ "2026-01-01": 1_000n }), d("2026-02-10"))
    expect(rows[1]).toMatchObject({ carryPaise: 0n, availablePaise: 10_000n })
  })

  it("gives carry 0 to a rollover-on span after a rollover-off span", () => {
    const spans = [
      span({ id: "A", startMonth: d("2026-01-01"), endMonth: d("2026-01-01"), rollover: false }),
      span({ id: "B", startMonth: d("2026-02-01"), rollover: true }),
    ]
    const rows = evaluateMonths(spans, used({ "2026-01-01": 1_000n }), d("2026-02-10"))
    expect(rows[1].carryPaise).toBe(0n)
  })

  it("chains rollover across adjacent spans, so the new span inherits the old span's leftover", () => {
    // Jan leaves 6_000; Feb has 16_000 available and spends nothing, so March opens with 16_000 carried onto its own 12_000.
    const spans = [
      span({ id: "A", startMonth: d("2026-01-01"), endMonth: d("2026-02-01") }),
      span({ id: "B", startMonth: d("2026-03-01"), amountPaise: paise(12_000n) }),
    ]
    const rows = evaluateMonths(spans, used({ "2026-01-01": 4_000n }), d("2026-03-05"))
    expect(rows[1]).toMatchObject({ month: "2026-02-01", carryPaise: 6_000n, availablePaise: 16_000n })
    expect(rows[2]).toMatchObject({ month: "2026-03-01", carryPaise: 16_000n, availablePaise: 28_000n })
  })

  it("treats a net-refund month as ON_TRACK with no percent, and carries available plus the refund", () => {
    const spans = [span({ startMonth: d("2026-01-01") })]
    const rows = evaluateMonths(spans, used({ "2026-01-01": -500n }), d("2026-02-10"))
    expect(rows[0]).toMatchObject({ usedPaise: -500n, remainingPaise: 10_500n, status: "ON_TRACK", percentTenths: null })
    expect(rows[1].carryPaise).toBe(10_500n)
  })

  it("ends at the current month, which is last, and treats a missing month as spent nothing", () => {
    const spans = [span({ startMonth: d("2026-01-01") })]
    const rows = evaluateMonths(spans, used({}), d("2026-03-31"))
    expect(rows.map((r) => r.month)).toEqual(["2026-01-01", "2026-02-01", "2026-03-01"])
    expect(rows.every((r) => r.usedPaise === 0n)).toBe(true)
    expect(rows[2].carryPaise).toBe(20_000n)
  })

  it("stops a span at its end month even when today is later", () => {
    const spans = [span({ startMonth: d("2026-01-01"), endMonth: d("2026-02-01") })]
    const rows = evaluateMonths(spans, used({}), d("2026-09-01"))
    expect(rows.map((r) => r.month)).toEqual(["2026-01-01", "2026-02-01"])
  })

  it("lists spans given out of order, ascending by month", () => {
    const spans = [
      span({ id: "B", startMonth: d("2026-03-01") }),
      span({ id: "A", startMonth: d("2026-01-01"), endMonth: d("2026-02-01") }),
    ]
    const rows = evaluateMonths(spans, used({}), d("2026-03-10"))
    expect(rows.map((r) => [r.month, r.budgetId])).toEqual([
      ["2026-01-01", "A"],
      ["2026-02-01", "A"],
      ["2026-03-01", "B"],
    ])
  })

  it("projects the current month only, and flags a pace above what is available", () => {
    const spans = [span({ startMonth: d("2026-10-01"), rollover: false })]
    const rows = evaluateMonths(spans, used({ "2026-10-01": 9_000n, "2026-11-01": 4_000n }), d("2026-11-10"))
    expect(rows[0]).toMatchObject({ projectionPaise: null, overAtPace: false })
    // 4_000 over 10 days of a 30-day month is 12_000 against 10_000 available.
    expect(rows[1]).toMatchObject({ projectionPaise: 12_000n, overAtPace: true, status: "ON_TRACK" })
  })

  it("does not flag a pace that lands exactly on what is available", () => {
    const spans = [span({ startMonth: d("2026-11-01"), rollover: false })]
    const rows = evaluateMonths(spans, used({ "2026-11-01": 3_333n }), d("2026-11-10"))
    expect(rows[0].projectionPaise).toBe(9_999n)
    expect(rows[0].overAtPace).toBe(false)
  })

  it("reports the percent and status of each month", () => {
    const spans = [span({ startMonth: d("2026-01-01"), rollover: false })]
    const rows = evaluateMonths(spans, used({ "2026-01-01": 8_000n, "2026-02-01": 10_001n }), d("2026-02-03"))
    expect(rows[0]).toMatchObject({ percentTenths: 800n, status: "NEAR" })
    expect(rows[1]).toMatchObject({ percentTenths: 1000n, status: "OVER" })
  })
})
