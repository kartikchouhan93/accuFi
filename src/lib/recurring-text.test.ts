import { describe, expect, it } from "vitest"
import { calendarDate } from "../domain/calendar-date"
import type { Schedule } from "../domain/recurrence"
import { describeSchedule, nextDatesPreview } from "./recurring-text"

const schedule = (over: Partial<Schedule>): Schedule => ({
  frequency: "MONTHLY",
  interval: 1,
  dayOfMonth: null,
  dayOfWeek: null,
  startDate: calendarDate("2026-01-15"),
  endDate: null,
  occurrenceLimit: null,
  ...over,
})

describe("describeSchedule", () => {
  it("says the last day for a day that some months do not have", () => {
    expect(describeSchedule(schedule({ dayOfMonth: 31 }))).toBe("Monthly on the 31st, or the last day")
    expect(describeSchedule(schedule({ dayOfMonth: 30 }))).toBe("Monthly on the 30th, or the last day")
    expect(describeSchedule(schedule({ dayOfMonth: 28 }))).toBe("Monthly on the 28th")
  })

  it("counts weeks, months and days, and names the weekday", () => {
    expect(describeSchedule(schedule({ frequency: "WEEKLY", interval: 2, dayOfWeek: 1 }))).toBe("Every 2 weeks on Monday")
    expect(describeSchedule(schedule({ frequency: "WEEKLY", interval: 1, dayOfWeek: 7 }))).toBe("Weekly on Sunday")
    expect(describeSchedule(schedule({ interval: 3, dayOfMonth: 15 }))).toBe("Every 3 months on the 15th")
    expect(describeSchedule(schedule({ frequency: "QUARTERLY", interval: 1, dayOfMonth: 15 }))).toBe("Every 3 months on the 15th")
    expect(describeSchedule(schedule({ frequency: "QUARTERLY", interval: 2, dayOfMonth: 2 }))).toBe("Every 6 months on the 2nd")
    expect(describeSchedule(schedule({ frequency: "DAILY" }))).toBe("Every day")
    expect(describeSchedule(schedule({ frequency: "DAILY", interval: 10 }))).toBe("Every 10 days")
  })

  it("writes the ordinals, including the teens", () => {
    const words = [1, 2, 3, 4, 11, 12, 13, 21, 22, 23].map((day) => describeSchedule(schedule({ dayOfMonth: day })))
    expect(words.map((text) => text.replace("Monthly on the ", ""))).toEqual([
      "1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "23rd",
    ])
  })

  it("describes a yearly rule by its month, and the leap day by what it does in other years", () => {
    expect(
      describeSchedule(schedule({ frequency: "YEARLY", dayOfMonth: 29, startDate: calendarDate("2024-02-29") })),
    ).toBe("Yearly on 29 February (28 February in other years)")
    expect(
      describeSchedule(schedule({ frequency: "YEARLY", dayOfMonth: 29, startDate: calendarDate("2026-02-28") })),
    ).toBe("Yearly on 29 February (28 February in other years)")
    expect(describeSchedule(schedule({ frequency: "YEARLY", dayOfMonth: 15, startDate: calendarDate("2026-03-15") }))).toBe("Yearly on 15 March")
    expect(describeSchedule(schedule({ frequency: "YEARLY", interval: 2, dayOfMonth: 15, startDate: calendarDate("2026-03-15") }))).toBe(
      "Every 2 years on 15 March",
    )
    expect(describeSchedule(schedule({ frequency: "YEARLY", dayOfMonth: 31, startDate: calendarDate("2026-04-30") }))).toBe(
      "Yearly on the last day of April",
    )
  })

  it("falls back to the start date's own day or weekday when none is stored, as the schedule does", () => {
    expect(describeSchedule(schedule({ dayOfMonth: null, startDate: calendarDate("2026-01-20") }))).toBe("Monthly on the 20th")
    expect(describeSchedule(schedule({ frequency: "WEEKLY", dayOfWeek: null, startDate: calendarDate("2026-05-19") }))).toBe("Weekly on Tuesday")
  })
})

describe("nextDatesPreview", () => {
  const dates = (values: string[]) => values.map((value) => calendarDate(value))

  it("lists the first dates from the start date", () => {
    expect(nextDatesPreview(schedule({ dayOfMonth: 31, startDate: calendarDate("2026-01-31") }), 0, 4)).toEqual(
      dates(["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"]),
    )
  })

  it("stops at the end date and at what is left of the occurrence limit", () => {
    expect(nextDatesPreview(schedule({ dayOfMonth: 15, endDate: calendarDate("2026-03-20") }), 0, 10)).toEqual(
      dates(["2026-01-15", "2026-02-15", "2026-03-15"]),
    )
    expect(nextDatesPreview(schedule({ dayOfMonth: 15, occurrenceLimit: 3 }), 2, 10)).toEqual(dates(["2026-01-15"]))
    expect(nextDatesPreview(schedule({ dayOfMonth: 15, occurrenceLimit: 3 }), 3, 10)).toEqual([])
  })

  it("is empty for a count of zero or below", () => {
    expect(nextDatesPreview(schedule({ dayOfMonth: 15 }), 0, 0)).toEqual([])
  })

  it("starts after the start date when that is the day of the rule's last entry, as a save from it does", () => {
    const from = schedule({ dayOfMonth: 1, startDate: calendarDate("2026-03-01"), occurrenceLimit: 5 })
    expect(nextDatesPreview(from, 3, 3, calendarDate("2026-03-01"))).toEqual(dates(["2026-04-01", "2026-05-01"]))
    expect(nextDatesPreview(from, 3, 3, calendarDate("2026-02-01"))).toEqual(dates(["2026-03-01", "2026-04-01"]))
  })
})
