import type { LucideIcon } from "lucide-react"
import { ArrowDownToLine, CreditCard, ShoppingBag, TrendingUp, Wallet } from "lucide-react"
import type { LedgerKind } from "@/domain/ledger-kind"

// One glyph per kind of node, so a section is recognisable before it is read. Neutral on purpose: colour on this app means
// what money is doing (held, owed), so an icon never borrows it.
export const KIND_ICON: Record<LedgerKind, LucideIcon> = {
  ASSET: Wallet,
  INVESTMENT: TrendingUp,
  LIABILITY: CreditCard,
  INCOME_SOURCE: ArrowDownToLine,
  EXPENSE: ShoppingBag,
}
