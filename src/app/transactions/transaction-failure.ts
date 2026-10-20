import type { ActionErrorCode, ActionFailure } from "@/server/action-support"
import type { FailureText } from "@/app/nodes/node-failure"

// What the transaction screen says for each refusal an action can give. A `switch` over the literal union with no
// default, as for the node screen, so a new code in ActionErrorCode fails to compile here until someone has decided
// what the user should read.

function textFor(code: ActionErrorCode, serverMessage: string, hasFieldErrors: boolean): FailureText {
  switch (code) {
    case "invalid_input":
      return { message: "Check the highlighted fields.", isFieldProblem: true }
    case "invalid":
      // The service words these for the user ("Money cannot flow from an account to an income source"). When the action could
      // place them on a field they are shown beside it; otherwise the whole sentence is shown once.
      return { message: serverMessage, isFieldProblem: hasFieldErrors }
    case "overdraft_blocked":
      return { message: `${serverMessage} Nothing was recorded.`, isFieldProblem: false }
    case "not_found":
      return { message: "That transaction or account no longer exists. Reload the page to see the current ledger.", isFieldProblem: false }
    case "version_conflict":
      return { message: serverMessage, isFieldProblem: false }
    case "request_conflict":
      return { message: serverMessage, isFieldProblem: false }
    case "system_node":
    case "has_history":
    case "hierarchy_depth":
    case "kind_immutable":
      // Refusals only a node action gives. A transaction action cannot, so there is nothing better than the server's own words.
      return { message: serverMessage, isFieldProblem: false }
  }
}

export function describeTransactionFailure(failure: ActionFailure): FailureText {
  const { code, message, fieldErrors } = failure.error
  return textFor(code, message, fieldErrors !== undefined && Object.keys(fieldErrors).length > 0)
}
