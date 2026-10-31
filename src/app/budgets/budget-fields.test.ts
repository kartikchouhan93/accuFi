import { describe, expect, it } from "vitest"
import { calendarDate } from "@/domain/calendar-date"
import type { BudgetSettingsView } from "@/lib/budget-view"
import {
  appliesFromOptions,
  blankValues,
  describeFailure,
  describeRevision,
  endMonthOptions,
  landingMonth,
  monthOptions,
  monthText,
  monthValue,
  startMonthOptions,
  valuesOfBudget,
} from "./budget-fields"

const TODAY = calendarDate("2026-11-15")

const view = (over: Partial<BudgetSettingsView> = {}): BudgetSettingsView => ({
  id: "b1",
  nodeId: "n1",
  nodeName: "Groceries",
  amountPaise: "1234500",
  startMonth: "2026-04-01",
  endMonth: null,
  rollover: false,
  ...over,
})

describe("monthText", () => {
  it("names the month in full", () => {
    expect(monthText("2026-11")).toBe("November 2026")
    expect(monthText("2027-01")).toBe("January 2027")
    expect(monthText("2026-05")).toBe("May 2026")
  })

  it("reads the first-of-month form as well", () => {
    expect(monthText("2026-11-01")).toBe("November 2026")
  })
})

describe("monthValue", () => {
  it("is the YYYY-MM text a month field sends", () => {
    expect(monthValue("2026-11-01")).toBe("2026-11")
    expect(monthValue(TODAY)).toBe("2026-11")
  })
})

describe("monthOptions", () => {
  it("gives a labelled option for each month, first to last", () => {
    expect(monthOptions("2026-09", "2026-11")).toEqual([
      { value: "2026-09", label: "September 2026" },
      { value: "2026-10", label: "October 2026" },
      { value: "2026-11", label: "November 2026" },
    ])
  })

  it("is one option when the months are the same, and none when the range is backwards", () => {
    expect(monthOptions("2026-11", "2026-11")).toEqual([{ value: "2026-11", label: "November 2026" }])
    expect(monthOptions("2026-11", "2026-09")).toEqual([])
  })

  it("crosses a year end", () => {
    expect(monthOptions("2026-12", "2027-01").map((option) => option.value)).toEqual(["2026-12", "2027-01"])
  })
})

describe("describeRevision", () => {
  it("says the earlier months keep the old amount when the month is after the start (a split)", () => {
    expect(describeRevision("2026-04", "2026-11", null)).toBe("Changes the amount from November 2026; earlier months keep the old amount.")
    expect(describeRevision("2026-04", "2026-11", "2027-03")).toBe("Changes the amount from November 2026; earlier months keep the old amount.")
    expect(describeRevision("2026-04", "2027-03", "2027-03")).toBe("Changes the amount from March 2027; earlier months keep the old amount.")
  })

  it("says it corrects every month when the month is the start or earlier", () => {
    expect(describeRevision("2026-04", "2026-04", null)).toBe("Corrects the amount for every month of this budget.")
    expect(describeRevision("2026-04", "2026-01", null)).toBe("Corrects the amount for every month of this budget.")
    expect(describeRevision("2026-04", "2026-04", "2026-06")).toBe("Corrects the amount for every month of this budget.")
  })

  it("refuses a month after the end, naming when the budget ended", () => {
    expect(describeRevision("2026-04", "2026-11", "2026-10")).toBe("This budget ended in October 2026. Pick a month it applies to.")
  })
})

describe("the months a form offers", () => {
  it("offers a new budget a start from three years back to a year ahead of this month", () => {
    const options = startMonthOptions(TODAY)
    expect(options[0].value).toBe("2023-11")
    expect(options.at(-1)?.value).toBe("2027-11")
    expect(options.map((option) => option.value)).toContain("2026-11")
    expect(options).toHaveLength(49)
  })

  it("offers an end from the start month on, and keeps one the budget already has", () => {
    const options = endMonthOptions("2026-04", "2026-06", TODAY)
    expect(options[0].value).toBe("2026-04")
    expect(options.map((option) => option.value)).toContain("2026-06")
    const far = endMonthOptions("2026-04", "2035-01", TODAY)
    expect(far.at(-1)?.value).toBe("2035-01")
  })

  it("offers an applies-from from the start month to this month", () => {
    expect(appliesFromOptions("2026-09", TODAY).map((option) => option.value)).toEqual(["2026-09", "2026-10", "2026-11"])
  })

  it("offers a budget that has not started yet this month alone, which corrects it in place", () => {
    expect(appliesFromOptions("2027-02", TODAY).map((option) => option.value)).toEqual(["2026-11"])
  })
})

describe("the values a form opens with", () => {
  it("starts a new budget blank, from the current month, with no end and no rollover", () => {
    expect(blankValues(TODAY)).toEqual({ nodeId: "", amount: "", startMonth: "2026-11", endMonth: "", rollover: false })
  })

  it("opens an edit from the budget: its amount as rupee text, this month to apply from, its own end and rollover", () => {
    expect(valuesOfBudget(view({ endMonth: "2027-03-01", rollover: true }), TODAY)).toEqual({
      amount: "12345.00",
      appliesFrom: "2026-11",
      endMonth: "2027-03",
      rollover: true,
    })
    expect(valuesOfBudget(view(), TODAY)).toMatchObject({ endMonth: "", rollover: false })
  })
})

describe("landingMonth", () => {
  it("is the current month when the budget covers it", () => {
    expect(landingMonth(view(), TODAY)).toBe("2026-11")
    expect(landingMonth(view({ startMonth: "2026-11-01" }), TODAY)).toBe("2026-11")
    expect(landingMonth(view({ endMonth: "2026-11-01" }), TODAY)).toBe("2026-11")
  })

  it("is the budget's start month when it ended before this month", () => {
    expect(landingMonth(view({ startMonth: "2026-02-01", endMonth: "2026-05-01" }), TODAY)).toBe("2026-02")
  })

  it("is the current month when the budget starts later: the screen has no month for it, and lists it under Upcoming", () => {
    expect(landingMonth(view({ startMonth: "2027-02-01" }), TODAY)).toBe("2026-11")
    expect(landingMonth(view({ startMonth: "2026-12-01" }), TODAY)).toBe("2026-11")
    expect(landingMonth(view({ startMonth: "2026-12-01", endMonth: "2027-03-01" }), TODAY)).toBe("2026-11")
  })
})

describe("describeFailure", () => {
  it("files server field errors under their fields and asks to check them", () => {
    const outcome = describeFailure({
      ok: false,
      error: { code: "invalid", message: "Groceries already has a budget", fieldErrors: { startMonth: ["Overlaps"], endMonth: ["Too early"] } },
    })
    expect(outcome).toEqual({
      fieldErrors: { startMonth: ["Overlaps"], endMonth: ["Too early"] },
      message: "Groceries already has a budget",
      isFieldProblem: true,
    })
  })

  it("says to check the highlighted fields for a schema refusal", () => {
    const outcome = describeFailure({ ok: false, error: { code: "invalid_input", message: "x", fieldErrors: { amount: ["Enter an amount"] } } })
    expect(outcome.message).toBe("Check the highlighted fields.")
    expect(outcome.isFieldProblem).toBe(true)
  })

  it("keeps a refusal without fields (a vanished budget) as a message", () => {
    const outcome = describeFailure({ ok: false, error: { code: "not_found", message: "This budget no longer exists." } })
    expect(outcome).toEqual({ fieldErrors: {}, message: "This budget no longer exists.", isFieldProblem: false })
  })
})
