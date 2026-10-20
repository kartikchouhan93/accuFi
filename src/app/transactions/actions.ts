"use server"

import type { z } from "zod"
import { editTransactionSchema, recordTransactionSchema, transactionIdSchema } from "@/lib/schemas/transaction"
import { toTransactionView, type TransactionView } from "@/lib/transaction-view"
import { failed, fieldErrorsOf, ok, redirectIfUnauthenticated, type ActionFailure, type ActionResult } from "@/server/action-support"
import { requireUserId } from "@/server/auth"
import { NotFoundError } from "@/server/repositories/errors"
import { VersionConflictError } from "@/server/repositories/transaction-repository"
import {
  editTransaction,
  InvalidTransactionError,
  OverdraftBlockedError,
  recordTransaction,
  removeTransaction,
  restoreTransaction,
} from "@/server/services/transaction-service"

// Server Actions for the transaction lifecycle, shaped like the node actions: each asks requireUserId() who is calling
// before it reads its input, parses the input with Zod, then calls the service. The input is `unknown` because a Server
// Action is a public endpoint. Results are TransactionView, plain data: money as a paise string, days as "YYYY-MM-DD".
// A bigint or a Date in a result is a runtime crash when Next serialises it, so nothing but a view leaves here, on
// the failure paths too: the row a version conflict carries is converted before it is returned.
//
// Expected refusals come back as `{ ok: false }` so a form can show them; an unexpected error is rethrown for Next to
// log (and mask in production). A missing session redirects to /login.

function parseInput<S extends z.ZodType>(schema: S, input: unknown): { data: z.output<S> } | ActionFailure {
  const parsed = schema.safeParse(input)
  if (parsed.success) return { data: parsed.data }
  return failed("invalid_input", "Check the highlighted fields", fieldErrorsOf(parsed.error))
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
  if (error instanceof InvalidTransactionError) return failed("invalid", error.message)
  if (error instanceof OverdraftBlockedError) return failed("overdraft_blocked", error.message)
  if (error instanceof NotFoundError) return failed("not_found", "That transaction or account was not found")
  throw error
}

export async function recordTransactionAction(input: unknown): Promise<ActionResult<TransactionView>> {
  try {
    const userId = await requireUserId()
    const parsed = parseInput(recordTransactionSchema, input)
    if ("ok" in parsed) return parsed
    return ok(await recordTransaction(userId, parsed.data))
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
    return ok(await editTransaction(userId, id, changes, expectedVersion))
  } catch (error) {
    return toFailure(error)
  }
}

export async function removeTransactionAction(input: unknown): Promise<ActionResult<null>> {
  try {
    const userId = await requireUserId()
    const parsed = parseInput(transactionIdSchema, input)
    if ("ok" in parsed) return parsed
    await removeTransaction(userId, parsed.data.id)
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
    return ok(await restoreTransaction(userId, parsed.data.id))
  } catch (error) {
    return toFailure(error)
  }
}
