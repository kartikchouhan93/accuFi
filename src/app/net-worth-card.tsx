import { PartialNote } from "@/app/partial-note"
import { describeBalance, formatPaiseText } from "@/lib/node-money"
import type { DashboardView } from "@/lib/dashboard-view"
import { formatDay } from "@/lib/transaction-text"

// What you own less what you owe, as the dashboard opens with it. The figures arrive as paise text from the server, which
// summed every account, archived ones included. `liabilities` is already the positive amount owed (the total has
// subtracted it), so it is printed as it comes. When an investment could not be valued the total leaves it out, and the
// card says so in words next to the figure rather than letting a lower number pass for the whole picture.

interface Props {
  netWorth: DashboardView["netWorth"]
  projected: DashboardView["projected"]
}

export function NetWorthCard({ netWorth, projected }: Props) {
  const total = describeBalance("ASSET", netWorth.total) // a signed amount: negative reads in red with its minus sign
  return (
    <section aria-labelledby="net-worth-heading">
      <h2 id="net-worth-heading" className="font-display text-lg font-semibold">
        Net worth
      </h2>
      <p className={`figures mt-1 pb-2 text-4xl font-medium sm:text-5xl ${total.tone === "negative" ? "text-red" : ""} double-rule`}>
        {total.amount}
      </p>
      {netWorth.isPartial && <PartialNote names={netWorth.unvaluedNames} />}
      <p className="figures mt-2 text-sm text-ink-soft">
        {formatPaiseText(netWorth.assets)} in accounts, {formatPaiseText(netWorth.investments)} invested, {formatPaiseText(netWorth.liabilities)}{" "}
        owed.
        {netWorth.archivedCount > 0 && ` Includes ${netWorth.archivedCount} archived.`}
      </p>
      {projected && (
        <p className="figures mt-1 text-sm text-ink-soft">
          Projected {formatPaiseText(projected.total)} once everything dated up to {formatDay(projected.asOf)} has happened. Not counted above.
        </p>
      )}
    </section>
  )
}
