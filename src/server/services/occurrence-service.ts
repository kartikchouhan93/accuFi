import type { RecurringOccurrence } from "@prisma/client"
import type { CalendarDate } from "@/domain/calendar-date"
import { fromDbDate } from "@/domain/calendar-date"
import type { Paise } from "@/domain/money"
import type { Quantity } from "@/domain/quantity"
import { toOccurrenceView, type OccurrenceView } from "@/lib/recurring-view"
import { NotFoundError } from "@/server/repositories/errors"
import {
  findOccurrenceById,
  markDismissed,
  markPending,
  markPosted,
  type OccurrenceWithRule,
} from "@/server/repositories/recurring-repository"
import { recordTransaction, requireNode } from "@/server/services/transaction-service"

// Confirm, skip and put back an occurrence (spec §7). An occurrence is a proposal, never money: posting is what turns it
// into a transaction, through the same `recordTransaction` every other entry goes through (so the flow rules, the
// overdraft guard, the archived-node refusal and the lot rules all apply), keyed `recurring:<occurrenceId>`. That key is
// the exactly-once guarantee: two posts of one occurrence, a double click or two tabs, reach the same transaction, and
// the conditional update that marks the occurrence POSTED lets only one of them be the marker; the other re-reads.
//
// An occurrence of a soft-deleted rule is NotFound here, in all three operations. The repository's state changes do not
// look at the rule, so this is the one place that stops a skipped occurrence of a deleted rule being put back.

/** The occurrence is in a state that does not allow this: posting a skipped one, skipping or restoring a posted one. */
export class OccurrenceStateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "OccurrenceStateError"
  }
}

export interface PostOverrides {
  amount?: Paise
  occurredAt?: CalendarDate
  /** `null` clears the rule's note; left out keeps it. */
  note?: string | null
  /** Required when the destination is an investment valued by quantity. */
  quantity?: Quantity
}

const POSTED_AFTER_SKIP = "Put it back before posting it."

/** The occurrence and its rule, or NotFoundError if it is not the user's or its rule has been deleted. */
async function load(userId: string, id: string): Promise<OccurrenceWithRule> {
  const found = await findOccurrenceById(userId, id)
  if (!found || found.rule.deletedAt !== null) throw new NotFoundError("occurrence")
  return found
}

async function viewOf(userId: string, occurrence: RecurringOccurrence, found: OccurrenceWithRule): Promise<OccurrenceView> {
  const [from, to] = await Promise.all([requireNode(userId, found.rule.fromNodeId), requireNode(userId, found.rule.toNodeId)])
  return toOccurrenceView(occurrence, found.rule, from, to)
}

/**
 * Record the rule's current template for this occurrence (the overrides replacing what they name; the day defaults to the
 * due day) and mark it posted. An occurrence already posted answers with its posted view, so a retry is a replay. Whatever
 * `recordTransaction` refuses (archived node, overdraft, a missing quantity) is thrown as it is and leaves the occurrence
 * PENDING with nothing written. Throws OccurrenceStateError for a skipped one, NotFoundError for one that is not the
 * user's or belongs to a deleted rule.
 */
export async function postOccurrence(userId: string, id: string, overrides: PostOverrides = {}): Promise<OccurrenceView> {
  const found = await load(userId, id)
  if (found.status === "POSTED") return viewOf(userId, found, found)
  if (found.status === "DISMISSED") throw new OccurrenceStateError(POSTED_AFTER_SKIP)

  const { rule } = found
  const note = overrides.note !== undefined ? overrides.note : rule.note
  const transaction = await recordTransaction(userId, {
    fromNodeId: rule.fromNodeId,
    toNodeId: rule.toNodeId,
    amount: overrides.amount ?? rule.amountPaise,
    occurredAt: overrides.occurredAt ?? fromDbDate(found.dueOn),
    quantity: overrides.quantity,
    note: note ?? undefined,
    tags: [...rule.tags],
    idempotencyKey: `recurring:${found.id}`,
  })

  const marked = await markPosted(userId, found.id, transaction.id)
  if (marked) return viewOf(userId, marked, found)
  // Not pending any more: someone else posted it first (they hold the same transaction, the key replayed), or it was
  // skipped or its rule deleted while this call was recording. The first is the answer; the others are told.
  const current = await load(userId, found.id)
  if (current.status === "POSTED") return viewOf(userId, current, current)
  throw new OccurrenceStateError("This entry was skipped while you were posting it. Put it back to post it again.")
}

/** Skip: PENDING to DISMISSED. Already skipped answers with itself; a posted one throws OccurrenceStateError. */
export async function dismissOccurrence(userId: string, id: string): Promise<OccurrenceView> {
  const found = await load(userId, id)
  if (found.status === "POSTED") throw new OccurrenceStateError("It is already posted, so it cannot be skipped.")
  if (found.status === "DISMISSED") return viewOf(userId, found, found)

  const marked = await markDismissed(userId, found.id)
  if (marked) return viewOf(userId, marked, found)
  const current = await load(userId, found.id) // changed under us: a concurrent skip is the same answer, a post is not
  if (current.status === "DISMISSED") return viewOf(userId, current, current)
  throw new OccurrenceStateError("It is already posted, so it cannot be skipped.")
}

/** Put back: DISMISSED to PENDING. Already pending answers with itself; a posted one throws OccurrenceStateError. */
export async function restoreOccurrence(userId: string, id: string): Promise<OccurrenceView> {
  const found = await load(userId, id)
  if (found.status === "POSTED") throw new OccurrenceStateError("It is already posted, so there is nothing to put back.")
  if (found.status === "PENDING") return viewOf(userId, found, found)

  const marked = await markPending(userId, found.id)
  if (marked) return viewOf(userId, marked, found)
  const current = await load(userId, found.id)
  if (current.status === "PENDING") return viewOf(userId, current, current)
  throw new OccurrenceStateError("It is already posted, so there is nothing to put back.")
}
