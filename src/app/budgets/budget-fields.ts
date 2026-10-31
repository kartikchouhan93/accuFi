import { addMonths, calendarDate, monthOf, type CalendarDate } from "@/domain/calendar-date"
import type { BudgetSettingsView } from "@/lib/budget-view"
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

/** What a budget may end in: its start month on, three years past the later of that and this month, and the end it has. */
export function endMonthOptions(startMonth: string, endMonth: string, today: CalendarDate): { value: string; label: string }[] {
  const later = monthOf(today) > firstOf(startMonth) ? monthOf(today) : firstOf(startMonth)
  const reach = monthValue(addMonths(later, 36))
  return monthOptions(startMonth, endMonth > reach ? endMonth : reach)
}

/** What a new amount may apply from: the budget's start to this month. A budget not yet started offers this month alone. */
export function appliesFromOptions(startMonth: string, today: CalendarDate): { value: string; label: string }[] {
  const current = monthValue(monthOf(today))
  return monthOptions(startMonth < current ? startMonth : current, current)
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

/** An edit opens on the budget as it is, with a new amount set to apply from this month, so history is never rewritten by default. */
export function valuesOfBudget(budget: BudgetSettingsView, today: CalendarDate): EditBudgetValues {
  return {
    amount: paiseTextToRupees(budget.amountPaise),
    appliesFrom: monthValue(today),
    endMonth: budget.endMonth === null ? "" : monthValue(budget.endMonth),
    rollover: budget.rollover,
  }
}

/**
 * The month the Budgets screen should open on after a save: the current month when the budget covers it, otherwise the
 * budget's own first month (the screen keeps a month it cannot show inside what exists). "YYYY-MM".
 */
export function landingMonth(budget: Pick<BudgetSettingsView, "startMonth" | "endMonth">, today: CalendarDate): string {
  const current = monthValue(today)
  const start = monthValue(budget.startMonth)
  const covers = start <= current && (budget.endMonth === null || monthValue(budget.endMonth) >= current)
  return covers ? current : start
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
