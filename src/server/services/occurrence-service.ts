import type { RecurringOccurrence } from "@prisma/client"
import type { CalendarDate } from "@/domain/calendar-date"
import { fromDbDate } from "@/domain/calendar-date"
import type { Paise } from "@/domain/money"
import type { Quantity } from "@/domain/quantity"
import { toOccurrenceView, type OccurrenceView, type PostedSnapshot } from "@/lib/recurring-view"
import { toTransactionView } from "@/lib/transaction-view"
import { NotFoundError } from "@/server/repositories/errors"
import {
  findOccurrenceById,
  markDismissed,
  markPending,
  markPosted,
  type OccurrenceWithRule,
} from "@/server/repositories/recurring-repository"
import { findTransactionById, findTransactionsByIdempotencyKeys } from "@/server/repositories/transaction-repository"
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
const RECORDED_BEFORE_SKIP =
  "It was recorded before the skip landed: check Transactions. Putting it back and posting again will not record it twice."
const RECORDED_BEFORE_DELETE = "It was recorded before the rule was deleted: check Transactions. The entry itself is gone."

/** The occurrence and its rule, or NotFoundError if it is not the user's or its rule has been deleted. */
async function load(userId: string, id: string): Promise<OccurrenceWithRule> {
  const found = await findOccurrenceById(userId, id)
  if (!found || found.rule.deletedAt !== null) throw new NotFoundError("occurrence")
  return found
}

/**
 * The view of `occurrence`. A PENDING or DISMISSED one shows the rule's current template and ends. A POSTED one shows what
 * was recorded: `posted` when the caller has the transaction it just made, otherwise the stored transaction (found by id,
 * or, if it has since been deleted, by its key, which a deleted row keeps), so a later edit of the rule never rewrites
 * what the card says was posted. Only an occurrence whose transaction cannot be found at all falls back to the rule.
 */
async function viewOf(
  userId: string,
  occurrence: RecurringOccurrence,
  found: OccurrenceWithRule,
  posted?: PostedSnapshot,
): Promise<OccurrenceView> {
  let snapshot = posted
  if (!snapshot && occurrence.status === "POSTED") {
    const row =
      (occurrence.transactionId ? await findTransactionById(userId, occurrence.transactionId) : null) ??
      (await findTransactionsByIdempotencyKeys(userId, [`recurring:${occurrence.id}`]))[0]
    if (row) snapshot = toTransactionView(row)
  }
  const [from, to] = await Promise.all([
    requireNode(userId, snapshot?.fromNodeId ?? found.rule.fromNodeId),
    requireNode(userId, snapshot?.toNodeId ?? found.rule.toNodeId),
  ])
  return toOccurrenceView(occurrence, found.rule, from, to, snapshot)
}

/**
 * Record the rule's current template for this occurrence (the overrides replacing what they name; the day defaults to the
 * due day) and mark it posted. An occurrence already posted answers with its posted view, so a retry is a replay. Whatever
 * `recordTransaction` refuses (archived node, overdraft, a missing quantity) is thrown as it is and leaves the occurrence
 * PENDING with nothing written. Throws OccurrenceStateError for a skipped one, NotFoundError for one that is not the
 * user's or belongs to a deleted rule. A skip or a delete that lands after the transaction was recorded but before the
 * occurrence was marked is an OccurrenceStateError that says the transaction WAS recorded.
 *
 * First write wins: a replay (an occurrence already POSTED, or a key that already has a transaction) returns the FIRST
 * result and ignores the overrides it was given. The view of a posted occurrence is the recorded transaction's.
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
  if (marked) return viewOf(userId, marked, found, transaction)
  // Not pending any more, and the transaction above is already committed. Someone else posted it first (they hold the same
  // transaction, the key replayed): that is the answer. Or it was skipped, or its rule deleted, while this call was
  // recording: the transaction EXISTS either way, so the user is told it was recorded and where to look, never that
  // nothing happened. Putting a skipped one back and posting again replays the same key, so it is not recorded twice.
  const current = await load(userId, found.id).catch((error: unknown) => {
    if (error instanceof NotFoundError) throw new OccurrenceStateError(RECORDED_BEFORE_DELETE)
    throw error
  })
  if (current.status === "POSTED") return viewOf(userId, current, current)
  throw new OccurrenceStateError(RECORDED_BEFORE_SKIP)
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

  // Known and harmless: if the rule is deleted between the load above and this write, a PENDING orphan is left behind
  // (the repository's state changes do not look at the rule). `findPending` only lists occurrences of live rules, so
  // it is never shown, and nothing can post it: `load` refuses an occurrence of a deleted rule.
  const marked = await markPending(userId, found.id)
  if (marked) return viewOf(userId, marked, found)
  const current = await load(userId, found.id)
  if (current.status === "PENDING") return viewOf(userId, current, current)
  throw new OccurrenceStateError("It is already posted, so there is nothing to put back.")
}
