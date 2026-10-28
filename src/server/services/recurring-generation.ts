import type { RecurringOccurrence, RecurringRule } from "@prisma/client"
import { addDays, compareDates, fromDbDate, todayIn, type CalendarDate } from "@/domain/calendar-date"
import { datesDue, MAX_DUE_PER_RUN } from "@/domain/recurrence"
import { scheduleOfRule } from "@/lib/recurring-view"
import { findNodeById } from "@/server/repositories/node-repository"
import {
  countOccurrences,
  findDueRules,
  findUsersWithRulesDueBy,
  insertOccurrences,
  lockRule,
  setPostFailure,
  updateRule,
} from "@/server/repositories/recurring-repository"
import { inTransaction } from "@/server/repositories/unit-of-work"
import { todayFor } from "@/server/services/clock"
import { postOccurrence, OccurrenceStateError } from "@/server/services/occurrence-service"
import { InvalidTransactionError, OverdraftBlockedError } from "@/server/services/transaction-service"

// Catch-up generation (design §6). A rule is a standing instruction, and this is the only code that turns one into
// occurrences: PENDING proposals in the inbox, never money. It runs from three places, none of them a page render: the
// hourly sweep, once at startup (both through `sweepAll`), and in the background after a sign-in.
//
// Exactly-once rests on two things. Each rule is generated inside one transaction that first takes the rule's row lock
// (`lockRule`) and then re-reads the rule, so a sweep and a login racing on one rule take turns and the second finds
// nothing due. And the occurrence insert is `ON CONFLICT (ruleId, dueOn) DO NOTHING`, so even a repeat could not
// duplicate a day. Auto-post happens only after the transaction has committed, through `postOccurrence`, whose own key
// (`recurring:<id>`) makes a repeat post a replay.

const GENERIC_POST_FAILURE = "It could not be posted automatically."

interface Generated {
  rule: RecurringRule
  inserted: RecurringOccurrence[]
}

/**
 * Generate one rule's due occurrences, in one transaction. `candidateId` came from `findDueRules` and is only a name:
 * everything is decided from the row as it is once the lock is held. Returns null if there was nothing to do (the rule
 * was deleted, paused or advanced since it was listed, or it touches an archived node, which is left exactly as it is).
 */
async function generateRule(userId: string, candidateId: string, today: CalendarDate): Promise<Generated | null> {
  return inTransaction(async (uow) => {
    const rule = await lockRule(userId, candidateId, uow)
    if (!rule || rule.pausedAt !== null || rule.nextDueOn === null) return null
    const nextDue = fromDbDate(rule.nextDueOn)
    if (compareDates(nextDue, today) > 0) return null

    // A node that is archived (or, impossibly, gone) means the rule generates nothing and nextDueOn stays where it is:
    // when the node is restored, every missed day catches up like any other downtime.
    const [from, to] = await Promise.all([
      findNodeById(userId, rule.fromNodeId, uow),
      findNodeById(userId, rule.toNodeId, uow),
    ])
    if (!from || !to || from.archivedAt !== null || to.archivedAt !== null) return null

    const schedule = scheduleOfRule(rule)
    const existing = await countOccurrences(userId, rule.id, uow)
    const due = datesDue(schedule, { from: nextDue, count: existing, upTo: today, max: MAX_DUE_PER_RUN })
    const inserted = await insertOccurrences(userId, rule.id, due, uow)

    // The next date comes from the day after the last one generated (or, if none was due, from where the rule stood),
    // counting what the rule has now. No date at all means the schedule is over: the limit is spent, or the end date
    // is behind it (an edit can do that), so it is cleared rather than left due for ever.
    const after = due.length > 0 ? addDays(due[due.length - 1], 1) : nextDue
    const count = await countOccurrences(userId, rule.id, uow)
    const next = datesDue(schedule, { from: after, count, max: 1 })[0] ?? null
    const unchanged = next === nextDue
    if (!unchanged) await updateRule(userId, rule.id, rule.version, { nextDueOn: next }, uow)
    return { rule, inserted }
  })
}

/** The words an auto-post failure is shown with: the service's own for a refusal it makes, a generic one otherwise. */
function postFailureText(error: unknown): string {
  if (
    error instanceof InvalidTransactionError ||
    error instanceof OverdraftBlockedError ||
    error instanceof OccurrenceStateError
  ) {
    return error.message
  }
  console.error("[recurring] auto-post failed", error)
  return GENERIC_POST_FAILURE
}

/** Post each occurrence, leaving any that cannot be posted PENDING with the reason. Returns how many were posted. */
async function autoPost(userId: string, occurrences: RecurringOccurrence[]): Promise<number> {
  let posted = 0
  for (const occurrence of occurrences) {
    try {
      await postOccurrence(userId, occurrence.id)
      posted++
    } catch (error) {
      const text = postFailureText(error)
      try {
        await setPostFailure(userId, occurrence.id, text)
      } catch (writeError) {
        console.error("[recurring] could not record why an auto-post failed", writeError)
      }
    }
  }
  return posted
}

/**
 * Create the occurrences this user's rules have come due for, up to the user's own today (their timezone, so a user
 * ahead of or behind UTC is never run early or late), at most 100 per rule per call; a longer gap is caught up by the
 * next call. Returns how many were created and, for `autoPost` rules, how many of those were posted.
 *
 * Each rule stands alone: one that throws (a deadlock, a constraint, a bad row) is logged and left as it was, still due,
 * and the user's other rules carry on, so a single bad rule cannot starve the rest on every run. What the others
 * achieved is counted. Reading today or the user's rules failing is not a rule's failure, and still throws.
 */
export async function generateDue(userId: string): Promise<{ created: number; posted: number }> {
  const today = await todayFor(userId)
  let created = 0
  let posted = 0
  for (const candidate of await findDueRules(userId, today)) {
    try {
      const generated = await generateRule(userId, candidate.id, today)
      if (!generated) continue
      created += generated.inserted.length
      if (generated.rule.autoPost) posted += await autoPost(userId, generated.inserted)
    } catch (error) {
      console.error(`[recurring-sweep] generation failed for rule ${candidate.id}`, error)
    }
  }
  return { created, posted }
}

/**
 * The hourly sweep: `generateDue` for every user with a rule due by UTC today plus one day (the coarse bound, which
 * covers a user as far ahead as UTC+14; `generateDue` then applies each user's own today). Users run one after another,
 * and one user's failure is logged without stopping the rest.
 */
export async function sweepAll(): Promise<void> {
  const through = addDays(todayIn("UTC"), 1)
  for (const userId of await findUsersWithRulesDueBy(through)) {
    try {
      await generateDue(userId)
    } catch (error) {
      console.error("[recurring-sweep] generation failed for a user", error)
    }
  }
}

/** Fire and forget, for the sign-in event: returns at once and never throws, so it cannot slow or fail a sign-in. */
export function generateInBackground(userId: string): void {
  void generateDue(userId).catch((error: unknown) => {
    console.error("[recurring] background generation failed", error)
  })
}
