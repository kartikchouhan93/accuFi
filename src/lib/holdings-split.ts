import { deserialisePaise } from "@/lib/serialise"

// How what you hold divides between accounts and investments, as two widths in thousandths that always add to 1000, for
// the bar under the net-worth figure. Worked out in integers from the exact paise, so no money value ever passes through
// a float; only the finished share does. Owed is not part of it: net worth subtracts what you owe, so a bar of holdings
// that included it would misrepresent the sum.
//
// Returns null when there is nothing to divide or a part is negative (an overdrawn account), where a bar of shares would
// be meaningless; the card then simply shows no bar.

const MIN_VISIBLE = 8 // a non-zero part never shrinks below 0.8%, or it would vanish from the bar

export interface HoldingsSplit {
  accounts: number
  invested: number
}

export function holdingsSplit(assets: string, investments: string): HoldingsSplit | null {
  const a = deserialisePaise(assets)
  const i = deserialisePaise(investments)
  if (a < 0n || i < 0n || a + i === 0n) return null

  let accounts = Number((a * 1000n) / (a + i))
  if (a > 0n && accounts < MIN_VISIBLE) accounts = MIN_VISIBLE
  if (i > 0n && 1000 - accounts < MIN_VISIBLE) accounts = 1000 - MIN_VISIBLE
  if (a === 0n) accounts = 0
  if (i === 0n) accounts = 1000
  return { accounts, invested: 1000 - accounts }
}
