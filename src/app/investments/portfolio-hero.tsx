import { Figure } from "@/app/figure"
import { PartialNote } from "@/app/partial-note"
import { StaleNote } from "@/app/stale-note"
import { SpotlightCard } from "@/components/ui/spotlight-card"
import { Tag } from "@/components/ui/tag"
import type { Portfolio } from "@/lib/investment-view"
import { portfolioGainBasisPoints } from "@/lib/investment-text"
import { formatPaiseText } from "@/lib/node-money"
import { Gain } from "./gain"

// The whole portfolio at a glance: what is worth now, what was put in, and the gain on paper. Every figure is the server's
// total (archived investments included). The value and gain count only the investments that could be valued; when any
// could not, the card says how many and names them, so a lower figure never passes for the whole picture (EC-23). One
// valued at a price older than its window is named too (EC-24).

export function PortfolioHero({ portfolio }: { portfolio: Portfolio }) {
  const { holdings, totals } = portfolio
  const unvalued = holdings.filter((holding) => holding.notValued !== null).map((holding) => holding.name)
  const stale = holdings.filter((holding) => holding.notValued === null && holding.price?.stale).map((holding) => holding.name)

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
      <p className="mt-1 text-sm text-fg-soft">Current value</p>
      <p className="figures font-display text-5xl font-semibold tracking-tight sm:text-6xl">
        <Figure text={formatPaiseText(totals.valuePaise)} />
      </p>

      <dl className="mt-6 grid grid-cols-1 gap-4 border-t border-line pt-5 sm:grid-cols-2">
        <div>
          <dt className="text-sm text-fg-soft">Put in</dt>
          <dd className="figures mt-0.5 text-xl font-medium">{formatPaiseText(totals.contributedPaise)}</dd>
        </div>
        <div>
          <dt className="text-sm text-fg-soft">Unrealised gain</dt>
          <dd className="mt-0.5">
            <Gain paise={totals.unrealisedGainPaise} points={portfolioGainBasisPoints(holdings)} className="text-xl font-medium" />
          </dd>
        </div>
      </dl>

      {unvalued.length > 0 && <PartialNote names={unvalued} />}
      {stale.length > 0 && <StaleNote names={stale} />}
    </SpotlightCard>
  )
}
