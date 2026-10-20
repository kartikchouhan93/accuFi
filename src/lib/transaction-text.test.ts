import { describe, expect, it } from "vitest"
import { calendarDate } from "../domain/calendar-date"
import { parseRupees } from "../domain/money"
import { describeTally, divideEqually, formatDay, paiseTextToRupees, parseTags, sumPaiseText } from "./transaction-text"

describe("formatDay", () => {
  it("reads the day from the text, so no timezone can move it", () => {
    expect(formatDay(calendarDate("2026-10-20"))).toBe("20 Oct 2026")
    expect(formatDay(calendarDate("2026-01-05"))).toBe("5 Jan 2026")
    expect(formatDay(calendarDate("2024-02-29"))).toBe("29 Feb 2024")
  })
})

describe("divideEqually", () => {
  it("hands the odd paise to the first legs, and the legs add up exactly", () => {
    expect(divideEqually("100", 3)).toEqual(["33.34", "33.33", "33.33"])
    expect(divideEqually("100.01", 3)).toEqual(["33.34", "33.34", "33.33"])
    expect(divideEqually("1,000", 2)).toEqual(["500.00", "500.00"])
  })

  it("always sums to the total, whatever the total and the count", () => {
    for (const total of ["0.01", "0.02", "99.99", "1,23,456.78", "7"]) {
      for (const count of [2, 3, 7, 50]) {
        const legs = divideEqually(total, count)
        expect(legs).toHaveLength(count)
        expect(legs?.reduce((sum, leg) => sum + parseRupees(leg), 0n)).toBe(parseRupees(total))
      }
    }
  })

  it("gives nothing for a total that is not an amount yet", () => {
    for (const total of ["", "abc", "0", "-5", "1.234"]) expect(divideEqually(total, 3)).toBeNull()
  })
})

describe("describeTally", () => {
  it("says what is left, what is over, or that the legs are exact", () => {
    expect(describeTally("100", ["60", "40"])).toBe("Nothing left to assign.")
    expect(describeTally("100", ["60", ""])).toBe("₹40.00 left to assign.")
    expect(describeTally("100", ["60", "50.50"])).toBe("₹10.50 over the total.")
    expect(describeTally("100", ["33.34", "33.33", "33.33"])).toBe("Nothing left to assign.")
  })

  it("is silent until the total is an amount", () => {
    expect(describeTally("", ["10"])).toBeNull()
    expect(describeTally("abc", ["10"])).toBeNull()
  })
})

describe("parseTags", () => {
  it("trims and drops blanks", () => {
    expect(parseTags(" food , trip,, ")).toEqual(["food", "trip"])
    expect(parseTags("")).toEqual([])
  })
})

describe("paiseTextToRupees and sumPaiseText", () => {
  it("round-trip an amount through the text a form field holds", () => {
    expect(paiseTextToRupees("123450")).toBe("1234.50")
    expect(paiseTextToRupees("5")).toBe("0.05")
    expect(parseRupees(paiseTextToRupees("9007199254740993"))).toBe(9_007_199_254_740_993n)
  })

  it("sums without going through a float", () => {
    expect(sumPaiseText(["3334", "3333", "3333"])).toBe("10000")
    expect(sumPaiseText(["9007199254740993", "1"])).toBe("9007199254740994")
    expect(sumPaiseText([])).toBe("0")
  })
})
