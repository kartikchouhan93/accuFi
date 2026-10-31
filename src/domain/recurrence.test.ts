import { describe, expect, it } from "vitest"
import { calendarDate } from "./calendar-date"
import {
  INTERVAL_MAX,
  OCCURRENCE_LIMIT_MAX,
  datesDue,
  datesFromAnchor,
  firstDue,
  normaliseSchedule,
  scheduleViolations,
  type Schedule,
} from "./recurrence"

// Runs under both test timezones (scripts/test-tz.sh): the schedule maths is UTC-only, so the DST cases
// below must give the same answer in Kolkata and New York.

const d = calendarDate

function schedule(overrides: Partial<Schedule> & Pick<Schedule, "frequency" | "startDate">): Schedule {
  return normaliseSchedule({ interval: 1, endDate: null, occurrenceLimit: null, ...overrides })
}

const due = (s: Schedule, upTo: string, from = s.startDate, count = 0) =>
  datesDue(s, { from, count, upTo: d(upTo), max: 1000 })

describe("MONTHLY", () => {
  it("keeps day 31 as the last day of each month, with no drift after February", () => {
    const s = schedule({ frequency: "MONTHLY", dayOfMonth: 31, startDate: d("2026-01-31") })
    expect(due(s, "2026-05-31")).toEqual(["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30", "2026-05-31"])
  })

  it("uses 29 February in a leap year and goes back to the 31st", () => {
    const s = schedule({ frequency: "MONTHLY", dayOfMonth: 31, startDate: d("2028-01-31") })
    expect(due(s, "2028-03-31").slice(1)).toEqual(["2028-02-29", "2028-03-31"])
  })

  it("skips the grid date before the start date", () => {
    const s = schedule({ frequency: "MONTHLY", dayOfMonth: 5, startDate: d("2026-01-20") })
    expect(due(s, "2026-04-30")).toEqual(["2026-02-05", "2026-03-05", "2026-04-05"])
  })

  it("steps by the interval", () => {
    const s = schedule({ frequency: "MONTHLY", interval: 2, dayOfMonth: 10, startDate: d("2026-11-10") })
    expect(due(s, "2027-03-31")).toEqual(["2026-11-10", "2027-01-10", "2027-03-10"])
  })
})

describe("QUARTERLY", () => {
  it("steps three months", () => {
    const s = schedule({ frequency: "QUARTERLY", dayOfMonth: 15, startDate: d("2026-01-15") })
    expect(due(s, "2026-12-31")).toEqual(["2026-01-15", "2026-04-15", "2026-07-15", "2026-10-15"])
  })

  it("multiplies the step by the interval", () => {
    const s = schedule({ frequency: "QUARTERLY", interval: 2, dayOfMonth: 15, startDate: d("2026-01-15") })
    expect(due(s, "2027-02-01")).toEqual(["2026-01-15", "2026-07-15", "2027-01-15"])
  })
})

describe("YEARLY", () => {
  it("clamps 29 February in non-leap years and returns to it in the next leap year", () => {
    const s = schedule({ frequency: "YEARLY", startDate: d("2024-02-29") })
    expect(due(s, "2028-12-31")).toEqual(["2024-02-29", "2025-02-28", "2026-02-28", "2027-02-28", "2028-02-29"])
  })
})

describe("WEEKLY", () => {
  it("starts on the first matching weekday on or after the start date", () => {
    const s = schedule({ frequency: "WEEKLY", dayOfWeek: 1, startDate: d("2026-10-28") })
    expect(due(s, "2026-11-15")).toEqual(["2026-11-02", "2026-11-09"])
  })

  it("steps by the interval in weeks", () => {
    const s = schedule({ frequency: "WEEKLY", interval: 2, dayOfWeek: 1, startDate: d("2026-10-28") })
    expect(due(s, "2026-11-30")).toEqual(["2026-11-02", "2026-11-16", "2026-11-30"])
  })

  it("includes the start date when it already has the weekday", () => {
    const s = schedule({ frequency: "WEEKLY", dayOfWeek: 3, startDate: d("2026-10-28") })
    expect(due(s, "2026-11-04")).toEqual(["2026-10-28", "2026-11-04"])
  })
})

describe("DAILY", () => {
  it("steps by the interval across a year end", () => {
    const s = schedule({ frequency: "DAILY", interval: 3, startDate: d("2026-12-30") })
    expect(due(s, "2027-01-05")).toEqual(["2026-12-30", "2027-01-02", "2027-01-05"])
  })

  // EC-41: a daylight-saving change must not skip or double a day. The US change is in March, the
  // European one in October; both are covered, and the suite runs in a zone with DST (New York).
  it("gives five consecutive days across the US spring change", () => {
    const s = schedule({ frequency: "DAILY", startDate: d("2026-03-06") })
    expect(due(s, "2026-03-10")).toEqual(["2026-03-06", "2026-03-07", "2026-03-08", "2026-03-09", "2026-03-10"])
  })

  it("gives five consecutive days across the clock change in autumn", () => {
    const s = schedule({ frequency: "DAILY", startDate: d("2026-10-30") })
    expect(due(s, "2026-11-03")).toEqual(["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02", "2026-11-03"])
  })
})

describe("ending", () => {
  it("includes the end date and stops there", () => {
    const s = schedule({
      frequency: "MONTHLY",
      dayOfMonth: 31,
      startDate: d("2026-01-31"),
      endDate: d("2026-03-31"),
    })
    expect(datesDue(s, { from: s.startDate, count: 0, max: 1000 })).toEqual(["2026-01-31", "2026-02-28", "2026-03-31"])
  })

  it("gives nothing when the start is after the end", () => {
    const s = schedule({ frequency: "DAILY", startDate: d("2026-05-02"), endDate: d("2026-05-01") })
    expect(datesDue(s, { from: s.startDate, count: 0, max: 1000 })).toEqual([])
  })

  it("stops at the occurrence limit, counting occurrences the rule already has", () => {
    const s = schedule({ frequency: "DAILY", startDate: d("2026-05-01"), occurrenceLimit: 2 })
    const run = (count: number) => datesDue(s, { from: s.startDate, count, max: 1000 })
    expect(run(0)).toEqual(["2026-05-01", "2026-05-02"])
    expect(run(1)).toEqual(["2026-05-01"])
    expect(run(2)).toEqual([])
  })
})

describe("the window", () => {
  const s = schedule({ frequency: "MONTHLY", dayOfMonth: 31, startDate: d("2026-01-31") })

  it("treats from as inclusive", () => {
    expect(datesDue(s, { from: d("2026-03-31"), count: 0, upTo: d("2026-04-30"), max: 10 })).toEqual([
      "2026-03-31",
      "2026-04-30",
    ])
  })

  it("starts at the next grid date when from falls between two", () => {
    expect(datesDue(s, { from: d("2026-03-01"), count: 0, upTo: d("2026-04-30"), max: 10 })[0]).toBe("2026-03-31")
  })

  it("never reaches before the start date", () => {
    const early = datesDue(s, { from: d("2025-06-01"), count: 0, upTo: d("2026-03-31"), max: 10 })
    expect(early).toEqual(due(s, "2026-03-31"))
  })

  it("truncates at max", () => {
    expect(datesDue(s, { from: s.startDate, count: 0, max: 3 })).toEqual(["2026-01-31", "2026-02-28", "2026-03-31"])
  })

  it("truncates at upTo, inclusive", () => {
    expect(datesDue(s, { from: s.startDate, count: 0, upTo: d("2026-02-28"), max: 10 })).toEqual([
      "2026-01-31",
      "2026-02-28",
    ])
  })

  it("terminates at max with no upTo and no end", () => {
    const open = schedule({ frequency: "DAILY", startDate: d("2026-01-01") })
    expect(datesDue(open, { from: open.startDate, count: 0, max: 100 })).toHaveLength(100)
  })

  it("returns nothing for a max of zero", () => {
    expect(datesDue(s, { from: s.startDate, count: 0, max: 0 })).toEqual([])
  })
})

describe("firstDue", () => {
  it("is the first scheduled date", () => {
    const s = schedule({ frequency: "MONTHLY", dayOfMonth: 5, startDate: d("2026-01-20") })
    expect(firstDue(s)).toBe("2026-02-05")
  })

  it("is null when the rule is already finished or never fires", () => {
    const limited = schedule({ frequency: "DAILY", startDate: d("2026-05-01"), occurrenceLimit: 1 })
    expect(firstDue(limited, 1)).toBeNull()
    const backwards = schedule({ frequency: "DAILY", startDate: d("2026-05-02"), endDate: d("2026-05-01") })
    expect(firstDue(backwards)).toBeNull()
  })
})

describe("datesFromAnchor", () => {
  // Every 2 days from 1 April: 1, 3, ... 29 April. Saving from the 29th, which the rule already has an entry for.
  const s = schedule({ frequency: "DAILY", interval: 2, startDate: d("2026-04-29"), endDate: d("2026-05-08") })

  it("is the schedule's own dates from the anchor when the rule has nothing on it", () => {
    expect(datesFromAnchor(s, { count: 15, lastDueOn: null, max: 10 })).toEqual(["2026-04-29", "2026-05-01", "2026-05-03", "2026-05-05", "2026-05-07"])
    expect(datesFromAnchor(s, { count: 15, lastDueOn: d("2026-04-27"), max: 10 })).toEqual(["2026-04-29", "2026-05-01", "2026-05-03", "2026-05-05", "2026-05-07"])
  })

  it("skips the anchor when it is the rule's last entry: that day has its entry already", () => {
    expect(datesFromAnchor(s, { count: 15, lastDueOn: d("2026-04-29"), max: 10 })).toEqual(["2026-05-01", "2026-05-03", "2026-05-05", "2026-05-07"])
    expect(datesFromAnchor(s, { count: 15, lastDueOn: d("2026-04-29"), upTo: d("2026-05-03"), max: 10 })).toEqual(["2026-05-01", "2026-05-03"])
  })

  it("spends an occurrence limit on the entry the anchor day already has only once", () => {
    // Monthly on the 1st, limit 5 with 3 made (the last on 1 March): two more are left, 1 April and 1 May.
    const limited = schedule({ frequency: "MONTHLY", dayOfMonth: 1, startDate: d("2026-03-01"), occurrenceLimit: 5 })
    expect(datesFromAnchor(limited, { count: 3, lastDueOn: d("2026-03-01"), max: 10 })).toEqual(["2026-04-01", "2026-05-01"])
    expect(datesFromAnchor(limited, { count: 3, lastDueOn: null, max: 10 })).toEqual(["2026-03-01", "2026-04-01"])
  })

  it("is empty when nothing is left after the anchor", () => {
    const ended = schedule({ frequency: "DAILY", interval: 2, startDate: d("2026-04-29"), endDate: d("2026-04-30") })
    expect(datesFromAnchor(ended, { count: 15, lastDueOn: d("2026-04-29"), max: 1 })).toEqual([])
  })
})

describe("normaliseSchedule", () => {
  const base = { interval: 1, endDate: null, occurrenceLimit: null }

  it("defaults a weekly rule to the weekday of the start date", () => {
    const s = normaliseSchedule({ ...base, frequency: "WEEKLY", startDate: d("2026-10-28") })
    expect(s.dayOfWeek).toBe(3)
    expect(s.dayOfMonth).toBeNull()
  })

  it("defaults a monthly, quarterly or yearly rule to the day of the start date", () => {
    const yearly = normaliseSchedule({ ...base, frequency: "YEARLY", startDate: d("2024-02-29") })
    expect(yearly.dayOfMonth).toBe(29)
    expect(yearly.dayOfWeek).toBeNull()
    for (const frequency of ["MONTHLY", "QUARTERLY"] as const) {
      const s = normaliseSchedule({ ...base, frequency, startDate: d("2026-03-17") })
      expect(s.dayOfMonth).toBe(17)
      expect(s.dayOfWeek).toBeNull()
    }
  })

  it("keeps a given value and drops the one the frequency does not use", () => {
    const weekly = normaliseSchedule({ ...base, frequency: "WEEKLY", startDate: d("2026-10-28"), dayOfWeek: 5, dayOfMonth: 9 })
    expect(weekly).toMatchObject({ dayOfWeek: 5, dayOfMonth: null })
    const monthly = normaliseSchedule({ ...base, frequency: "MONTHLY", startDate: d("2026-10-28"), dayOfMonth: 9, dayOfWeek: 2 })
    expect(monthly).toMatchObject({ dayOfMonth: 9, dayOfWeek: null })
  })

  it("clears both for a daily rule", () => {
    const s = normaliseSchedule({ ...base, frequency: "DAILY", startDate: d("2026-10-28"), dayOfMonth: 9, dayOfWeek: 2 })
    expect(s).toMatchObject({ dayOfMonth: null, dayOfWeek: null })
  })
})

describe("scheduleViolations", () => {
  const fields = (s: Schedule) => scheduleViolations(s).map((v) => v.field)

  it("accepts a sound schedule", () => {
    expect(scheduleViolations(schedule({ frequency: "MONTHLY", startDate: d("2026-10-28") }))).toEqual([])
  })

  it("bounds the interval", () => {
    const s = schedule({ frequency: "DAILY", startDate: d("2026-10-28") })
    expect(fields({ ...s, interval: 0 })).toEqual(["interval"])
    expect(fields({ ...s, interval: INTERVAL_MAX + 1 })).toEqual(["interval"])
    expect(fields({ ...s, interval: 1.5 })).toEqual(["interval"])
    expect(fields({ ...s, interval: INTERVAL_MAX })).toEqual([])
  })

  it("bounds the weekday of a weekly rule", () => {
    const s = schedule({ frequency: "WEEKLY", startDate: d("2026-10-28") })
    expect(fields({ ...s, dayOfWeek: 0 })).toEqual(["dayOfWeek"])
    expect(fields({ ...s, dayOfWeek: 8 })).toEqual(["dayOfWeek"])
    expect(fields({ ...s, dayOfWeek: null })).toEqual(["dayOfWeek"])
    expect(fields({ ...s, dayOfWeek: 7 })).toEqual([])
  })

  it("bounds the day of the month where it is used", () => {
    for (const frequency of ["MONTHLY", "QUARTERLY", "YEARLY"] as const) {
      const s = schedule({ frequency, startDate: d("2026-10-28") })
      expect(fields({ ...s, dayOfMonth: 0 }), frequency).toEqual(["dayOfMonth"])
      expect(fields({ ...s, dayOfMonth: 32 }), frequency).toEqual(["dayOfMonth"])
      expect(fields({ ...s, dayOfMonth: null }), frequency).toEqual(["dayOfMonth"])
      expect(fields({ ...s, dayOfMonth: 31 }), frequency).toEqual([])
    }
  })

  it("rejects an end date before the start date but allows the same day", () => {
    const s = schedule({ frequency: "DAILY", startDate: d("2026-10-28") })
    expect(fields({ ...s, endDate: d("2026-10-27") })).toEqual(["endDate"])
    expect(fields({ ...s, endDate: d("2026-10-28") })).toEqual([])
  })

  it("bounds the occurrence limit", () => {
    const s = schedule({ frequency: "DAILY", startDate: d("2026-10-28") })
    expect(fields({ ...s, occurrenceLimit: 0 })).toEqual(["occurrenceLimit"])
    expect(fields({ ...s, occurrenceLimit: OCCURRENCE_LIMIT_MAX + 1 })).toEqual(["occurrenceLimit"])
    expect(fields({ ...s, occurrenceLimit: OCCURRENCE_LIMIT_MAX })).toEqual([])
  })

  it("gives each violation a user-facing message", () => {
    const s = schedule({ frequency: "DAILY", startDate: d("2026-10-28") })
    const [violation] = scheduleViolations({ ...s, interval: 0 })
    expect(violation.message).toMatch(/1 and 99/)
  })
})
