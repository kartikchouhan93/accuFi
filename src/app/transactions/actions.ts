"use server"

import { InsufficientQuantityError } from "@/domain/lots"
import {
  editTransactionSchema,
  listTransactionsSchema,
  recordSplitSchema,
  recordTransactionSchema,
  transactionIdSchema,
} from "@/lib/schemas/transaction"
import type { TransactionPage } from "@/lib/transaction-list-view"
import { toTransactionView, type TransactionView, type Warning } from "@/lib/transaction-view"
import {
  failed,
  ok,
  parseInput,
  redirectIfUnauthenticated,
  violationFieldErrors,
  wrote,
  type ActionFailure,
  type ActionResult,
} from "@/server/action-support"
import { requireUserId } from "@/server/auth"
import { InvalidCursorError, NotFoundError } from "@/server/repositories/errors"
import { VersionConflictError } from "@/server/repositories/transaction-repository"
import { loadTransactionPage } from "@/server/services/transaction-list"
import {
  editTransaction,
  InvalidTransactionError,
  OverdraftBlockedError,
  recordSplit,
  recordTransaction,
  removeTransaction,
  RequestKeyConflictError,
  restoreTransaction,
  SplitTotalMismatchError,
  storedViewOf,
  ungroupTransaction,
} from "@/server/services/transaction-service"

// Server Actions for the transaction lifecycle, shaped like the node actions: each asks requireUserId() who is calling
// before it reads its input, parses the input with Zod, then calls the service. The input is `unknown` because a Server
// Action is a public endpoint. Results are plain data: money as a paise string, days as "YYYY-MM-DD". A bigint or a Date
// in a result is a runtime crash when Next serialises it, so nothing but views leaves here, on the failure paths too:
// the row a version conflict carries is converted before it is returned.
//
// Expected refusals come back as `{ ok: false }` so a form can show them; an unexpected error is rethrown for Next to
// log (and mask in production). A missing session redirects to /login.
//
// Every write ends by invalidating the screens that show money (`wrote`, in action-support.ts, shared with the node
// actions). Reads (`listTransactionsAction`) do not.

function toFailure(error: unknown): ActionFailure {
  redirectIfUnauthenticated(error) // throws a redirect, so nothing below runs for a lapsed session
  if (error instanceof VersionConflictError) {
    return {
      ok: false,
      error: {
        code: "version_conflict",
        message: "This transaction was changed somewhere else since you opened it",
        current: toTransactionView(error.current),
      },
    }
  }
  // Before InvalidTransactionError, which it extends. The service's own wording ("already used for a different request")
  // is also what a user meets after taking a leg out of a split and sending the form again, when the earlier request did
  // succeed, so the screen is told in words that are true for both.
  if (error instanceof RequestKeyConflictError) {
    return failed(
      "request_conflict",
      "This form was already sent once, and what you are sending now is different. The first one may have been recorded, so check the list. If it is not there, clear the form and enter it again.",
    )
  }
  if (error instanceof InvalidTransactionError) {
    const fieldErrors = violationFieldErrors(error.violations)
    return failed("invalid", error.message, Object.keys(fieldErrors).length > 0 ? fieldErrors : undefined)
  }
  // Restoring a sale whose lots no longer hold what it took (the service words it, naming the quantity in units). It is
  // about the request as a whole, not a field: the fix is elsewhere (delete the later sale, restore the purchase).
  if (error instanceof InsufficientQuantityError) return failed("insufficient_quantity", error.message)
  if (error instanceof SplitTotalMismatchError) return failed("invalid", error.message, { total: [error.message] })
  if (error instanceof OverdraftBlockedError) return failed("overdraft_blocked", error.message)
  if (error instanceof NotFoundError) return failed("not_found", "That transaction or account was not found")
  if (error instanceof InvalidCursorError) return failed("invalid", "That page of the list is no longer valid. Reload the page.")
  throw error
}

export async function recordTransactionAction(input: unknown): Promise<ActionResult<TransactionView>> {
  try {
    const userId = await requireUserId()
    const parsed = parseInput(recordTransactionSchema, input)
    if ("ok" in parsed) return parsed
    const view = await recordTransaction(userId, parsed.data)
    wrote()
    return ok(view)
  } catch (error) {
    return toFailure(error)
  }
}

/**
 * What recording a split gives back. Every leg of a split carries the same warnings (each is one of the writes that left
 * the source in that state), so they are reported once, here, and the legs' own lists are emptied: a screen that
 * flat-mapped the legs would show every warning once per leg.
 */
export interface SplitResult {
  legs: TransactionView[]
  warnings: Warning[]
}

/** The schema requires `total`, so the legs-add-up check always runs: a client cannot skip it by leaving it out. */
export async function recordSplitAction(input: unknown): Promise<ActionResult<SplitResult>> {
  try {
    const userId = await requireUserId()
    const parsed = parseInput(recordSplitSchema, input)
    if ("ok" in parsed) return parsed
    const views = await recordSplit(userId, parsed.data)
    wrote()
    return ok({ legs: views.map((view) => ({ ...view, warnings: [] })), warnings: views[0]?.warnings ?? [] })
  } catch (error) {
    return toFailure(error)
  }
}

export async function editTransactionAction(input: unknown): Promise<ActionResult<TransactionView>> {
  let userId: string | null = null
  try {
    userId = await requireUserId()
    const parsed = parseInput(editTransactionSchema, input)
    if ("ok" in parsed) return parsed
    const { id, changes, expectedVersion } = parsed.data
    const view = await editTransaction(userId, id, changes, expectedVersion)
    wrote()
    return ok(view)
  } catch (error) {
    const failure = toFailure(error)
    // The form offers to take up the stored version whole, so a purchase's comes with what its lot holds now. That is a
    // second read: if it fails, the conflict is still answered, with the row as stored and no quantity.
    if (userId !== null && error instanceof VersionConflictError) {
      const current = await storedViewOf(userId, error.current).catch(() => null)
      if (current !== null) return { ok: false, error: { ...failure.error, current } }
    }
    return failure
  }
}

/** Removes the transaction, and the rest of its split if it is in one: one click, N rows (see removeTransaction). */
export async function removeTransactionAction(input: unknown): Promise<ActionResult<null>> {
  try {
    const userId = await requireUserId()
    const parsed = parseInput(transactionIdSchema, input)
    if ("ok" in parsed) return parsed
    await removeTransaction(userId, parsed.data.id)
    wrote()
    return ok(null)
  } catch (error) {
    return toFailure(error)
  }
}

export async function restoreTransactionAction(input: unknown): Promise<ActionResult<TransactionView>> {
  try {
    const userId = await requireUserId()
    const parsed = parseInput(transactionIdSchema, input)
    if ("ok" in parsed) return parsed
    const view = await restoreTransaction(userId, parsed.data.id)
    wrote()
    return ok(view)
  } catch (error) {
    return toFailure(error)
  }
}

export async function ungroupTransactionAction(input: unknown): Promise<ActionResult<TransactionView>> {
  try {
    const userId = await requireUserId()
    const parsed = parseInput(transactionIdSchema, input)
    if ("ok" in parsed) return parsed
    const view = await ungroupTransaction(userId, parsed.data.id)
    wrote()
    return ok(view)
  } catch (error) {
    return toFailure(error)
  }
}

/** The next page of the list under the same filters; `cursor` is the `nextCursor` of the page before. */
export async function listTransactionsAction(input: unknown): Promise<ActionResult<TransactionPage>> {
  try {
    const userId = await requireUserId()
    const parsed = parseInput(listTransactionsSchema, input)
    if ("ok" in parsed) return parsed
    const { cursor, ...filter } = parsed.data
    return ok(await loadTransactionPage(userId, filter, cursor))
  } catch (error) {
    return toFailure(error)
  }
}
