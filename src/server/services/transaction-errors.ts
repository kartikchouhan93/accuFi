import type { RuleViolation, ViolationCode } from "@/domain/transaction-rules"

// The refusals of the transaction write path, in a module of their own so that both the transaction service and the
// lot rules (lot-rules.ts, which the sale path uses too) can throw them without importing each other. The transaction
// service re-exports every name here, so callers keep importing them from there.

/** The lot rules the services add to the domain's flow rules; each belongs to one form field (see the actions). */
export type LotRuleCode =
  | "QUANTITY_REQUIRED"
  | "QUANTITY_NOT_APPLICABLE"
  | "QUANTITY_OUT_OF_RANGE"
  | "LUMP_QUANTITY"
  | "LUMP_ALREADY_BOUGHT"
  | "LOT_SOURCE"
  | "LOT_SWITCH"
  | "LOT_SPLIT_LEG"
  | "LOT_SOLD"
  | "QUANTITY_BELOW_SOLD"
  | "AMOUNT_BELOW_SOLD"
  | "SOLD_COST_CHANGED"
  | "DATE_AFTER_SALE"

export type TransactionViolationCode = ViolationCode | LotRuleCode

/**
 * A rule the request broke. For a split, `leg` is the zero-based position in `legs` of the leg that broke it, so a form
 * can put the problem on that leg's row without reading the message; it is absent for a single transaction.
 */
export interface TransactionViolation extends Omit<RuleViolation, "code"> {
  code: TransactionViolationCode
  leg?: number
}

/** The request breaks a transaction rule. The message is the domain's own, safe to show the user. */
export class InvalidTransactionError extends Error {
  constructor(
    message: string,
    readonly violations: TransactionViolation[] = [],
  ) {
    super(message)
    this.name = "InvalidTransactionError"
  }
}

/**
 * The purchase's lot is still needed by a sale: deleting the purchase, or moving it to another investment, would leave
 * the sale taking from a lot that is not there. Delete the sale first. A subclass, so everything that handles
 * InvalidTransactionError still does. Nothing was written.
 */
export class LotInUseError extends InvalidTransactionError {
  constructor(message: string, violations: TransactionViolation[] = []) {
    super(message, violations)
    this.name = "LotInUseError"
  }
}
