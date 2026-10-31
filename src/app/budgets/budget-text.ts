import { deserialisePaise } from "@/lib/serialise"

// The few pieces of text and size the Budgets screen derives from a card's figures. All of it reads paise text through
// BigInt, never Number: an amount of any size gives the same answer to the digit.

/** "84.6%" for 846 tenths of a percent; null when there is no percent to show. */
export function percentText(tenths: string | null): string | null {
  if (tenths === null) return null
  const value = BigInt(tenths)
  const magnitude = value < 0n ? -value : value
  return `${value < 0n ? "-" : ""}${magnitude / 10n}.${magnitude % 10n}%`
}

/**
 * How full the bar is, as a percent of its track in text ("84.6", "100", "0"): used over available, clamped to 0 and 100
 * and rounded down to a tenth. A net refund (used below zero) is empty. Spending against nothing available is full.
 * Only the bar is clamped; the figures beside it are not.
 */
export function barWidth({ usedPaise, availablePaise }: { usedPaise: string; availablePaise: string }): string {
  const used = deserialisePaise(usedPaise)
  const available = deserialisePaise(availablePaise)
  if (used <= 0n) return "0"
  if (available <= 0n) return "100"
  const tenths = (used * 1000n) / available
  if (tenths >= 1000n) return "100"
  return tenths % 10n === 0n ? String(tenths / 10n) : `${tenths / 10n}.${tenths % 10n}`
}

/** The magnitude of a paise amount, as paise text. */
export function absolutePaise(paise: string): string {
  return paise.startsWith("-") ? paise.slice(1) : paise
}
