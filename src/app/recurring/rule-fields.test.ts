import { describe, expect, it } from "vitest"
import { calendarDate } from "@/domain/calendar-date"
import { datesDue, type Schedule } from "@/domain/recurrence"
import type { RuleDraft, RuleView } from "@/lib/recurring-view"
import type { PickerNode } from "@/lib/transaction-list-view"
import {
  autoPostOffered,
  blankValues,
  dayControlOf,
  endsBeforeStart,
  entriesDueNow,
  entriesNowLine,
  makeRecurringHref,
  NOW_DISPLAY_CAP,
  postPayload,
  scheduleOfFields,
  valuesOfDraft,
  valuesOfRule,
  type ScheduleFields,
} from "./rule-fields"

const day = calendarDate
const schedule = (over: Partial<Schedule> = {}): Schedule => ({
  frequency: "MONTHLY",
  interval: 1,
  dayOfMonth: null,
  dayOfWeek: null,
  startDate: day("2026-08-01"),
  endDate: null,
  occurrenceLimit: null,
  ...over,
})

describe("dayControlOf", () => {
  it("is the day of the month for monthly, quarterly and yearly", () => {
    expect(dayControlOf("MONTHLY")).toBe("dayOfMonth")
    expect(dayControlOf("QUARTERLY")).toBe("dayOfMonth")
    expect(dayControlOf("YEARLY")).toBe("dayOfMonth")
  })
  it("is the day of the week for weekly, and nothing for daily", () => {
    expect(dayControlOf("WEEKLY")).toBe("dayOfWeek")
    expect(dayControlOf("DAILY")).toBeNull()
  })
})

describe("autoPostOffered", () => {
  it("is withheld for an investment valued by quantity", () => {
    expect(autoPostOffered({ kind: "INVESTMENT", valuationMode: "QUANTITY" })).toBe(false)
  })
  it("is on offer for any other destination", () => {
    expect(autoPostOffered({ kind: "INVESTMENT", valuationMode: "LUMP" })).toBe(true)
    expect(autoPostOffered({ kind: "INVESTMENT", valuationMode: "CONTRIBUTION_ONLY" })).toBe(true)
    expect(autoPostOffered({ kind: "EXPENSE", valuationMode: null })).toBe(true)
    expect(autoPostOffered({ kind: "ASSET", valuationMode: null })).toBe(true)
  })
  it("is on offer before a destination is chosen", () => {
    expect(autoPostOffered(undefined)).toBe(true)
  })
})

describe("entriesDueNow", () => {
  const today = day("2026-10-28")
  it("counts every scheduled day from the start through today, today included", () => {
    expect(entriesDueNow(schedule({ startDate: day("2026-08-01") }), 0, today)).toBe(3) // 1 Aug, 1 Sep, 1 Oct
    expect(entriesDueNow(schedule({ startDate: day("2026-10-28") }), 0, today)).toBe(1)
  })
  it("is none for a start in the future", () => {
    expect(entriesDueNow(schedule({ startDate: day("2026-11-01") }), 0, today)).toBe(0)
  })
  it("stops at the end date and at what is left of the limit", () => {
    expect(entriesDueNow(schedule({ endDate: day("2026-09-15") }), 0, today)).toBe(2)
    expect(entriesDueNow(schedule({ occurrenceLimit: 2 }), 0, today)).toBe(2)
    expect(entriesDueNow(schedule({ occurrenceLimit: 3 }), 2, today)).toBe(1)
    expect(entriesDueNow(schedule({ occurrenceLimit: 3 }), 3, today)).toBe(0)
  })
  it("counts one past the cap and no further, so a daily rule from years ago is cheap", () => {
    const old = schedule({ frequency: "DAILY", startDate: day("2020-01-01") })
    expect(entriesDueNow(old, 0, today)).toBe(NOW_DISPLAY_CAP + 1)
  })
})

describe("entriesNowLine", () => {
  it("says nothing when nothing is due", () => {
    expect(entriesNowLine(0, false)).toBeNull()
  })
  it("says one entry, or N entries, will appear in the inbox", () => {
    expect(entriesNowLine(1, false)).toBe("1 entry will appear in your inbox now.")
    expect(entriesNowLine(3, false)).toBe("3 entries will appear in your inbox now.")
    expect(entriesNowLine(100, false)).toBe("100 entries will appear in your inbox now.")
  })
  it("says more than 100 beyond the cap", () => {
    expect(entriesNowLine(101, false)).toBe("More than 100 entries will appear in your inbox now.")
  })
  it("says the entries are posted when the rule posts itself", () => {
    expect(entriesNowLine(2, true)).toBe("2 entries will be posted now.")
  })
})

const fields = (over: Partial<ScheduleFields> = {}): ScheduleFields => ({
  frequency: "MONTHLY",
  interval: "1",
  dayOfMonth: "",
  dayOfWeek: "",
  anchor: "2026-11-30",
  endDate: "",
  occurrenceLimit: "",
  ...over,
})

describe("scheduleOfFields", () => {
  it("reads the text of the fields, filling in the day from the start date as the server does", () => {
    expect(scheduleOfFields(fields())).toEqual({
      frequency: "MONTHLY",
      interval: 1,
      dayOfMonth: 30,
      dayOfWeek: null,
      startDate: "2026-11-30",
      endDate: null,
      occurrenceLimit: null,
    })
  })
  it("drops the day control the frequency does not use", () => {
    expect(scheduleOfFields(fields({ frequency: "WEEKLY", dayOfMonth: "5", dayOfWeek: "3" }))).toMatchObject({ dayOfMonth: null, dayOfWeek: 3 })
    expect(scheduleOfFields(fields({ frequency: "DAILY", dayOfMonth: "5", dayOfWeek: "3" }))).toMatchObject({ dayOfMonth: null, dayOfWeek: null })
  })
  it("is null while a field is not sound", () => {
    expect(scheduleOfFields(fields({ anchor: "" }))).toBeNull()
    expect(scheduleOfFields(fields({ anchor: "2026-02-31" }))).toBeNull()
    expect(scheduleOfFields(fields({ interval: "" }))).toBeNull()
    expect(scheduleOfFields(fields({ interval: "0" }))).toBeNull()
    expect(scheduleOfFields(fields({ interval: "1.5" }))).toBeNull()
    expect(scheduleOfFields(fields({ interval: "100" }))).toBeNull()
    expect(scheduleOfFields(fields({ dayOfMonth: "32" }))).toBeNull()
    expect(scheduleOfFields(fields({ endDate: "soon" }))).toBeNull()
    expect(scheduleOfFields(fields({ endDate: "2026-11-01" }))).toBeNull()
    expect(scheduleOfFields(fields({ occurrenceLimit: "0" }))).toBeNull()
    expect(scheduleOfFields(fields({ occurrenceLimit: "-2" }))).toBeNull()
  })
})

describe("endsBeforeStart", () => {
  it("is true only for two real days in the wrong order", () => {
    expect(endsBeforeStart("2026-11-30", "2026-11-01")).toBe(true)
    expect(endsBeforeStart("2026-11-30", "2026-11-30")).toBe(false)
    expect(endsBeforeStart("2026-11-30", "")).toBe(false)
    expect(endsBeforeStart("", "2026-11-01")).toBe(false)
  })
})

describe("makeRecurringHref", () => {
  const nodes = new Map<string, Pick<PickerNode, "systemRole">>([
    ["bank", { systemRole: null }],
    ["food", { systemRole: null }],
    ["opening", { systemRole: "OPENING_BALANCE" }],
  ])
  const entry = { id: "t 1", groupId: null, deleted: false, fromNodeId: "bank", toNodeId: "food" }
  it("links a single live entry between the user's own nodes to the new-rule form", () => {
    expect(makeRecurringHref(entry, nodes)).toBe("/recurring/new?from=t%201")
  })
  it("offers nothing for a split leg, a deleted entry or a sale", () => {
    expect(makeRecurringHref({ ...entry, groupId: "g" }, nodes)).toBeNull()
    expect(makeRecurringHref({ ...entry, deleted: true }, nodes)).toBeNull()
    expect(makeRecurringHref(entry, nodes, true)).toBeNull()
  })
  it("offers nothing for an entry touching a system node, or a node it does not know", () => {
    expect(makeRecurringHref({ ...entry, fromNodeId: "opening" }, nodes)).toBeNull()
    expect(makeRecurringHref({ ...entry, toNodeId: "gone" }, nodes)).toBeNull()
  })
})

describe("the values a form starts from", () => {
  const today = day("2026-10-28")

  it("is monthly from today for a blank form", () => {
    expect(blankValues(today)).toMatchObject({ frequency: "MONTHLY", interval: "1", anchor: "2026-10-28", from: "", to: "", amount: "", autoPost: false })
  })

  it("carries a transaction's ends, rupees, note and tags, with the draft's start", () => {
    const draft: RuleDraft = {
      fromNodeId: "bank",
      toNodeId: "food",
      amountPaise: "123450",
      note: "Flat 4B",
      tags: ["home", "rent"],
      frequency: "MONTHLY",
      interval: 1,
      startDate: "2026-11-30",
      dayOfMonth: 31,
      autoPost: false,
    }
    expect(valuesOfDraft(draft)).toMatchObject({
      from: "bank",
      to: "food",
      amount: "1234.50",
      note: "Flat 4B",
      tags: "home, rent",
      anchor: "2026-11-30",
      dayOfMonth: "31", // the transaction's own day: the form submits it, so a month-end rule stays on the month's end
      frequency: "MONTHLY",
      interval: "1",
      name: "",
    })
  })

  it("keeps a month-end draft on the month's end: 28 Feb, then 31 Mar", () => {
    const draft: RuleDraft = {
      fromNodeId: "bank",
      toNodeId: "food",
      amountPaise: "100",
      note: null,
      tags: [],
      frequency: "MONTHLY",
      interval: 1,
      startDate: "2026-02-28",
      dayOfMonth: 31,
      autoPost: false,
    }
    const schedule = scheduleOfFields(valuesOfDraft(draft))
    expect(schedule).not.toBeNull()
    expect(datesDue(schedule!, { from: day("2026-02-28"), count: 0, max: 3 })).toEqual(["2026-02-28", "2026-03-31", "2026-04-30"])
  })

  it("carries a rule's own fields, with the next due day as the date", () => {
    const rule: RuleView = {
      id: "r1",
      name: "Rent",
      fromNodeId: "bank",
      toNodeId: "food",
      fromName: "Bank",
      toName: "Food",
      amountPaise: "1500000",
      note: null,
      tags: [],
      frequency: "WEEKLY",
      interval: 2,
      dayOfMonth: null,
      dayOfWeek: 1,
      startDate: "2026-04-01",
      endDate: "2027-01-01",
      occurrenceLimit: 10,
      autoPost: true,
      nextDueOn: "2026-11-02",
      state: "active",
      scheduleText: "Every 2 weeks on Monday",
      version: 3,
    }
    expect(valuesOfRule(rule, today)).toEqual({
      name: "Rent",
      from: "bank",
      to: "food",
      amount: "15000.00",
      note: "",
      tags: "",
      autoPost: true,
      frequency: "WEEKLY",
      interval: "2",
      dayOfMonth: "",
      dayOfWeek: "1",
      anchor: "2026-11-02",
      endDate: "2027-01-01",
      occurrenceLimit: "10",
    })
    expect(valuesOfRule({ ...rule, nextDueOn: null }, today).anchor).toBe("2026-10-28")
  })
})

describe("what posting sends", () => {
  const shown = { id: "o1", amountPaise: "1500050", note: "Flat 4B", dueOn: "2026-11-01" }

  it("sends the amount and the note the card showed, not only the id: a rule edited since must not change what is recorded", () => {
    expect(postPayload(shown)).toEqual({ id: "o1", amount: "15000.50", note: "Flat 4B" })
  })

  it("sends a card with no note as an empty note, so a note added to the rule since is not recorded either", () => {
    expect(postPayload({ ...shown, note: null })).toEqual({ id: "o1", amount: "15000.50", note: "" })
  })

  it("turns paise into rupee text exactly, never through a JS number", () => {
    expect(postPayload({ ...shown, amountPaise: "123456789012345678" }).amount).toBe("1234567890123456.78")
    expect(postPayload({ ...shown, amountPaise: "5" }).amount).toBe("0.05")
  })

  it("sends the form's amount and note as typed, the day only when it is not the due day, and the quantity when given", () => {
    const form = { amount: " 950.50 ", date: "2026-11-01", note: " late fee ", quantity: "" }
    expect(postPayload(shown, form)).toEqual({ id: "o1", amount: "950.50", note: "late fee" })
    expect(postPayload(shown, { ...form, date: "2026-11-03", quantity: " 0.75 " })).toEqual({
      id: "o1",
      amount: "950.50",
      note: "late fee",
      occurredAt: "2026-11-03",
      quantity: "0.75",
    })
  })

  it("sends the card's own amount from an untouched form, so an edit-and-post is as exact as a one-tap post", () => {
    expect(postPayload(shown, { amount: "15000.50", date: "2026-11-01", note: "Flat 4B", quantity: "" })).toEqual(postPayload(shown))
  })
})
