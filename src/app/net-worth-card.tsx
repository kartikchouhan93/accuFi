import { CalendarClock } from "lucide-react"
import { Figure } from "@/app/figure"
import { PartialNote } from "@/app/partial-note"
import { StaleNote } from "@/app/stale-note"
import { SpotlightCard } from "@/components/ui/spotlight-card"
import type { DashboardView } from "@/lib/dashboard-view"
import { holdingsSplit } from "@/lib/holdings-split"
import { describeBalance, formatPaiseText } from "@/lib/node-money"
import { formatDay } from "@/lib/transaction-text"
import { cn } from "@/lib/utils"

// What you own less what you owe, as the dashboard opens with it. The figures arrive as paise text from the server, which
// summed every account, archived ones included. `liabilities` is already the positive amount owed (the total has
// subtracted it), so it is printed as it comes. When an investment could not be valued the total leaves it out, and the
// card says so in words next to the figure rather than letting a lower number pass for the whole picture.
//
// The figure is the one thing on the page set large, and its type does the work: the rupee sign and the paise are smaller
// and dimmer than the digits between them, because ₹1,09,749 is what matters at a glance and the .75 is not. The text is
// unbroken for anything that reads it; only the styling is split.

interface Props {
  netWorth: DashboardView["netWorth"]
  projected: DashboardView["projected"]
}

function Dot({ className }: { className: string }) {
  return <span aria-hidden className={cn("mr-1.5 inline-block size-2 rounded-full align-middle", className)} />
}

export function NetWorthCard({ netWorth, projected }: Props) {
  const total = describeBalance("ASSET", netWorth.total) // a signed amount: negative reads in the negative colour with its minus sign
  const split = holdingsSplit(netWorth.assets, netWorth.investments)
  return (
    <SpotlightCard as="section" aria-labelledby="net-worth-heading" className="surface overflow-hidden rounded-3xl p-6 sm:p-8" radius={420} strength={12}>
      <span aria-hidden className="pointer-events-none absolute inset-x-8 top-0 h-px bg-gradient-to-r from-transparent via-accent-edge/70 to-transparent" />
      <h2 id="net-worth-heading" className="text-sm font-medium text-fg-soft">
        Net worth
      </h2>
      <p className={cn("figures mt-2 font-display text-5xl font-semibold tracking-tight sm:text-7xl", total.tone === "negative" && "text-negative")}>
        <Figure text={total.amount} />
      </p>
      {netWorth.isPartial && <PartialNote names={netWorth.unvaluedNames} />}
      {netWorth.staleNames.length > 0 && <StaleNote names={netWorth.staleNames} />}
      {split && (
        <div aria-hidden className="mt-7 flex h-2 w-full gap-1">
          {split.accounts > 0 && <span className="rounded-full bg-positive" style={{ flex: `${split.accounts} 1 0` }} />}
          {split.invested > 0 && <span className="rounded-full bg-link" style={{ flex: `${split.invested} 1 0` }} />}
        </div>
      )}
      <p className={cn("figures text-sm text-fg-soft", split ? "mt-3" : "mt-6")}>
        <Dot className="bg-positive" />
        <span className="font-medium text-fg">{formatPaiseText(netWorth.assets)}</span> in accounts, <Dot className="bg-link" />
        <span className="font-medium text-fg">{formatPaiseText(netWorth.investments)}</span> invested, <Dot className="bg-negative" />
        <span className="font-medium text-negative">{formatPaiseText(netWorth.liabilities)}</span> owed.
        {netWorth.archivedCount > 0 && <span className="mt-1 block">Includes {netWorth.archivedCount} archived.</span>}
      </p>
      {projected && (
        <p className="figures mt-4 flex items-start gap-2 border-t border-line pt-4 text-sm text-fg-soft">
          <CalendarClock aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span>
            Projected <span className="font-medium text-fg">{formatPaiseText(projected.total)}</span>
            {projected.isPartial && " (partial)"} once everything dated up to{" "}
            {formatDay(projected.asOf)} has happened. Not counted above.
          </span>
        </p>
      )}
    </SpotlightCard>
  )
}
