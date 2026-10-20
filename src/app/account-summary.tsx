import Link from "next/link"
import { Amount } from "@/app/amount"
import type { DashboardView } from "@/lib/dashboard-view"
import { KIND_COPY } from "@/lib/node-kinds"
import { describeBalance } from "@/lib/node-money"

// Every live account, investment and liability with what it holds or owes, grouped by kind. The figure at the head of a
// group is the server's total for the kind, which counts archived nodes; the rows are only the ones still in use, so a
// group says how many are not listed rather than letting the rows and the total quietly disagree.

interface Props {
  accounts: DashboardView["accounts"]
  kindTotals: DashboardView["kindTotals"]
}

export function AccountSummary({ accounts, kindTotals }: Props) {
  return (
    <div className="space-y-8">
      {kindTotals.map(({ kind, total, archivedCount }) => {
        const rows = accounts.filter((account) => account.kind === kind)
        if (rows.length === 0 && archivedCount === 0) return null
        const copy = KIND_COPY[kind]
        const headingId = `summary-${kind}`
        return (
          <section key={kind} aria-labelledby={headingId}>
            <div className="flex items-baseline gap-3 border-b-2 border-ink pb-1">
              <h3 id={headingId} className="font-display text-xl font-semibold">
                {copy.plural}
              </h3>
              <span className="leader" aria-hidden="true" />
              <Amount text={describeBalance(kind, total)} className="text-lg font-medium" />
            </div>
            {archivedCount > 0 && <p className="mt-1 text-sm text-ink-soft">Includes {archivedCount} archived, not listed.</p>}
            {rows.length > 0 && (
              <ul className="divide-y divide-rule">
                {rows.map((account) => (
                  <li key={account.id} className="flex items-baseline gap-3 py-2.5">
                    {/* The transactions screen, filtered to this account across every month. */}
                    <Link href={`/transactions?node=${account.id}&from=&to=`} className="font-medium underline-offset-4 hover:underline">
                      {account.name}
                    </Link>
                    <span className="leader" aria-hidden="true" />
                    <Amount text={describeBalance(account.kind, account.balance)} />
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
