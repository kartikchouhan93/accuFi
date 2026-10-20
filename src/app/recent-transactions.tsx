import Link from "next/link"
import { Amount } from "@/app/amount"
import type { DashboardView } from "@/lib/dashboard-view"
import { formatPaiseText } from "@/lib/node-money"
import { formatDay } from "@/lib/transaction-text"

// The newest few transactions, up to today. A glance, not a second transaction screen: editing and filtering live there.

export function RecentTransactions({ recent }: { recent: DashboardView["recent"] }) {
  return (
    <section aria-labelledby="recent-heading">
      <div className="flex items-baseline justify-between gap-3 border-b-2 border-ink pb-1">
        <h2 id="recent-heading" className="font-display text-xl font-semibold">
          Recent transactions
        </h2>
        <Link href="/transactions" className="text-sm font-medium text-pen underline underline-offset-4">
          All transactions
        </Link>
      </div>
      {recent.length === 0 ? (
        <p className="mt-3 text-ink-soft">Nothing recorded yet.</p>
      ) : (
        <ul className="divide-y divide-rule">
          {recent.map((entry) => (
            <li key={entry.id} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-baseline gap-x-3 py-2.5">
              <span className="font-medium">
                {entry.fromName} → {entry.toName}
              </span>
              <span className="leader" aria-hidden="true" />
              <Amount text={{ amount: formatPaiseText(entry.amountPaise), qualifier: null, tone: "neutral" }} />
              <span className="figures col-span-3 text-sm text-ink-soft">
                {formatDay(entry.occurredAt)}
                {entry.note && ` · ${entry.note}`}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
