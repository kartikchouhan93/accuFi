import { calendarDate, CalendarDateError, compareDates, type CalendarDate } from "@/domain/calendar-date"
import { datesDue, MAX_DUE_PER_RUN, normaliseSchedule, scheduleViolations, type RecurrenceFrequency, type Schedule } from "@/domain/recurrence"
import type { OccurrenceView, RuleDraft, RuleView } from "@/lib/recurring-view"
import type { PickerNode } from "@/lib/transaction-list-view"
import { paiseTextToRupees } from "@/lib/transaction-text"
import type { TransactionView } from "@/lib/transaction-view"

// The decisions the rule form makes that do not need a browser: which day control a frequency has, whether a destination
// can be posted into automatically, how many entries a start date makes due at once, and whether a transaction can be
// turned into a rule. Pure, importing only domain and type code, so the form (a client component) and the tests use the
// same ones.

export type DayControl = "dayOfMonth" | "dayOfWeek"

/** The one day control a frequency has: the day of the month, the day of the week, or none (daily). */
export function dayControlOf(frequency: RecurrenceFrequency): DayControl | null {
  switch (frequency) {
    case "DAILY":
      return null
    case "WEEKLY":
      return "dayOfWeek"
    default:
      return "dayOfMonth"
  }
}

/** Shown beside the day of the month: a day a short month lacks lands on that month's last day. */
export const DAY_OF_MONTH_HINT = "31, or the last day if the month is shorter"

export const AUTO_POST_REASON =
  "An investment valued by quantity needs a quantity for each purchase, so it cannot be posted automatically."

/**
 * Whether "Post automatically" is on offer for this destination. Posting by itself has no one to say how much was bought,
 * so an investment valued by quantity is never posted that way (the server refuses it too). No destination chosen yet:
 * on offer, since nothing rules it out.
 */
export function autoPostOffered(destination: Pick<PickerNode, "kind" | "valuationMode"> | undefined): boolean {
  return !(destination?.kind === "INVESTMENT" && destination.valuationMode === "QUANTITY")
}

/** The most entries one save may make due at once; more is refused, and shown as "more than 100". */
export const NOW_DISPLAY_CAP = MAX_DUE_PER_RUN

/**
 * How many entries the schedule makes due through `today` (today included), counting from its start date and given the
 * `existing` entries the rule already has. One more than the cap is as far as it counts: that is enough to say "more than".
 */
export function entriesDueNow(schedule: Schedule, existing: number, today: CalendarDate): number {
  return datesDue(schedule, { from: schedule.startDate, count: existing, upTo: today, max: NOW_DISPLAY_CAP + 1 }).length
}

/**
 * The line that says what saving will put in front of the user right now, or null when nothing is due yet. A rule that
 * posts itself does not wait in the inbox, so it says that instead.
 */
export function entriesNowLine(count: number, autoPost: boolean): string | null {
  if (count <= 0) return null
  const entries = count > NOW_DISPLAY_CAP ? `More than ${NOW_DISPLAY_CAP} entries` : count === 1 ? "1 entry" : `${count} entries`
  return autoPost ? `${entries} will be posted now.` : `${entries} will appear in your inbox now.`
}

/** The schedule controls as the form holds them: the text of each field. */
export interface ScheduleFields {
  frequency: RecurrenceFrequency
  interval: string
  /** "" is the start date's own day. */
  dayOfMonth: string
  /** "" is the start date's own weekday. */
  dayOfWeek: string
  /** The start date when creating, the next due date when editing. */
  anchor: string
  endDate: string
  occurrenceLimit: string
}

const WHOLE_NUMBER = /^\d{1,6}$/

/** A whole number typed as digits only, or null: no sign, no decimal point, no exponent. */
export function wholeNumber(text: string): number | null {
  const trimmed = text.trim()
  return WHOLE_NUMBER.test(trimmed) ? Number(trimmed) : null
}

function day(text: string): CalendarDate | null {
  try {
    return calendarDate(text.trim())
  } catch (error) {
    if (error instanceof CalendarDateError) return null
    throw error
  }
}

/**
 * The schedule the fields describe, or null while they do not describe a sound one (a day not typed yet, an interval of
 * zero, an end before the start): the preview then says nothing rather than something wrong. The day of the month or week
 * the frequency does not use is dropped, as the server does.
 */
export function scheduleOfFields(fields: ScheduleFields): Schedule | null {
  const startDate = day(fields.anchor)
  const interval = wholeNumber(fields.interval)
  if (startDate === null || interval === null) return null
  const endDate = fields.endDate.trim() === "" ? null : day(fields.endDate)
  if (fields.endDate.trim() !== "" && endDate === null) return null
  const occurrenceLimit = fields.occurrenceLimit.trim() === "" ? null : wholeNumber(fields.occurrenceLimit)
  if (fields.occurrenceLimit.trim() !== "" && occurrenceLimit === null) return null
  const schedule = normaliseSchedule({
    frequency: fields.frequency,
    interval,
    dayOfMonth: fields.dayOfMonth === "" ? null : wholeNumber(fields.dayOfMonth),
    dayOfWeek: fields.dayOfWeek === "" ? null : wholeNumber(fields.dayOfWeek),
    startDate,
    endDate,
    occurrenceLimit,
  })
  return scheduleViolations(schedule).length === 0 ? schedule : null
}

/** An end date earlier than the anchor is the one schedule problem the form can name beside its own field before sending. */
export const endsBeforeStart = (anchor: string, endDate: string): boolean => {
  const start = day(anchor)
  const end = endDate.trim() === "" ? null : day(endDate)
  return start !== null && end !== null && compareDates(end, start) < 0
}

/**
 * Where "Make recurring" on a transaction row goes, or null when there is nothing to offer: a deleted entry, a sale, a leg
 * of a split (a rule repeats one movement, not a division), and anything touching one of the application's own nodes (an
 * opening balance or a realised gain is not something a person repeats). The server refuses the same, with a plain 404.
 */
export function makeRecurringHref(
  transaction: Pick<TransactionView, "id" | "groupId" | "deleted" | "fromNodeId" | "toNodeId">,
  nodes: ReadonlyMap<string, Pick<PickerNode, "systemRole">>,
  sale = false,
): string | null {
  if (sale || transaction.deleted || transaction.groupId !== null) return null
  const from = nodes.get(transaction.fromNodeId)
  const to = nodes.get(transaction.toNodeId)
  if (!from || !to || from.systemRole !== null || to.systemRole !== null) return null
  return `/recurring/new?from=${encodeURIComponent(transaction.id)}`
}

/** Every field of the form as the text it holds, which is what a page hands the form to start from. */
export interface RuleFormValues extends ScheduleFields {
  name: string
  from: string
  to: string
  /** Rupees as typed: "15000.00". */
  amount: string
  note: string
  /** Comma separated, as typed. */
  tags: string
  autoPost: boolean
}

/** A new rule with nothing chosen yet: monthly, starting today. */
export const blankValues = (today: CalendarDate): RuleFormValues => ({
  name: "",
  from: "",
  to: "",
  amount: "",
  note: "",
  tags: "",
  autoPost: false,
  frequency: "MONTHLY",
  interval: "1",
  dayOfMonth: "",
  dayOfWeek: "",
  anchor: today,
  endDate: "",
  occurrenceLimit: "",
})

/**
 * A new rule opened from a transaction ("Make recurring"): its ends, amount, note and tags, and the draft's schedule, with
 * the day of the month the transaction was on (not the start date's, which a short month may have clamped).
 */
export const valuesOfDraft = (draft: RuleDraft): RuleFormValues => ({
  ...blankValues(draft.startDate as CalendarDate),
  from: draft.fromNodeId,
  to: draft.toNodeId,
  amount: paiseTextToRupees(draft.amountPaise),
  note: draft.note ?? "",
  tags: draft.tags.join(", "),
  frequency: draft.frequency,
  interval: String(draft.interval),
  dayOfMonth: String(draft.dayOfMonth),
  autoPost: draft.autoPost,
})

/**
 * A rule being edited. The schedule is re-anchored on save, so the date the form asks for is the next due day; a rule
 * with none (it has run out) offers today. The stored day of the month or week is shown, since it is what the rule uses.
 */
export const valuesOfRule = (rule: RuleView, today: CalendarDate): RuleFormValues => ({
  name: rule.name,
  from: rule.fromNodeId,
  to: rule.toNodeId,
  amount: paiseTextToRupees(rule.amountPaise),
  note: rule.note ?? "",
  tags: rule.tags.join(", "),
  autoPost: rule.autoPost,
  frequency: rule.frequency,
  interval: String(rule.interval),
  dayOfMonth: rule.dayOfMonth === null ? "" : String(rule.dayOfMonth),
  dayOfWeek: rule.dayOfWeek === null ? "" : String(rule.dayOfWeek),
  anchor: rule.nextDueOn ?? today,
  endDate: rule.endDate ?? "",
  occurrenceLimit: rule.occurrenceLimit === null ? "" : String(rule.occurrenceLimit),
})

/** What the "Edit and post" form holds, as text. */
export interface PostForm {
  amount: string
  date: string
  note: string
  /** "" when the destination takes no quantity. */
  quantity: string
}

/**
 * What a post sends for a card. The amount and the note are ALWAYS the ones the card (or the form opened from it) showed,
 * never left for the server to fill in from the rule: a card can be minutes old, and a rule edited in another tab since
 * would otherwise make Post record something the person never saw. A card with no note sends an empty note, which records
 * none. The amount is the card's paise as rupee text, never through a number. The day is sent only when the form changed
 * it (an untouched one is the due day, which is the occurrence's own and cannot go stale); the quantity only when given.
 */
export function postPayload(
  occurrence: Pick<OccurrenceView, "id" | "amountPaise" | "note" | "dueOn">,
  form?: PostForm,
): Record<string, string> {
  if (!form) return { id: occurrence.id, amount: paiseTextToRupees(occurrence.amountPaise), note: occurrence.note ?? "" }
  const payload: Record<string, string> = { id: occurrence.id, amount: form.amount.trim(), note: form.note.trim() }
  if (form.date !== occurrence.dueOn) payload.occurredAt = form.date
  if (form.quantity.trim() !== "") payload.quantity = form.quantity.trim()
  return payload
}
