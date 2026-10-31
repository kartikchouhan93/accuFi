import { failed, redirectIfUnauthenticated, type ActionFailure } from "@/server/action-support"
import { NotFoundError } from "@/server/repositories/errors"
import { InvalidBudgetError } from "@/server/services/budget-service"

// What an expected refusal of the budget actions looks like to the screen. Anything else is rethrown for Next to log.

/**
 * Said for every NotFoundError about a budget: a screen can be minutes old, so the likeliest reason is that the budget
 * was deleted in another tab.
 */
export const BUDGET_GONE = "This budget no longer exists. It may have been deleted in another tab."

/** `InvalidBudgetError`'s violations as `{ field: [messages] }`, the shape the form files them under. */
function budgetFieldErrors(error: InvalidBudgetError): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const violation of error.violations) (out[violation.field] ??= []).push(violation.message)
  return out
}

export function toBudgetFailure(error: unknown): ActionFailure {
  redirectIfUnauthenticated(error) // throws a redirect, so nothing below runs for a lapsed session
  if (error instanceof InvalidBudgetError) return failed("invalid", error.message, budgetFieldErrors(error))
  // A ledger the form names that is not the user's is a different thing from a vanished budget, and the message must not
  // blame another tab for it.
  if (error instanceof NotFoundError) {
    return failed("not_found", error.entity === "node" ? "That ledger was not found" : BUDGET_GONE)
  }
  throw error
}
