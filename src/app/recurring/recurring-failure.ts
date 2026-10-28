import { failed, redirectIfUnauthenticated, violationFieldErrors, type ActionFailure } from "@/server/action-support"
import { NotFoundError } from "@/server/repositories/errors"
import { RuleVersionConflictError } from "@/server/repositories/recurring-repository"
import { OccurrenceStateError } from "@/server/services/occurrence-service"
import { InvalidRuleError } from "@/server/services/recurring-service"
import { InvalidTransactionError, OverdraftBlockedError } from "@/server/services/transaction-service"

// What an expected refusal of the recurring actions looks like to the screen. Anything else is rethrown for Next to log.

/**
 * Said for every NotFoundError about an occurrence or a rule: a card is acted on from a screen that may be minutes old,
 * so the likeliest reason is that the entry was posted, skipped or its rule deleted in another tab.
 */
export const ENTRY_GONE = "This entry no longer exists. It may have been handled or its rule deleted in another tab."

export const RULE_CHANGED = "This rule was changed somewhere else since you opened it."

/** `InvalidRuleError`'s violations as `{ field: [messages] }`, the shape the form files them under. */
function ruleFieldErrors(error: InvalidRuleError): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const violation of error.violations) (out[violation.field] ??= []).push(violation.message)
  return out
}

export function toRecurringFailure(error: unknown): ActionFailure {
  redirectIfUnauthenticated(error) // throws a redirect, so nothing below runs for a lapsed session
  if (error instanceof InvalidRuleError) return failed("invalid", error.message, ruleFieldErrors(error))
  // A rule is only ever a conflict with a rule: there is no transaction to show beside the user's edit, so the answer is
  // the message alone and the form reloads the rule.
  if (error instanceof RuleVersionConflictError) return failed("version_conflict", RULE_CHANGED)
  if (error instanceof OccurrenceStateError) return failed("invalid", error.message)
  if (error instanceof InvalidTransactionError) {
    const fieldErrors = violationFieldErrors(error.violations)
    return failed("invalid", error.message, Object.keys(fieldErrors).length > 0 ? fieldErrors : undefined)
  }
  if (error instanceof OverdraftBlockedError) return failed("overdraft_blocked", error.message)
  // A node the rule names that is not the user's is a different thing from a vanished entry, and the message must not
  // blame another tab for it.
  if (error instanceof NotFoundError) {
    return failed("not_found", error.entity === "node" ? "That account was not found" : ENTRY_GONE)
  }
  throw error
}
