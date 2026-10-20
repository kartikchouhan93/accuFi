import type { LedgerKind } from "../domain/ledger-kind"
import { formatPaise, MoneyParseError, parseRupees } from "../domain/money"
import { deserialisePaise } from "./serialise"

// How a node's figure reads on screen. Props and Server Action results carry paise as decimal strings (a bigint cannot
// be serialised), so this is where a string is read back into a number, only to be turned straight into text again.
// Nothing here returns or stores a bigint.
//
// The sign convention (spec §4.2) is that every balance is inflows minus outflows, so a liability you owe on is
// NEGATIVE. This file is the one place that turns that into words. A liability is shown as the magnitude with "owed"
// (negated here, exactly once; the net worth total already added the negative figure and is never touched), and an
// income source as the magnitude received, which is the negation of its balance for the same reason.

export type Tone = "positive" | "negative" | "neutral" | "muted"

export interface BalanceText {
  /** "₹1,25,000.50", or "-₹2,000.00" for an overdrawn account. */
  amount: string
  /** A word that says what the figure is: "owed", "received", "spent". Null when the figure speaks for itself. */
  qualifier: string | null
  tone: Tone
}

/** "₹1,23,456.78" from paise text. */
export function formatPaiseText(paise: string): string {
  return formatPaise(deserialisePaise(paise))
}

/** The balance of a node of `kind`, as the figure and wording its row shows. */
export function describeBalance(kind: LedgerKind, paise: string): BalanceText {
  const balance = deserialisePaise(paise)
  if (balance === 0n) return { amount: formatPaise(0n), qualifier: null, tone: "muted" }
  switch (kind) {
    case "ASSET":
    case "INVESTMENT":
      return { amount: formatPaise(balance), qualifier: null, tone: balance < 0n ? "negative" : "neutral" }
    case "LIABILITY":
      return balance < 0n
        ? { amount: formatPaise(-balance), qualifier: "owed", tone: "negative" }
        : { amount: formatPaise(balance), qualifier: "in credit", tone: "positive" }
    case "INCOME_SOURCE":
      return { amount: formatPaise(-balance), qualifier: "received", tone: "neutral" }
    case "EXPENSE":
      return { amount: formatPaise(balance), qualifier: "spent", tone: "neutral" }
  }
}

/**
 * What a holding node still has in it, as a phrase that follows its name ("HDFC Savings still holds ₹5,000.00"), or
 * null when there is nothing to warn about: a zero balance, or a kind that only records flow.
 */
export function describeResidual(kind: LedgerKind, paise: string): string | null {
  const balance = deserialisePaise(paise)
  if (balance === 0n) return null
  switch (kind) {
    case "ASSET":
      return balance < 0n ? `is still overdrawn by ${formatPaise(-balance)}` : `still holds ${formatPaise(balance)}`
    case "INVESTMENT":
      return `still holds ${formatPaise(balance)}`
    case "LIABILITY":
      return balance < 0n ? `still has ${formatPaise(-balance)} owed` : `is still ${formatPaise(balance)} in credit`
    case "INCOME_SOURCE":
    case "EXPENSE":
      return null
  }
}

/**
 * The opening balance as the form will send it, in words, for the person typing: which way the sign goes is the
 * thing a user cannot be left to guess. `amountText` is the unsigned amount. Null while it is not a usable amount.
 */
export function describeOpening(
  kind: "ASSET" | "LIABILITY",
  direction: "positive" | "negative",
  amountText: string,
): string | null {
  let paise: bigint
  try {
    paise = parseRupees(amountText)
  } catch (error) {
    if (error instanceof MoneyParseError) return null
    throw error
  }
  if (paise <= 0n) return null // zero is refused by the server, and a typed sign is refused by the form
  const shown = formatPaise(paise)
  if (kind === "ASSET") return direction === "positive" ? `You hold ${shown} in this account` : `You owe ${shown} on this account`
  return direction === "negative" ? `You owe ${shown} on this liability` : `You are ${shown} in credit on this liability`
}
