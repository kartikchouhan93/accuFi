import { afterEach, describe, expect, it, vi } from "vitest"
import {
  CalendarDateError,
  calendarDate,
  compareDates,
  financialYearRange,
  fromDbDate,
  monthRange,
  toDbDate,
  todayIn,
} from "./calendar-date"

// The `test` script runs this file with TZ=Asia/Kolkata and again with TZ=America/New_York. The two
// round-trip tests below are only meaningful under those zones: a local-time read of a UTC-midnight
// Date is correct in Kolkata (UTC+5:30) and a day early in New York (UTC-4/-5), while a local-time
// build in toDbDate is a day early in Kolkata.
describe("CalendarDate <-> database Date", () => {
  it("round-trips through the database representation without shifting", () => {
    const d = calendarDate("2026-04-01")
    expect(fromDbDate(toDbDate(d))).toBe("2026-04-01")
  })

  it("round-trips correctly when the process runs in Asia/Kolkata", () => {
    // a UTC-midnight Date is 05:30 local on the SAME day
    expect(fromDbDate(new Date("2026-04-01T00:00:00.000Z"))).toBe("2026-04-01")
  })

  it("round-trips correctly when the process runs west of UTC", () => {
    // UTC midnight is 20:00 the PREVIOUS day in America/New_York
    expect(fromDbDate(new Date("2026-04-01T00:00:00.000Z"))).toBe("2026-04-01")
  })

  it("builds the database Date at UTC midnight regardless of process timezone", () => {
    expect(toDbDate(calendarDate("2026-04-01")).toISOString()).toBe("2026-04-01T00:00:00.000Z")
    expect(toDbDate(calendarDate("2026-12-31")).toISOString()).toBe("2026-12-31T00:00:00.000Z")
  })

  it("ignores the time of day when reading a Date, using only its UTC date", () => {
    expect(fromDbDate(new Date("2026-04-01T23:59:59.999Z"))).toBe("2026-04-01")
  })

  it("rejects an invalid Date", () => {
    expect(() => fromDbDate(new Date("nope"))).toThrow(CalendarDateError)
  })
})

describe("calendarDate", () => {
  it("accepts real dates, including a leap day", () => {
    expect(calendarDate("2028-02-29")).toBe("2028-02-29")
    expect(calendarDate("2026-12-31")).toBe("2026-12-31")
  })

  it("rejects malformed and impossible dates", () => {
    expect(() => calendarDate("01-04-2026")).toThrow()
    expect(() => calendarDate("2026-02-30")).toThrow()
  })

  it("throws CalendarDateError for every kind of bad input", () => {
    const bad = [
      "",
      " 2026-04-01",
      "2026-04-01 ",
      "2026-4-1",
      "2026/04/01",
      "2026-04-01T00:00:00Z",
      "2026-13-01",
      "2026-00-10",
      "2026-04-00",
      "2026-04-31",
      "2027-02-29", // not a leap year
      "1900-02-29", // century non-leap
      "0099-01-01", // Date.UTC would silently map this to 1999
    ]
    for (const value of bad) {
      expect(() => calendarDate(value), JSON.stringify(value)).toThrow(CalendarDateError)
    }
  })
})

describe("compareDates", () => {
  it("orders chronologically", () => {
    const a = calendarDate("2026-03-31")
    const b = calendarDate("2026-04-01")
    expect(compareDates(a, b)).toBeLessThan(0)
    expect(compareDates(b, a)).toBeGreaterThan(0)
    expect(compareDates(a, a)).toBe(0)
  })

  it("sorts across month and year boundaries", () => {
    const dates = ["2027-01-01", "2026-12-31", "2026-02-01", "2026-10-01"].map(calendarDate)
    expect([...dates].sort(compareDates)).toEqual(["2026-02-01", "2026-10-01", "2026-12-31", "2027-01-01"])
  })
})

describe("todayIn", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("returns the calendar date in the requested zone, not the process zone", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-04-01T20:00:00.000Z"))
    expect(todayIn("Asia/Kolkata")).toBe("2026-04-02") // 01:30 next day
    expect(todayIn("UTC")).toBe("2026-04-01")
    expect(todayIn("America/New_York")).toBe("2026-04-01") // 16:00
    expect(todayIn("Pacific/Kiritimati")).toBe("2026-04-02") // UTC+14
    expect(todayIn("Pacific/Pago_Pago")).toBe("2026-04-01") // UTC-11
  })

  it("follows daylight saving time rather than a fixed offset", () => {
    vi.useFakeTimers()
    // 04:30Z is 23:30 the previous evening in winter (UTC-5) but 00:30 the same day in summer (UTC-4)
    vi.setSystemTime(new Date("2026-01-15T04:30:00.000Z"))
    expect(todayIn("America/New_York")).toBe("2026-01-14")
    vi.setSystemTime(new Date("2026-07-15T04:30:00.000Z"))
    expect(todayIn("America/New_York")).toBe("2026-07-15")
  })

  it("rolls over at local midnight in Kolkata", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-04-01T18:29:59.000Z")) // 23:59:59 IST
    expect(todayIn("Asia/Kolkata")).toBe("2026-04-01")
    vi.setSystemTime(new Date("2026-04-01T18:30:00.000Z")) // 00:00:00 IST
    expect(todayIn("Asia/Kolkata")).toBe("2026-04-02")
  })

  it("rejects an unknown timezone", () => {
    expect(() => todayIn("Not/AZone")).toThrow()
  })
})

describe("monthRange", () => {
  it("clamps a month range to the real last day", () => {
    expect(monthRange(2027, 2).end).toBe("2027-02-28")
    expect(monthRange(2028, 2).end).toBe("2028-02-29")
  })

  it("handles century leap rules", () => {
    expect(monthRange(1900, 2).end).toBe("1900-02-28")
    expect(monthRange(2000, 2).end).toBe("2000-02-29")
  })

  it("covers 30- and 31-day months and both ends of the year", () => {
    expect(monthRange(2026, 1)).toEqual({ start: "2026-01-01", end: "2026-01-31" })
    expect(monthRange(2026, 4)).toEqual({ start: "2026-04-01", end: "2026-04-30" })
    expect(monthRange(2026, 12)).toEqual({ start: "2026-12-01", end: "2026-12-31" })
  })

  it("rejects an out-of-range or non-integer month", () => {
    for (const month of [0, 13, -1, 1.5, Number.NaN]) {
      expect(() => monthRange(2026, month), String(month)).toThrow(CalendarDateError)
    }
  })
})

describe("financialYearRange", () => {
  it("computes the Indian financial year from any date within it", () => {
    expect(financialYearRange(calendarDate("2026-01-15"), 4)).toEqual({ start: "2025-04-01", end: "2026-03-31" })
    expect(financialYearRange(calendarDate("2026-05-15"), 4)).toEqual({ start: "2026-04-01", end: "2027-03-31" })
  })

  it("defaults to an April start", () => {
    expect(financialYearRange(calendarDate("2026-05-15"))).toEqual({ start: "2026-04-01", end: "2027-03-31" })
  })

  it("treats the first and last day of the year as inside it", () => {
    expect(financialYearRange(calendarDate("2026-04-01"), 4)).toEqual({ start: "2026-04-01", end: "2027-03-31" })
    expect(financialYearRange(calendarDate("2026-03-31"), 4)).toEqual({ start: "2025-04-01", end: "2026-03-31" })
  })

  it("supports a calendar-year start", () => {
    expect(financialYearRange(calendarDate("2026-06-15"), 1)).toEqual({ start: "2026-01-01", end: "2026-12-31" })
  })

  it("supports other start months, clamping the end to the real last day", () => {
    // start in March: the year ends on the last day of February, which is a leap day in 2028
    expect(financialYearRange(calendarDate("2027-06-01"), 3)).toEqual({ start: "2027-03-01", end: "2028-02-29" })
    expect(financialYearRange(calendarDate("2027-06-01"), 10)).toEqual({ start: "2026-10-01", end: "2027-09-30" })
  })

  it("rejects an invalid start month", () => {
    for (const month of [0, 13, 1.5]) {
      expect(() => financialYearRange(calendarDate("2026-05-15"), month), String(month)).toThrow(CalendarDateError)
    }
  })
})
