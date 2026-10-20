import type { ActionErrorCode, ActionFailure } from "@/server/action-support"

// What the screen says for each refusal a node action can give. `switch` over the literal union with no default, so a
// new code in ActionErrorCode fails to compile here until someone has decided what the user should read.

export interface FailureText {
  /** What happened, and what to do about it. */
  message: string
  /** True when the refusal is about the fields the user typed, which the form shows beside each field. */
  isFieldProblem: boolean
}

function textFor(code: ActionErrorCode, serverMessage: string): FailureText {
  switch (code) {
    case "invalid_input":
      return { message: "Check the highlighted fields.", isFieldProblem: true }
    case "system_node":
      return { message: "This is a system node, so it cannot be renamed, archived or deleted.", isFieldProblem: false }
    case "has_history":
      return {
        message: "This has transactions, so it cannot be deleted. Archive it instead: its history stays and it leaves your lists.",
        isFieldProblem: false,
      }
    case "hierarchy_depth":
      return { message: "That is already inside a group, so nothing more can be placed under it.", isFieldProblem: false }
    case "kind_immutable":
      return { message: "The kind of an item cannot be changed once it exists.", isFieldProblem: false }
    case "not_found":
      return { message: "That item no longer exists. Reload to see the current ledger.", isFieldProblem: false }
    case "version_conflict":
    case "overdraft_blocked":
    case "request_conflict":
      // Transaction refusals: a node action cannot give them, and the transaction screens word them themselves.
      return { message: serverMessage, isFieldProblem: false }
    case "invalid":
      // The service words these for the user ("An opening balance cannot be zero").
      return { message: serverMessage, isFieldProblem: false }
  }
}

export function describeFailure(failure: ActionFailure): FailureText {
  return textFor(failure.error.code, failure.error.message)
}
