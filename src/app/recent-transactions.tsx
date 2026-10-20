import Link from "next/link"
import { Amount } from "@/app/amount"
import type { DashboardView } from "@/lib/dashboard-view"
import { formatPaiseText } from "@/lib/node-money"
import { formatDay } from "@/lib/transaction-text"

// The newest few transactions, up to today. A glance, not a second transaction screen: editing and filtering live there.

export function RecentTransactions({ recent }: { recent: DashboardView["recent"] }) {
  return (
    <section aria-labelledby="recent-heading" className="surface rounded-3xl p-5 sm:p-6">
      <div className="flex items-center justify-between gap-3">
        <h2 id="recent-heading" className="font-display text-lg font-semibold tracking-tight">
          Recent transactions
        </h2>
        <Link href="/transactions" className="rounded-md text-sm font-medium text-link underline-offset-4 hover:underline">
          All transactions
        </Link>
      </div>
      {recent.length === 0 ? (
        <p className="mt-4 text-fg-soft">Nothing recorded yet.</p>
      ) : (
        <ol className="relative mt-4 border-l border-line pl-5">
          {recent.map((entry, index) => (
            <li key={entry.id} className="rise relative flex items-start justify-between gap-4 py-3" style={{ "--i": index } as React.CSSProperties}>
              <span
                aria-hidden
                className="absolute -left-[25.5px] top-[1.3rem] size-2.5 rounded-full border-2 border-panel bg-accent-edge"
              />
              <div className="min-w-0">
                <p className="truncate font-medium">
                  {entry.fromName} → {entry.toName}
                </p>
                <p className="figures mt-0.5 flex gap-2 text-sm text-fg-soft">
                  <span className="shrink-0">{formatDay(entry.occurredAt)}</span>
                  {entry.note && <span className="truncate">{entry.note}</span>}
                </p>
              </div>
              <Amount text={{ amount: formatPaiseText(entry.amountPaise), qualifier: null, tone: "neutral" }} className="shrink-0 font-medium" />
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}
