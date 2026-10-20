import type { LedgerKind } from "../domain/ledger-kind"

// How each kind is named to the person using the app. The code says "node" and "ASSET"; the screen says "account"
// and "Accounts". Typed on LedgerKind, so a sixth kind is a compile error here until it has words.

export interface KindCopy {
  /** The section heading. */
  plural: string
  /** The form's radio label, and the noun in the form's submit button. */
  singular: string
  /** "an account": with the article, for sentences ("You already have an account called ..."). */
  indefinite: string
  /** A line under the kind in the form, saying what belongs there. */
  hint: string
  /** The form's submit button. */
  addLabel: string
  /** Shown in an empty section. */
  empty: string
}

export const KIND_COPY: Record<LedgerKind, KindCopy> = {
  ASSET: {
    plural: "Accounts",
    singular: "Account",
    indefinite: "an account",
    hint: "Bank accounts, cash and wallets",
    addLabel: "Add account",
    empty: "No accounts yet.",
  },
  INVESTMENT: {
    plural: "Investments",
    singular: "Investment",
    indefinite: "an investment",
    hint: "Funds, shares, gold, property",
    addLabel: "Add investment",
    empty: "No investments yet.",
  },
  LIABILITY: {
    plural: "Liabilities",
    singular: "Liability",
    indefinite: "a liability",
    hint: "Credit cards and loans",
    addLabel: "Add liability",
    empty: "No credit cards or loans.",
  },
  INCOME_SOURCE: {
    plural: "Income",
    singular: "Income source",
    indefinite: "an income source",
    hint: "Salary, interest, anyone who pays you",
    addLabel: "Add income source",
    empty: "No income sources yet.",
  },
  EXPENSE: {
    plural: "Expenses",
    singular: "Expense category",
    indefinite: "an expense category",
    hint: "Where your money goes",
    addLabel: "Add expense category",
    empty: "No expense categories yet.",
  },
}

/**
 * The order of the sections, and of the form's radios: what you hold first (these are the kinds net worth is made of),
 * then the two kinds money only passes through.
 */
export const KIND_ORDER = ["ASSET", "INVESTMENT", "LIABILITY", "INCOME_SOURCE", "EXPENSE"] as const satisfies readonly LedgerKind[]

/** The kinds that hold a balance. Income and expense nodes only record flow, so their rows show a flow, not a balance. */
export const HOLDING_KINDS: ReadonlySet<LedgerKind> = new Set(["ASSET", "INVESTMENT", "LIABILITY"])
