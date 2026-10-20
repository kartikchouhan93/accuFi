import type { CalendarDate } from "./calendar-date"
import { isFlowAllowed, type LedgerKind, type SystemNodeRole } from "./ledger-kind"
import type { Paise } from "./money"

export interface NodeSummary {
  id: string
  kind: LedgerKind
  archivedAt: Date | null
  systemRole: SystemNodeRole | null
}

export interface TransactionDraft {
  fromNode: NodeSummary
  toNode: NodeSummary
  amount: Paise
  occurredAt: CalendarDate
}

// An archived node is two codes, one per end, because they are two different controls to fix: a form flags the one that is wrong.
export type ViolationCode = "SAME_NODE" | "NON_POSITIVE_AMOUNT" | "ILLEGAL_FLOW" | "ARCHIVED_SOURCE" | "ARCHIVED_TARGET"

export interface RuleViolation {
  code: ViolationCode
  message: string
}

// Returns every violated rule, not just the first, so a form can show them all at once.
// allowArchived exists for editing a historical transaction that already references an archived node (EC-14);
// new entries leave it false.
export function validateTransaction(
  draft: TransactionDraft,
  opts: { allowArchived?: boolean } = {},
): RuleViolation[] {
  const { fromNode, toNode, amount } = draft
  const allowArchived = opts.allowArchived ?? false
  const violations: RuleViolation[] = []

  if (fromNode.id === toNode.id) {
    violations.push({ code: "SAME_NODE", message: "A transaction cannot move money from a node to itself." })
  }
  if (amount <= 0n) {
    violations.push({ code: "NON_POSITIVE_AMOUNT", message: "The amount must be greater than zero." })
  }
  if (!isFlowAllowed(fromNode.kind, toNode.kind)) {
    violations.push({
      code: "ILLEGAL_FLOW",
      message: `Money cannot flow from ${fromNode.kind} to ${toNode.kind}.`,
    })
  }
  if (!allowArchived) {
    if (fromNode.archivedAt !== null) {
      violations.push({ code: "ARCHIVED_SOURCE", message: "The source node is archived." })
    }
    if (toNode.archivedAt !== null) {
      violations.push({ code: "ARCHIVED_TARGET", message: "The target node is archived." })
    }
  }

  return violations
}
