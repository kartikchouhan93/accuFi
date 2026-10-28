import type { LedgerNode, RecurringRule } from "@prisma/client"
import { addDays, type CalendarDate } from "@/domain/calendar-date"
import type { Paise } from "@/domain/money"
import {
  datesDue,
  firstDue,
  MAX_DUE_PER_RUN,
  normaliseSchedule,
  scheduleViolations,
  type RecurrenceFrequency,
  type Schedule,
} from "@/domain/recurrence"
import { validateTransaction, type ViolationCode } from "@/domain/transaction-rules"
import { RULE_NAME_MAX_LENGTH } from "@/lib/schemas/recurring"
import { scheduleOfRule, toRuleView, type RuleView } from "@/lib/recurring-view"
import { NotFoundError } from "@/server/repositories/errors"
import {
  countOccurrences,
  DuplicateRuleKeyError,
  findRuleById,
  insertRule,
  RuleVersionConflictError,
  softDeleteRule,
  updateRule,
  type RuleData,
} from "@/server/repositories/recurring-repository"
import { inTransaction } from "@/server/repositories/unit-of-work"
import { todayFor } from "@/server/services/clock"
import { lotModeOf } from "@/server/services/lot-rules"
import { generateDue } from "@/server/services/recurring-generation"
import { cleanNote, cleanTags, requireNode } from "@/server/services/transaction-service"

// The life of a rule (design §8): create, edit, pause and resume, delete. A rule only ever proposes: what turns a
// rule into occurrences is `generateDue`, which every operation here that could make something due calls last, so the
// inbox is current the moment a rule is saved. Edits change the future only (EC-44): posted transactions and the days
// already proposed are never touched, and a schedule edit RE-ANCHORS: the form's "next due" becomes the start date, so
// "every 2 months" to "every 3 months" begins where the user says and not on a grid they cannot see.

export interface RuleInput {
  name: string
  fromNodeId: string
  toNodeId: string
  amount: Paise
  note?: string
  tags?: string[]
  frequency: RecurrenceFrequency
  interval: number
  dayOfMonth?: number
  dayOfWeek?: number
  startDate: CalendarDate
  endDate?: CalendarDate
  occurrenceLimit?: number
  autoPost: boolean
}

export interface RuleViolation {
  field: string
  message: string
}

/** The rule as submitted is not allowed; each violation names the form field to fix. Nothing was written. */
export class InvalidRuleError extends Error {
  constructor(readonly violations: RuleViolation[]) {
    super(violations.map((violation) => violation.message).join(" "))
    this.name = "InvalidRuleError"
  }
}

// The form field a broken transaction rule belongs to, as the transaction form files them: the pair of nodes and the
// flow under the destination (what a user changes to fix it), an archived end under its own control.
const FIELD_OF_VIOLATION: Partial<Record<ViolationCode, string>> = {
  SAME_NODE: "toNodeId",
  ILLEGAL_FLOW: "toNodeId",
  ARCHIVED_SOURCE: "fromNodeId",
  ARCHIVED_TARGET: "toNodeId",
  NON_POSITIVE_AMOUNT: "amount",
}

const TOO_MANY_DUE = `That would put more than ${MAX_DUE_PER_RUN} entries in your inbox at once. Choose a later start date.`
const AUTOPOST_NEEDS_QUANTITY =
  "An investment valued by quantity needs a quantity for each purchase, so it cannot be posted automatically. Turn off automatic posting."

/** The rule's content, validated and cleaned, ready to store. `anchorField` names the control the day came from. */
interface Prepared {
  data: RuleData
  schedule: Schedule
}

/**
 * Everything the template and the schedule must satisfy, or InvalidRuleError carrying every violation. `anchor` is the
 * day the schedule starts on (the start date, or the edit's next due) and `existing` how many occurrences the rule
 * already has, since the occurrence limit and the "too many due now" check both count them.
 */
function prepare(
  input: Omit<RuleInput, "startDate">,
  anchor: CalendarDate,
  anchorField: "startDate" | "nextDue",
  from: LedgerNode,
  to: LedgerNode,
  existing: number,
  today: CalendarDate,
): Prepared {
  const violations: RuleViolation[] = []

  const name = input.name.trim()
  if (name === "" || name.length > RULE_NAME_MAX_LENGTH) {
    violations.push({ field: "name", message: `The name must be between 1 and ${RULE_NAME_MAX_LENGTH} characters.` })
  }

  for (const violation of validateTransaction({ fromNode: from, toNode: to, amount: input.amount, occurredAt: anchor })) {
    violations.push({ field: FIELD_OF_VIOLATION[violation.code] ?? "toNodeId", message: violation.message })
  }
  // Posting happens by itself, with no one to say how much was bought: a quantity investment needs a person.
  if (input.autoPost && lotModeOf(to) === "QUANTITY") {
    violations.push({ field: "autoPost", message: AUTOPOST_NEEDS_QUANTITY })
  }

  const schedule = normaliseSchedule({
    frequency: input.frequency,
    interval: input.interval,
    dayOfMonth: input.dayOfMonth ?? null,
    dayOfWeek: input.dayOfWeek ?? null,
    startDate: anchor,
    endDate: input.endDate ?? null,
    occurrenceLimit: input.occurrenceLimit ?? null,
  })
  const scheduleProblems = scheduleViolations(schedule)
  for (const violation of scheduleProblems) violations.push(violation)
  if (scheduleProblems.length === 0) {
    // One more than the limit is enough to know it is exceeded, without walking years of a daily rule.
    const due = datesDue(schedule, { from: anchor, count: existing, upTo: today, max: MAX_DUE_PER_RUN + 1 })
    if (due.length > MAX_DUE_PER_RUN) violations.push({ field: anchorField, message: TOO_MANY_DUE })
  }

  if (violations.length > 0) throw new InvalidRuleError(violations)
  return {
    schedule,
    data: {
      name,
      fromNodeId: input.fromNodeId,
      toNodeId: input.toNodeId,
      amountPaise: input.amount,
      note: cleanNote(input.note),
      tags: cleanTags(input.tags ?? []),
      frequency: schedule.frequency,
      interval: schedule.interval,
      dayOfMonth: schedule.dayOfMonth,
      dayOfWeek: schedule.dayOfWeek,
      startDate: anchor,
      endDate: schedule.endDate,
      occurrenceLimit: schedule.occurrenceLimit,
      autoPost: input.autoPost,
    },
  }
}

/** The view of a stored rule: its two ends read now, archived or not. */
async function viewOf(userId: string, rule: RecurringRule): Promise<RuleView> {
  const [from, to] = await Promise.all([requireNode(userId, rule.fromNodeId), requireNode(userId, rule.toNodeId)])
  return toRuleView(rule, from, to)
}

/** Generate whatever is now due, then answer with the rule as it then is (the sweep may have moved `nextDueOn`). */
async function viewAfterGeneration(userId: string, id: string): Promise<RuleView> {
  await generateDue(userId)
  const rule = await findRuleById(userId, id)
  if (!rule) throw new NotFoundError("rule") // deleted while this was running
  return viewOf(userId, rule)
}

/**
 * Create a rule. Validates the template as a transaction would be (violations filed under fromNodeId, toNodeId, amount),
 * the schedule, `autoPost` into a quantity investment, and a start date that would make over 100 entries due now. Then
 * stores it with its first due day and generates what is already due, so the inbox is current. A repeated
 * `idempotencyKey` returns the rule it already made. Throws InvalidRuleError, or NotFoundError for a node that is not the
 * user's.
 */
export async function createRule(userId: string, input: RuleInput & { idempotencyKey: string }): Promise<RuleView> {
  const [from, to, today] = await Promise.all([
    requireNode(userId, input.fromNodeId),
    requireNode(userId, input.toNodeId),
    todayFor(userId),
  ])
  const { data, schedule } = prepare(input, input.startDate, "startDate", from, to, 0, today)
  let rule: RecurringRule
  try {
    rule = await insertRule(userId, { ...data, nextDueOn: firstDue(schedule), idempotencyKey: input.idempotencyKey })
  } catch (error) {
    // A replay: the stored rule is the answer, however long ago it was made; nothing more is generated for it.
    if (error instanceof DuplicateRuleKeyError) return viewOf(userId, error.existing)
    throw error
  }
  return viewAfterGeneration(userId, rule.id)
}

/**
 * Edit a rule, as of `expectedVersion`. The same validation as creating, and the schedule is re-anchored: `nextDue`
 * becomes the start date and the next due day is the first date of the new schedule from it. Occurrences that exist (and
 * what was posted from them) are left exactly as they are. Throws RuleVersionConflictError for a stale version,
 * InvalidRuleError, NotFoundError.
 */
export async function editRule(
  userId: string,
  id: string,
  expectedVersion: number,
  input: Omit<RuleInput, "startDate"> & { nextDue: CalendarDate },
): Promise<RuleView> {
  const [from, to, today, existing] = await Promise.all([
    requireNode(userId, input.fromNodeId),
    requireNode(userId, input.toNodeId),
    todayFor(userId),
    countOccurrences(userId, id),
  ])
  const { data, schedule } = prepare(input, input.nextDue, "nextDue", from, to, existing, today)
  // `updateRule` is where a stale version, or a rule that is not the user's or is gone, is refused.
  await updateRule(userId, id, expectedVersion, { ...data, nextDueOn: firstDue(schedule, existing) })
  return viewAfterGeneration(userId, id)
}

// A pause or a resume names no version: it is a plain switch, not an edit of what the user was looking at. The sweep
// moving `nextDueOn` between the read and the write bumps the version, so the write retries against the row's new one.
const SWITCH_ATTEMPTS = 3

/**
 * Pause stops generation (an entry already in the inbox stays). Resume clears the pause and starts from the first
 * scheduled date after today: what fell due while paused is not backfilled, since pausing was a decision and not downtime.
 * Setting the state a rule is already in changes nothing. Throws NotFoundError.
 */
export async function setPaused(userId: string, id: string, paused: boolean): Promise<RuleView> {
  let rule = await findRuleById(userId, id)
  for (let attempt = 1; ; attempt++) {
    if (!rule) throw new NotFoundError("rule")
    if (paused === (rule.pausedAt !== null)) return viewOf(userId, rule)
    try {
      const changes = paused
        ? { pausedAt: new Date() }
        : { pausedAt: null, nextDueOn: await nextDueAfterToday(userId, rule) }
      const updated = await updateRule(userId, id, rule.version, changes)
      return paused ? viewOf(userId, updated) : viewAfterGeneration(userId, id)
    } catch (error) {
      if (!(error instanceof RuleVersionConflictError) || attempt >= SWITCH_ATTEMPTS) throw error
      rule = error.current
    }
  }
}

/** The first scheduled date strictly after today, or null if the schedule has no more. */
async function nextDueAfterToday(userId: string, rule: RecurringRule): Promise<CalendarDate | null> {
  const [today, existing] = await Promise.all([todayFor(userId), countOccurrences(userId, rule.id)])
  return datesDue(scheduleOfRule(rule), { from: addDays(today, 1), count: existing, max: 1 })[0] ?? null
}

/**
 * Delete a rule: soft, with its pending entries removed in the same transaction. What was posted or skipped stays as
 * history, and so do the transactions. Throws NotFoundError for a rule that is not the user's or is already deleted.
 */
export async function deleteRule(userId: string, id: string): Promise<void> {
  await inTransaction((uow) => softDeleteRule(userId, id, uow))
}
