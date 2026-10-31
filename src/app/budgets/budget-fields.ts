import { addMonths, calendarDate, monthOf, type CalendarDate } from "@/domain/calendar-date"
import { MoneyParseError, parseRupees } from "@/domain/money"
import type { BudgetSettingsView } from "@/lib/budget-view"
import { formatPaiseText } from "@/lib/node-money"
import type { PickerNode } from "@/lib/transaction-list-view"
import { paiseTextToRupees } from "@/lib/transaction-text"

// The pure part of the budget form: the months it offers, the sentence it shows about what saving will do, the values it
// opens with and how a refusal is filed under its fields. Months here are "YYYY-MM" text, as the month fields send them
// (a view's "YYYY-MM-01" is turned by `monthValue`). No server imports and no clock: `today` is always passed in.

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December",
]

/** One line, beside the rollover switch, of what it does. */
export const ROLLOVER_NOTE = "Unspent budget carries into the next month."

/** "November 2026" for "2026-11" (or "2026-11-01"). */
export function monthText(month: string): string {
  return `${MONTH_NAMES[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`
}

/** "2026-11" for "2026-11-01" (or any day of that month): the text a month field holds and sends. */
export const monthValue = (date: string): string => date.slice(0, 7)

const firstOf = (month: string): CalendarDate => calendarDate(`${month}-01`)

/** A labelled option for every month from `from` to `to`, both "YYYY-MM", in order; none when `to` is before `from`. */
export function monthOptions(from: string, to: string): { value: string; label: string }[] {
  const options: { value: string; label: string }[] = []
  const last = firstOf(to)
  for (let month = firstOf(from); month <= last; month = addMonths(month, 1)) {
    const value = monthValue(month)
    options.push({ value, label: monthText(value) })
  }
  return options
}

/**
 * In words, what saving the amount will do. From a month after the budget's start the budget splits and earlier months keep
 * the old amount; from its start or earlier the amount is corrected for the whole budget; a month after its end is refused
 * (the server says the same). All three months are "YYYY-MM".
 */
export function describeRevision(startMonth: string, appliesFrom: string, endMonth: string | null): string {
  if (endMonth !== null && appliesFrom > endMonth) return `This budget ended in ${monthText(endMonth)}. Pick a month it applies to.`
  if (appliesFrom <= startMonth) return "Corrects the amount for every month of this budget."
  return `Changes the amount from ${monthText(appliesFrom)}; earlier months keep the old amount.`
}

/** What a new budget may start in: three years back (to budget history) to a year ahead of the current month. */
export function startMonthOptions(today: CalendarDate): { value: string; label: string }[] {
  const current = monthOf(today)
  return monthOptions(monthValue(addMonths(current, -36)), monthValue(addMonths(current, 12)))
}

/**
 * What a budget may end in: its start month on, three years past the later of that and this month, and the end it has (even
 * one before the start, which the server refuses with its reason: a select cannot show a month it does not list).
 */
export function endMonthOptions(startMonth: string, endMonth: string, today: CalendarDate): { value: string; label: string }[] {
  const later = monthOf(today) > firstOf(startMonth) ? monthOf(today) : firstOf(startMonth)
  const reach = monthValue(addMonths(later, 36))
  return monthOptions(endMonth !== "" && endMonth < startMonth ? endMonth : startMonth, endMonth > reach ? endMonth : reach)
}

/**
 * What a new amount may apply from: the budget's start to this month, and no further than its end month when it has one (a
 * month after the end is refused, so it is never offered). A budget not yet started offers this month alone. "YYYY-MM".
 */
export function appliesFromOptions(startMonth: string, today: CalendarDate, endMonth: string | null = null): { value: string; label: string }[] {
  const current = monthValue(monthOf(today))
  const last = endMonth !== null && endMonth < current ? endMonth : current
  return monthOptions(startMonth < current ? startMonth : current, last)
}

/** The live, non-system expense ledgers, plus the ones named in `keep`: what a budget may be put on. */
export function ledgerChoices(nodes: readonly PickerNode[], keep: readonly string[] = []): PickerNode[] {
  return nodes.filter((node) => node.kind === "EXPENSE" && (keep.includes(node.id) || (!node.archived && node.systemRole === null)))
}

export interface NewBudgetValues {
  nodeId: string
  /** Rupee text. */
  amount: string
  /** "YYYY-MM". */
  startMonth: string
  /** "YYYY-MM", or "" for none. */
  endMonth: string
  rollover: boolean
}

export interface EditBudgetValues {
  amount: string
  /** "YYYY-MM": the month a new amount applies from. */
  appliesFrom: string
  endMonth: string
  rollover: boolean
}

export function blankValues(today: CalendarDate): NewBudgetValues {
  return { nodeId: "", amount: "", startMonth: monthValue(today), endMonth: "", rollover: false }
}

/**
 * An edit opens on the budget as it is, with a new amount set to apply from this month, so history is never rewritten by
 * default. A budget that ended before this month opens on its end month instead, the latest month it can apply from:
 * this month is past its end and would open the page on a refusal.
 */
export function valuesOfBudget(budget: BudgetSettingsView, today: CalendarDate): EditBudgetValues {
  const current = monthValue(today)
  const end = budget.endMonth === null ? null : monthValue(budget.endMonth)
  return {
    amount: paiseTextToRupees(budget.amountPaise),
    appliesFrom: end !== null && end < current ? end : current,
    endMonth: end ?? "",
    rollover: budget.rollover,
  }
}

/**
 * `appliesFrom` if the budget still offers it, otherwise the month the form would open on: after a save that stays on the
 * page the budget is another one (a split moves its start, new settings move its end), and a month that is no longer an
 * option must not be left in the select. "YYYY-MM".
 */
export function fitAppliesFrom(appliesFrom: string, budget: BudgetSettingsView, today: CalendarDate): string {
  const end = budget.endMonth === null ? null : monthValue(budget.endMonth)
  const offered = appliesFromOptions(monthValue(budget.startMonth), today, end)
  return offered.some((option) => option.value === appliesFrom) ? appliesFrom : valuesOfBudget(budget, today).appliesFrom
}

export type EditSection = "amount" | "settings"

/** Rupee text as paise, or null when it is not an amount (blank, letters, too many decimals). */
function paiseOfText(text: string): bigint | null {
  try {
    return parseRupees(text)
  } catch (error) {
    if (error instanceof MoneyParseError) return null
    throw error
  }
}

/**
 * Whether what the form now holds for `section` is not what the budget has stored. The amount section differs when the
 * amount typed is not the stored amount (compared as money, so "12345" is "12,345.00"; a blank or unusable one differs, it
 * was changed); the month it applies from is a choice about a save, not a value to lose. The settings section differs when
 * the end month or the rollover is not the stored one.
 */
export function sectionDiffers(section: EditSection, values: EditBudgetValues, budget: BudgetSettingsView): boolean {
  if (section === "amount") return String(paiseOfText(values.amount)) !== budget.amountPaise
  const end = budget.endMonth === null ? "" : monthValue(budget.endMonth)
  return values.endMonth !== end || values.rollover !== budget.rollover
}

/**
 * What to add to the message after `saved` was saved, if the OTHER section holds a change that went nowhere: the form's two
 * sections save on their own, so a change in the one not saved would otherwise vanish without a word. Null when it is as stored.
 */
export function unsavedSentence(saved: EditSection, values: EditBudgetValues, budget: BudgetSettingsView): string | null {
  const other: EditSection = saved === "amount" ? "settings" : "amount"
  return sectionDiffers(other, values, budget) ? `Your change to the ${other} was not saved.` : null
}

/**
 * What the screen says after the amount was saved. `before` is the budget as the form held it, `saved` what the server
 * answered: the same amount back is no change (the server wrote nothing), one budget with another amount is a correction of
 * the whole budget, two budgets are a split from the new one's start month.
 */
export function revisionLines(before: BudgetSettingsView, saved: BudgetSettingsView[]): string[] {
  const last = saved[saved.length - 1]
  if (saved.length === 2) {
    return [`Changed the ${last.nodeName} budget to ${formatPaiseText(last.amountPaise)} from ${monthText(last.startMonth)}.`, "Earlier months keep the old amount."]
  }
  if (last.amountPaise === before.amountPaise) return ["Nothing changed."]
  return [`Corrected the ${last.nodeName} budget to ${formatPaiseText(last.amountPaise)} for every month of it.`]
}

/**
 * The month the Budgets screen should open on after a save: the current month when the budget covers it or has not started
 * (the screen has no month before the first budget's start, and lists a budget that starts later under Upcoming), otherwise
 * the budget's own first month, since one that ended is only reachable there. "YYYY-MM".
 */
export function landingMonth(budget: Pick<BudgetSettingsView, "startMonth" | "endMonth">, today: CalendarDate): string {
  const current = monthValue(today)
  const start = monthValue(budget.startMonth)
  const ended = budget.endMonth !== null && monthValue(budget.endMonth) < current
  return ended ? start : current
}

export interface Outcome {
  fieldErrors: Record<string, string[]>
  message: string
  /** The refusal is about fields, which show it beside themselves. */
  isFieldProblem: boolean
}

/** A refusal, filed under its fields. The shape is structural, so this file needs nothing from the server. */
export function describeFailure(failure: { ok: false; error: { code: string; message: string; fieldErrors?: Record<string, string[]> } }): Outcome {
  const { code, message } = failure.error
  const fieldErrors = failure.error.fieldErrors ?? {}
  const hasFields = Object.keys(fieldErrors).length > 0
  return {
    fieldErrors,
    isFieldProblem: code === "invalid_input" || (code === "invalid" && hasFields),
    message: code === "invalid_input" ? "Check the highlighted fields." : message,
  }
}
