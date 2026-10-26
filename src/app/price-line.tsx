import { Tag } from "@/components/ui/tag"
import type { PriceState } from "@/lib/investment-view"
import { formatDay } from "@/lib/transaction-text"
import { cn } from "@/lib/utils"

// The day of the price behind an investment's value, beside that value, so a figure from an old price never passes for
// today's (spec §7.3, EC-24): "as of 1 Mar 2026", and a Stale label once the price is older than the investment's window.
// An element of its own, after the value, so the name and the figure keep their own elements.
export function PriceLine({ priced, className }: { priced: PriceState; className?: string }) {
  return (
    <span className={cn("flex flex-wrap items-center gap-1.5 text-xs text-fg-soft", className)}>
      <span>as of {formatDay(priced.asOf)}</span>
      {priced.stale && <Tag className="border-negative/60 text-negative">Stale</Tag>}
    </span>
  )
}
