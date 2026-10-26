import Link from "next/link"
import { Amount } from "@/app/amount"
import { PriceLine } from "@/app/price-line"
import { GlowingEffect } from "@/components/ui/glowing-effect"
import { SpotlightCard } from "@/components/ui/spotlight-card"
import type { DashboardView } from "@/lib/dashboard-view"
import { NOT_VALUED_COPY } from "@/lib/investment-view"
import { KIND_COPY } from "@/lib/node-kinds"
import { describeBalance } from "@/lib/node-money"

// Every live account, investment and liability with what it holds or owes, grouped by kind, each as a tile. The figure at
// the head of a group is the server's total for the kind, which counts archived nodes; the tiles are only the ones still
// in use, so a group says how many are not listed rather than letting the tiles and the total quietly disagree.

interface Props {
  accounts: DashboardView["accounts"]
  kindTotals: DashboardView["kindTotals"]
}

export function AccountSummary({ accounts, kindTotals }: Props) {
  return (
    <div className="space-y-10">
      {kindTotals.map(({ kind, total, archivedCount }) => {
        const rows = accounts.filter((account) => account.kind === kind)
        if (rows.length === 0 && archivedCount === 0) return null
        const copy = KIND_COPY[kind]
        const headingId = `summary-${kind}`
        return (
          <section key={kind} aria-labelledby={headingId}>
            <div className="flex items-baseline justify-between gap-4">
              <h2 id={headingId} className="font-display text-lg font-semibold tracking-tight">
                {copy.plural}
              </h2>
              <Amount text={describeBalance(kind, total)} className="text-lg font-medium" />
            </div>
            {archivedCount > 0 && <p className="mt-1 text-sm text-fg-soft">Includes {archivedCount} archived, not listed.</p>}
            {rows.length > 0 && (
              <ul className="mt-4 grid gap-3 sm:grid-cols-2">
                {rows.map((account, index) => (
                  <li key={account.id} className="rise" style={{ "--i": index } as React.CSSProperties}>
                    <SpotlightCard className="surface rounded-2xl p-4 transition-transform duration-200 hover:-translate-y-0.5" radius={240}>
                      <GlowingEffect />
                      {/* The transactions screen, filtered to this account across every month. The whole tile is the link. */}
                      <Link
                        href={`/transactions?node=${account.id}&from=&to=`}
                        className="block rounded-lg font-medium after:absolute after:inset-0 after:rounded-2xl"
                      >
                        {account.name}
                      </Link>
                      {/* An investment with no value shows none: a ₹0.00 here would be a figure the user believes (EC-23). */}
                      {account.notValued ? (
                        <p className="mt-4">
                          <span className="block text-2xl font-medium tracking-tight text-fg-soft">Not valued</span>
                          <span className="block text-sm text-fg-soft">{NOT_VALUED_COPY[account.notValued]}</span>
                        </p>
                      ) : (
                        <Amount text={describeBalance(account.kind, account.balance)} className="mt-4 block text-2xl font-medium tracking-tight" />
                      )}
                      {account.priced && <PriceLine priced={account.priced} className="mt-1" />}
                    </SpotlightCard>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )
      })}
    </div>
  )
}
