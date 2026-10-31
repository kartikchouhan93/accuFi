import { z } from "zod"
import { calendarDate, CalendarDateError, type CalendarDate } from "../../domain/calendar-date"
import { positiveRupees } from "./rupees"

// What a client may send to create, revise, change the settings of or delete a budget. Strict like the recurring and
// transaction schemas: `userId` and a revise's `startMonth` are errors, not silently dropped. Rupee text becomes paise and
// month text a first-of-month CalendarDate here, as validation issues. What depends on the ledger or on today (its kind,
// overlapping spans, a month in the future) is the service's to refuse. No server imports; relative imports as elsewhere.

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/

/** A month as the month picker sends it, "YYYY-MM", becomes the first day of that month ("YYYY-MM-01"). */
export const monthField = z.string().transform((text, ctx): CalendarDate => {
  try {
    if (MONTH_PATTERN.test(text)) return calendarDate(`${text}-01`)
  } catch (error) {
    if (!(error instanceof CalendarDateError)) throw error
  }
  ctx.addIssue({ code: "custom", message: "Enter a month" })
  return z.NEVER
})

const id = z.string().min(1)

export const createBudgetSchema = z.strictObject({
  nodeId: id,
  amount: positiveRupees,
  startMonth: monthField,
  endMonth: monthField.nullable().optional(),
  rollover: z.boolean(),
})

// A revise names the budget, the new amount and the month it applies from. The start month is not the caller's to move.
export const reviseBudgetSchema = z.strictObject({
  id,
  amount: positiveRupees,
  appliesFrom: monthField,
})

// The end month is always stated: null removes it. The amount is revised, not set here.
export const budgetSettingsSchema = z.strictObject({
  id,
  endMonth: monthField.nullable(),
  rollover: z.boolean(),
})

export const budgetIdSchema = z.strictObject({ id })
