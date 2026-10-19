// Everything money can come from, sit in, or go to is a ledger node of one of five kinds. A transaction
// is one movement from one node to one node; which kind pairs are legal is spec §5, kept as data.

export type LedgerKind = "INCOME_SOURCE" | "ASSET" | "INVESTMENT" | "EXPENSE" | "LIABILITY"

// Nodes the system creates itself, never the user.
export type SystemNodeRole = "OPENING_BALANCE" | "REALISED_GAIN" | "REALISED_LOSS"

// The 18 allowed (from, to) pairs of spec §5, transcribed row by row (rows are "from").
// Deliberately a literal: it is read against the spec and pinned by an independent test, not derived from a rule.
export const ALLOWED_FLOWS: ReadonlyArray<readonly [LedgerKind, LedgerKind]> = [
  // INCOME_SOURCE: salary, employer PF / ESOP, TDS, income applied straight to a loan
  ["INCOME_SOURCE", "ASSET"],
  ["INCOME_SOURCE", "INVESTMENT"],
  ["INCOME_SOURCE", "EXPENSE"],
  ["INCOME_SOURCE", "LIABILITY"],
  // ASSET: own transfer / ATM, buy / SIP, spend, card bill / EMI
  ["ASSET", "ASSET"],
  ["ASSET", "INVESTMENT"],
  ["ASSET", "EXPENSE"],
  ["ASSET", "LIABILITY"],
  // INVESTMENT: redemption, fund switch, fees / realised loss, redemption applied to a loan
  ["INVESTMENT", "ASSET"],
  ["INVESTMENT", "INVESTMENT"],
  ["INVESTMENT", "EXPENSE"],
  ["INVESTMENT", "LIABILITY"],
  // EXPENSE: refund to an asset, refund onto the card used
  ["EXPENSE", "ASSET"],
  ["EXPENSE", "LIABILITY"],
  // LIABILITY: cash advance / loan disbursal, investing on borrowed money, card spend, balance transfer
  ["LIABILITY", "ASSET"],
  ["LIABILITY", "INVESTMENT"],
  ["LIABILITY", "EXPENSE"],
  ["LIABILITY", "LIABILITY"],
]

export function isFlowAllowed(from: LedgerKind, to: LedgerKind): boolean {
  return ALLOWED_FLOWS.some(([f, t]) => f === from && t === to)
}
