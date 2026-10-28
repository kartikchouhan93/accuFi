import { z } from "zod"
import { INTERVAL_MAX, OCCURRENCE_LIMIT_MAX, RECURRENCE_FREQUENCIES } from "../../domain/recurrence"
import { positiveRupees } from "./rupees"
import { idempotencyKeyField, nodeIdField, noteField, occurredAtField, quantityField, tagsField } from "./transaction"

// What a client may send to create, edit, pause or delete a recurring rule. Strict like the transaction schemas:
// `userId`, `version`, `nextDueOn`, `pausedAt` and the like are errors, not silently dropped. Rupee text becomes paise
// and day text a CalendarDate here, as validation issues. What depends on the nodes or on today (the flow, an archived
// end, how many entries a start date makes due) is the service's to refuse. No server imports, so the rule form can reuse
// it; relative imports as in transaction.ts.

export const RULE_NAME_MAX_LENGTH = 60

const name = z.string().trim().min(1, "Enter a name").max(RULE_NAME_MAX_LENGTH, `At most ${RULE_NAME_MAX_LENGTH} characters`)
const wholeNumber = (what: string, min: number, max: number) =>
  z.number().int(`${what} must be a whole number`).min(min, `${what} must be at least ${min}`).max(max, `${what} must be at most ${max}`)

// The fields a rule has, whether it is being created or edited. The day of the month or week is optional: the service
// fills in the start date's own, and clears the one the frequency does not use.
const ruleFields = {
  name,
  fromNodeId: nodeIdField,
  toNodeId: nodeIdField,
  amount: positiveRupees,
  note: noteField.optional(),
  tags: tagsField.optional(),
  frequency: z.enum(RECURRENCE_FREQUENCIES),
  interval: wholeNumber("Repeat every", 1, INTERVAL_MAX),
  dayOfMonth: wholeNumber("The day of the month", 1, 31).optional(),
  dayOfWeek: wholeNumber("The day of the week", 1, 7).optional(),
  endDate: occurredAtField.optional(),
  occurrenceLimit: wholeNumber("The number of occurrences", 1, OCCURRENCE_LIMIT_MAX).optional(),
  autoPost: z.boolean(),
}

export const createRuleSchema = z.strictObject({
  ...ruleFields,
  startDate: occurredAtField,
  idempotencyKey: idempotencyKeyField,
})

// An edit re-anchors the schedule: the form asks for the next due date, which becomes the start date. There is no key:
// it belongs to the create.
export const editRuleSchema = z.strictObject({
  id: z.string().min(1),
  // The version the user was looking at: what makes a stale edit a conflict instead of a silent overwrite.
  expectedVersion: z.number().int().min(0),
  rule: z.strictObject({ ...ruleFields, nextDue: occurredAtField }),
})

export const ruleIdSchema = z.strictObject({ id: z.string().min(1) })

export const pauseRuleSchema = z.strictObject({ id: z.string().min(1), paused: z.boolean() })

// Posting an occurrence as proposed sends the id alone. "Edit and post" adds what the user changed: the amount (rupee
// text), the day, the note, and a quantity for a purchase into an investment valued by quantity (decimal text). Whether a
// quantity belongs here depends on the destination, which only the service knows, so it is optional and the service asks
// for it or refuses it, as it does for a transaction.
export const postOccurrenceSchema = z.strictObject({
  id: z.string().min(1),
  amount: positiveRupees.optional(),
  occurredAt: occurredAtField.optional(),
  note: noteField.optional(),
  quantity: quantityField.optional(),
})
