import type { LedgerNode, RecurringOccurrence, RecurringRule } from "@prisma/client"
import { fromDbDate } from "../domain/calendar-date"
import type { Schedule } from "../domain/recurrence"
import { describeSchedule } from "./recurring-text"
import { serialisePaise } from "./serialise"

// An occurrence as it crosses to the browser: the card the inbox shows. Not the Prisma rows: paise are decimal text (a
// bigint breaks JSON.stringify) and days are "YYYY-MM-DD" strings. The money, note and tags are the RULE's current
// template, because that is what posting records unless the user overrides it (spec §8, EC-44): the card shows what a
// click on Post would write. Once an occurrence is POSTED that no longer holds: the rule may have been edited since, so
// a posted view is built from what was actually recorded (`posted`), never from the rule. `userId` and the audit
// timestamps are left off.

export interface OccurrenceView {
  id: string
  ruleId: string
  ruleName: string
  dueOn: string
  status: "PENDING" | "POSTED" | "DISMISSED"
  fromNodeId: string
  toNodeId: string
  fromName: string
  toName: string
  /** Paise, as a decimal string. */
  amountPaise: string
  note: string | null
  tags: string[]
  /** Why an automatic post did not happen, if it did not. */
  postFailure: string | null
  /** The destination is an investment valued by quantity: each post needs a quantity, so Post opens the edit form. */
  needsQuantity: boolean
  /** The destination's unit ("g"), when `needsQuantity`. */
  unitLabel: string | null
  /** Either end is archived: it can be skipped but not posted. */
  nodeArchived: boolean
  transactionId: string | null
}

/** What a posted occurrence became: the stored transaction's own fields (a `TransactionView` fits as it is). */
export interface PostedSnapshot {
  fromNodeId: string
  toNodeId: string
  /** Paise, as a decimal string. */
  amountPaise: string
  note: string | null
  tags: string[]
}

/**
 * `fromNode` and `toNode` are the two ends shown, archived or not: the rule's, or, with `posted`, the transaction's.
 * `posted` replaces the rule's money, note, tags and ends with what was recorded; pass it for a POSTED occurrence.
 * Pure: no reads.
 */
export function toOccurrenceView(
  occurrence: RecurringOccurrence,
  rule: RecurringRule,
  fromNode: LedgerNode,
  toNode: LedgerNode,
  posted?: PostedSnapshot,
): OccurrenceView {
  // The QUANTITY case of the server's `lotModeOf`, spelled out: nothing in src/lib may import server code (a client
  // component imports from here), and the server module reaches the database.
  const needsQuantity = toNode.kind === "INVESTMENT" && toNode.valuationMode === "QUANTITY"
  return {
    id: occurrence.id,
    ruleId: rule.id,
    ruleName: rule.name,
    dueOn: fromDbDate(occurrence.dueOn),
    status: occurrence.status,
    fromNodeId: fromNode.id,
    toNodeId: toNode.id,
    fromName: fromNode.name,
    toName: toNode.name,
    amountPaise: posted ? posted.amountPaise : serialisePaise(rule.amountPaise),
    note: posted ? posted.note : rule.note,
    tags: posted ? [...posted.tags] : [...rule.tags],
    postFailure: occurrence.postFailure,
    needsQuantity,
    unitLabel: needsQuantity ? toNode.unitLabel : null,
    nodeArchived: fromNode.archivedAt !== null || toNode.archivedAt !== null,
    transactionId: occurrence.transactionId,
  }
}

// A rule as the rules screen and its form show it: the same crossing as an occurrence (paise as text, days as
// "YYYY-MM-DD"), with the state worked out here so every screen says the same thing about a rule.

export type RuleState = "active" | "paused" | "finished" | "blocked"

export interface RuleView {
  id: string
  name: string
  fromNodeId: string
  toNodeId: string
  fromName: string
  toName: string
  /** Paise, as a decimal string. */
  amountPaise: string
  note: string | null
  tags: string[]
  frequency: RecurringRule["frequency"]
  interval: number
  dayOfMonth: number | null
  dayOfWeek: number | null
  startDate: string
  endDate: string | null
  occurrenceLimit: number | null
  autoPost: boolean
  /** The next day an entry will be proposed; null once the schedule has run out. */
  nextDueOn: string | null
  /** Paused by the user; finished (no next day); blocked (an end is archived, so nothing is generated); else active. */
  state: RuleState
  /** "Every 2 weeks on Monday": the cadence in words. */
  scheduleText: string
  /** What an edit must send back as `expectedVersion`. */
  version: number
}

/**
 * The initial values of the rule form when it is opened from a transaction ("Make recurring"): the transaction's own
 * ends, amount, note and tags, repeating monthly from the same day next month. Plain data like the views.
 *
 * `dayOfMonth` is the transaction's own day. The start date is that day next month clamped to the month's length (31 Jan
 * gives 28 Feb), so without the day the form would default it to the clamped one and the rule would drift to the 28th for
 * good; carrying it keeps a month-end rule on the month's end (28 Feb, 31 Mar, 30 Apr).
 */
export interface RuleDraft {
  fromNodeId: string
  toNodeId: string
  /** Paise, as a decimal string. */
  amountPaise: string
  note: string | null
  tags: string[]
  frequency: "MONTHLY"
  interval: 1
  startDate: string
  dayOfMonth: number
  autoPost: false
}

/** The stored rule's schedule, as the domain functions take it. Pure. */
export function scheduleOfRule(rule: RecurringRule): Schedule {
  return {
    frequency: rule.frequency,
    interval: rule.interval,
    dayOfMonth: rule.dayOfMonth,
    dayOfWeek: rule.dayOfWeek,
    startDate: fromDbDate(rule.startDate),
    endDate: rule.endDate === null ? null : fromDbDate(rule.endDate),
    occurrenceLimit: rule.occurrenceLimit,
  }
}

/**
 * `fromNode` and `toNode` are the rule's two ends, archived or not. A pause is the user's decision and wins; a rule with
 * no next day is finished whatever its ends; otherwise an archived end blocks it (it generates nothing until restored).
 * Pure: no reads.
 */
export function toRuleView(rule: RecurringRule, fromNode: LedgerNode, toNode: LedgerNode): RuleView {
  const state: RuleState =
    rule.pausedAt !== null
      ? "paused"
      : rule.nextDueOn === null
        ? "finished"
        : fromNode.archivedAt !== null || toNode.archivedAt !== null
          ? "blocked"
          : "active"
  return {
    id: rule.id,
    name: rule.name,
    fromNodeId: fromNode.id,
    toNodeId: toNode.id,
    fromName: fromNode.name,
    toName: toNode.name,
    amountPaise: serialisePaise(rule.amountPaise),
    note: rule.note,
    tags: [...rule.tags],
    frequency: rule.frequency,
    interval: rule.interval,
    dayOfMonth: rule.dayOfMonth,
    dayOfWeek: rule.dayOfWeek,
    startDate: fromDbDate(rule.startDate),
    endDate: rule.endDate === null ? null : fromDbDate(rule.endDate),
    occurrenceLimit: rule.occurrenceLimit,
    autoPost: rule.autoPost,
    nextDueOn: rule.nextDueOn === null ? null : fromDbDate(rule.nextDueOn),
    state,
    scheduleText: describeSchedule(scheduleOfRule(rule)),
    version: rule.version,
  }
}
