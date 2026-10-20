"use server"

import { revalidatePath } from "next/cache"
import type { z } from "zod"
import type { ViolationCode } from "@/domain/transaction-rules"
import {
  editTransactionSchema,
  listTransactionsSchema,
  recordSplitSchema,
  recordTransactionSchema,
  transactionIdSchema,
} from "@/lib/schemas/transaction"
import type { TransactionPage } from "@/lib/transaction-list-view"
import { toTransactionView, type TransactionView, type Warning } from "@/lib/transaction-view"
import { failed, fieldErrorsOf, ok, redirectIfUnauthenticated, type ActionFailure, type ActionResult } from "@/server/action-support"
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
  ungroupTransaction,
  type TransactionViolation,
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
// Every write ends by invalidating the screens that show money (see `wrote`): the transaction list, the ledger with its
// balances, and the home page. Reads (`listTransactionsAction`) do not.

function parseInput<S extends z.ZodType>(schema: S, input: unknown): { data: z.output<S> } | ActionFailure {
  const parsed = schema.safeParse(input)
  if (parsed.success) return { data: parsed.data }
  return failed("invalid_input", "Check the highlighted fields", fieldErrorsOf(parsed.error))
}

/** Called after a write has committed, so a stale page is never served from the cache. */
function wrote(): void {
  revalidatePath("/transactions")
  revalidatePath("/nodes")
  revalidatePath("/")
}

// The form field a broken rule belongs to. A rule about the pair of nodes or the flow is filed under the destination:
// that is the control a user changes to fix it (the source is what they chose first), and the message names both. An
// archived end is filed under its own control. The source is shared by every leg of a split, so its field has no leg.
const FIELD_OF_VIOLATION: Record<ViolationCode, string> = {
  SAME_NODE: "toNodeId",
  ILLEGAL_FLOW: "toNodeId",
  ARCHIVED_SOURCE: "fromNodeId",
  ARCHIVED_TARGET: "toNodeId",
  NON_POSITIVE_AMOUNT: "amount",
}

/** Violations as `{ field: [messages] }`, a split's under `legs.<index>.<field>` so a form can find the leg's row. */
function violationFieldErrors(violations: readonly TransactionViolation[]): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const violation of violations) {
    const field = FIELD_OF_VIOLATION[violation.code]
    const key = violation.leg === undefined || field === "fromNodeId" ? field : `legs.${violation.leg}.${field}`
    ;(out[key] ??= []).push(violation.message)
  }
  return out
}

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
  try {
    const userId = await requireUserId()
    const parsed = parseInput(editTransactionSchema, input)
    if ("ok" in parsed) return parsed
    const { id, changes, expectedVersion } = parsed.data
    const view = await editTransaction(userId, id, changes, expectedVersion)
    wrote()
    return ok(view)
  } catch (error) {
    return toFailure(error)
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
