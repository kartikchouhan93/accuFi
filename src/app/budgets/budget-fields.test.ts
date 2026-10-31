import { describe, expect, it } from "vitest"
import { calendarDate } from "@/domain/calendar-date"
import type { BudgetSettingsView } from "@/lib/budget-view"
import {
  appliesFromOptions,
  blankValues,
  describeFailure,
  describeRevision,
  endMonthOptions,
  fitAppliesFrom,
  landingMonth,
  monthOptions,
  monthText,
  monthValue,
  revisionLines,
  sectionDiffers,
  startMonthOptions,
  unsavedSentence,
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

  it("lists an end month the budget has even when it is before the start, so the select can show what will be refused", () => {
    expect(endMonthOptions("2026-11", "2026-06", TODAY)[0].value).toBe("2026-06")
    expect(endMonthOptions("2026-11", "", TODAY)[0].value).toBe("2026-11")
  })

  it("offers an applies-from from the start month to this month", () => {
    expect(appliesFromOptions("2026-09", TODAY).map((option) => option.value)).toEqual(["2026-09", "2026-10", "2026-11"])
  })

  it("offers a budget that has not started yet this month alone, which corrects it in place", () => {
    expect(appliesFromOptions("2027-02", TODAY).map((option) => option.value)).toEqual(["2026-11"])
  })

  it("stops an ended budget's applies-from at its end month: never a month it no longer applies to", () => {
    expect(appliesFromOptions("2026-04", TODAY, "2026-07").map((option) => option.value)).toEqual(["2026-04", "2026-05", "2026-06", "2026-07"])
    expect(appliesFromOptions("2026-04", TODAY, "2026-04").map((option) => option.value)).toEqual(["2026-04"])
    expect(appliesFromOptions("2026-04", TODAY, "2026-11").at(-1)?.value).toBe("2026-11") // ends this month: this month is the last
  })

  it("does not cut off a budget that ends after this month, or one with no end", () => {
    expect(appliesFromOptions("2026-09", TODAY, "2027-03").map((option) => option.value)).toEqual(["2026-09", "2026-10", "2026-11"])
    expect(appliesFromOptions("2026-09", TODAY, null).map((option) => option.value)).toEqual(["2026-09", "2026-10", "2026-11"])
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

  it("opens an ended budget's applies-from on the earlier of this month and its end, so the page does not open on a refusal", () => {
    expect(valuesOfBudget(view({ endMonth: "2026-07-01" }), TODAY).appliesFrom).toBe("2026-07")
    expect(valuesOfBudget(view({ startMonth: "2026-04-01", endMonth: "2026-04-01" }), TODAY).appliesFrom).toBe("2026-04")
    expect(valuesOfBudget(view({ endMonth: "2026-11-01" }), TODAY).appliesFrom).toBe("2026-11")
    expect(valuesOfBudget(view({ endMonth: "2027-03-01" }), TODAY).appliesFrom).toBe("2026-11")
  })

  it("never opens on a month the options do not offer, for any budget", () => {
    for (const [startMonth, endMonth] of [
      ["2026-04-01", null],
      ["2026-04-01", "2026-06-01"],
      ["2026-11-01", null],
      ["2027-02-01", null],
      ["2027-02-01", "2027-05-01"],
      ["2026-04-01", "2027-05-01"],
    ] as const) {
      const budget = view({ startMonth, endMonth })
      const offered = appliesFromOptions(monthValue(startMonth), TODAY, endMonth === null ? null : monthValue(endMonth)).map((option) => option.value)
      expect(offered, `${startMonth} ${endMonth}`).toContain(valuesOfBudget(budget, TODAY).appliesFrom)
    }
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

describe("whether a section differs from the budget as stored", () => {
  const stored = view({ endMonth: "2027-03-01", rollover: true })
  const same = valuesOfBudget(stored, TODAY)

  it("is false for both sections on a form that is as the budget is", () => {
    expect(sectionDiffers("amount", same, stored)).toBe(false)
    expect(sectionDiffers("settings", same, stored)).toBe(false)
  })

  it("compares the amount as money, not as text: 12345, 12,345.00 and 12345.0 are the stored 12345.00", () => {
    for (const amount of ["12345", "12,345.00", "12345.0", " 12345.00 "]) expect(sectionDiffers("amount", { ...same, amount }, stored), amount).toBe(false)
  })

  it("is true for another amount, a blank one and one that is not an amount", () => {
    for (const amount of ["12345.01", "9000", "", "abc", "12345.001"]) expect(sectionDiffers("amount", { ...same, amount }, stored), amount).toBe(true)
  })

  it("does not count the month a new amount applies from: choosing it alone changes nothing to save", () => {
    expect(sectionDiffers("amount", { ...same, appliesFrom: "2026-05" }, stored)).toBe(false)
  })

  it("is true for another end month, a removed one and a toggled rollover, and false for the other section's change", () => {
    expect(sectionDiffers("settings", { ...same, endMonth: "2027-04" }, stored)).toBe(true)
    expect(sectionDiffers("settings", { ...same, endMonth: "" }, stored)).toBe(true)
    expect(sectionDiffers("settings", { ...same, rollover: false }, stored)).toBe(true)
    expect(sectionDiffers("settings", { ...same, amount: "1" }, stored)).toBe(false)
    expect(sectionDiffers("amount", { ...same, rollover: false, endMonth: "" }, stored)).toBe(false)
  })

  it("treats no end as no end", () => {
    const open = view()
    expect(sectionDiffers("settings", valuesOfBudget(open, TODAY), open)).toBe(false)
    expect(sectionDiffers("settings", { ...valuesOfBudget(open, TODAY), endMonth: "2027-01" }, open)).toBe(true)
  })
})

describe("the sentence for what a save leaves unsaved", () => {
  const stored = view()
  const same = valuesOfBudget(stored, TODAY)

  it("names the settings when the amount is saved and the settings were changed", () => {
    expect(unsavedSentence("amount", { ...same, rollover: true }, stored)).toBe("Your change to the settings was not saved.")
    expect(unsavedSentence("amount", { ...same, endMonth: "2027-01" }, stored)).toBe("Your change to the settings was not saved.")
  })

  it("names the amount when the settings are saved and the amount was changed", () => {
    expect(unsavedSentence("settings", { ...same, amount: "9000" }, stored)).toBe("Your change to the amount was not saved.")
  })

  it("is null when the other section is as stored, and never reports the section that was saved", () => {
    expect(unsavedSentence("amount", same, stored)).toBeNull()
    expect(unsavedSentence("settings", same, stored)).toBeNull()
    expect(unsavedSentence("amount", { ...same, amount: "9000" }, stored)).toBeNull()
    expect(unsavedSentence("settings", { ...same, rollover: true }, stored)).toBeNull()
  })
})

describe("what saving the amount says", () => {
  const before = view()

  it("says nothing changed when the amount saved is the one the budget had", () => {
    expect(revisionLines(before, [view()])).toEqual(["Nothing changed."])
  })

  it("says it corrected the whole budget when one budget came back with another amount", () => {
    expect(revisionLines(before, [view({ amountPaise: "800000" })])).toEqual(["Corrected the Groceries budget to ₹8,000.00 for every month of it."])
  })

  it("says it changed the amount from a month, and that earlier months keep the old one, for a split", () => {
    expect(revisionLines(before, [view({ endMonth: "2026-10-01" }), view({ id: "b2", amountPaise: "800000", startMonth: "2026-11-01" })])).toEqual([
      "Changed the Groceries budget to ₹8,000.00 from November 2026.",
      "Earlier months keep the old amount.",
    ])
  })
})

describe("fitAppliesFrom", () => {
  it("keeps a month the budget still offers", () => {
    expect(fitAppliesFrom("2026-06", view(), TODAY)).toBe("2026-06")
    expect(fitAppliesFrom("2026-11", view(), TODAY)).toBe("2026-11")
  })

  it("moves to the month the form would open on when the budget no longer offers it", () => {
    expect(fitAppliesFrom("2026-11", view({ endMonth: "2026-07-01" }), TODAY)).toBe("2026-07") // an end was set before it
    expect(fitAppliesFrom("2026-02", view(), TODAY)).toBe("2026-11") // a split moved the start past it
    expect(fitAppliesFrom("2026-02", view({ startMonth: "2026-08-01" }), TODAY)).toBe("2026-11")
  })
})
