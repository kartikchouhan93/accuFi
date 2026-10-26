import { TriangleAlert } from "lucide-react"
import { Figure } from "@/app/figure"
import { StaleNote } from "@/app/stale-note"
import { SpotlightCard } from "@/components/ui/spotlight-card"
import { Tag } from "@/components/ui/tag"
import type { HoldingView, Portfolio } from "@/lib/investment-view"
import { formatPaiseText } from "@/lib/node-money"
import { Gain } from "./gain"

// The portfolio at a glance: what it is worth now, what it cost, and the gain on paper. All three are the server's totals
// over one set of holdings, the ones revalued (by quantity or as a lump) that have a value, so they always agree: the
// gain is the value less what was put in, on this card as on the server (Portfolio.totals).
//
// What is not in them is said in words beside them. An investment that could not be valued is named, with what was put
// into it when that is known (EC-23); when nothing can be valued there is no figure at all, never ₹0.00. One valued by
// what was put in has no value of its own to add, so it is named as not counted, and its card shows its money. One valued
// at a price older than its window is named too (EC-24).

function listed(parts: readonly string[]): string {
  return parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`
}

/** "Silver (₹24,000.00 put in)", or "Old fund (its cost is not known)" when some of its purchases have no quantity. */
function leftOut(holding: HoldingView): string {
  return holding.notValued === "NEEDS_QUANTITY"
    ? `${holding.name} (its cost is not known)`
    : `${holding.name} (${formatPaiseText(holding.costBasisPaise)} put in)`
}

export function PortfolioHero({ portfolio }: { portfolio: Portfolio }) {
  const { holdings, totals } = portfolio
  const unvalued = holdings.filter((holding) => holding.notValued !== null)
  const stale = holdings.filter((holding) => holding.notValued === null && holding.price?.stale).map((holding) => holding.name)
  const contributions = holdings.filter((holding) => holding.valuationMode === "CONTRIBUTION_ONLY").map((holding) => holding.name)
  const none = totals.valuePaise === null

  return (
    <SpotlightCard
      as="section"
      aria-labelledby="portfolio-heading"
      className="surface rise overflow-hidden rounded-3xl p-6 sm:p-8"
      radius={420}
      strength={12}
    >
      <span aria-hidden className="pointer-events-none absolute inset-x-8 top-0 h-px bg-gradient-to-r from-transparent via-accent-edge/70 to-transparent" />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 id="portfolio-heading" className="text-sm font-medium text-fg-soft">
          Portfolio
        </h2>
        {totals.notValuedCount > 0 && <Tag className="border-notice-fg/60 text-notice-fg">{totals.notValuedCount} not valued</Tag>}
      </div>

      {/* One level of groups, as a description list allows: the value across the top, then what it cost and the gain. */}
      <dl className="grid grid-cols-1 gap-x-4 gap-y-4 sm:grid-cols-2">
        <div className="border-b border-line pb-5 sm:col-span-2">
          <dt className="mt-1 text-sm text-fg-soft">Current value</dt>
          <dd className="figures font-display text-5xl font-semibold tracking-tight sm:text-6xl">
            {totals.valuePaise === null ? <span className="text-fg-soft">Not valued</span> : <Figure text={formatPaiseText(totals.valuePaise)} />}
          </dd>
        </div>
        {totals.costBasisPaise !== null && (
          <div className="pt-1">
            <dt className="text-sm text-fg-soft">Put in</dt>
            <dd className="figures mt-0.5 text-xl font-medium">{formatPaiseText(totals.costBasisPaise)}</dd>
          </div>
        )}
        <div className="pt-1">
          <dt className="text-sm text-fg-soft">Unrealised gain</dt>
          <dd className="mt-0.5 text-xl font-medium">
            {totals.unrealisedGainPaise === null ? (
              <span className="text-fg-soft">Not valued</span>
            ) : (
              <Gain paise={totals.unrealisedGainPaise} points={totals.gainBasisPoints} />
            )}
          </dd>
        </div>
      </dl>

      {unvalued.length > 0 && (
        <p role="note" className="mt-5 flex max-w-xl items-start gap-2.5 rounded-xl bg-notice-wash px-3.5 py-2.5 text-sm font-medium text-notice-fg">
          <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span>
            {none ? "Nothing here can be valued yet: " : ""}
            {listed(unvalued.map(leftOut))} {unvalued.length === 1 ? "is" : "are"} not valued and {unvalued.length === 1 ? "is" : "are"} left
            out of these figures.
          </span>
        </p>
      )}
      {stale.length > 0 && <StaleNote names={stale} />}
      {contributions.length > 0 && (
        <p className="mt-3 max-w-xl text-sm text-fg-soft">
          {listed(contributions)} {contributions.length === 1 ? "is" : "are"} valued by what was put in, so not counted here: {contributions.length === 1 ? "its card shows" : "their cards show"} the money in {contributions.length === 1 ? "it" : "them"}.
        </p>
      )}
    </SpotlightCard>
  )
}
