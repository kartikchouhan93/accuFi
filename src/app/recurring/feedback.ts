import { formatPaiseText, type BalanceText } from "@/lib/node-money"
import type { ActionFailure, ActionResult } from "@/server/action-support"

// What the Recurring screen's buttons share: calling an action without letting a dropped connection become an unhandled
// rejection, saying what went wrong in one sentence, and the way an amount is shown.

/** The action's answer, or null if the request itself failed (the network, the server). */
export async function attempt<T>(run: () => Promise<ActionResult<T>>): Promise<ActionResult<T> | null> {
  try {
    return await run()
  } catch {
    return null
  }
}

/** "Could not post Rent. This entry no longer exists…": `did` is the verb phrase, `failure` null for a lost request. */
export function couldNot(did: string, failure: ActionFailure | null): string {
  return `Could not ${did}. ${failure ? failure.error.message : "Check your connection and try again."}`
}

/** An amount as the ledger prints it, from paise text. Neutral ink: a rule's amount is neither good nor bad news. */
export function figure(paise: string): BalanceText {
  return { amount: formatPaiseText(paise), qualifier: null, tone: "neutral" }
}
