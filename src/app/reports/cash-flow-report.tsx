import { BarChart } from "@/components/charts/bar-chart"
import { SpotlightCard } from "@/components/ui/spotlight-card"
import { formatPaiseText } from "@/lib/node-money"
import { isNegative, periodLabel } from "@/lib/report-text"
import type { CashFlowView } from "@/lib/report-view"
import { formatDay } from "@/lib/transaction-text"
import { cn } from "@/lib/utils"
import { DrillLink } from "./drill-link"
import { NothingToReport } from "./report-notes"

// Income vs expense: what came in, what went out and what was left, month by month over the range. The figures are the
// server's (CashFlowView), printed from paise text; the chart only places them. Every income and spending figure opens
// the entries it is made of, so a month here can be checked against the Transactions screen. What was saved is the
// difference of the two and has no entries of its own, so it is printed, not linked. Realised gains and losses count as
// income and spending; when there are any, a line says how much of each, so a sale is not mistaken for earnings.

function rangeWords(view: CashFlowView) {
  return `${formatDay(view.range.from)} to ${formatDay(view.range.to)}`
}

/**
 * A spending figure and the entries it opens. Below zero, more was refunded than spent (EC-20): it says "net refund"
 * beside the figure, and in the link's name, so a minus sign alone never has to carry it.
 */
function Spending({ paise, drill, context }: { paise: string; drill: CashFlowView["totals"]["spendingDrill"]; context: string }) {
  const refund = isNegative(paise)
  return (
    <>
      <DrillLink drill={drill} context={refund ? `${context}, net refund` : context}>
        {formatPaiseText(paise)}
      </DrillLink>
      {refund && (
        <span aria-hidden className="ml-1.5 font-sans text-sm font-normal tracking-normal text-fg-soft">
          net refund
        </span>
      )}
    </>
  )
}

const spendingText = (paise: string) => `${formatPaiseText(paise)}${isNegative(paise) ? " net refund" : ""}`

function summaryOf(view: CashFlowView): string {
  const { totals, buckets } = view
  const span = `${buckets.length} ${buckets.length === 1 ? "month" : "months"}`
  const saved = isNegative(totals.savedPaise)
    ? `${formatPaiseText(totals.savedPaise.slice(1))} more went out than came in`
    : `${formatPaiseText(totals.savedPaise)} saved`
  return `Over ${span}, ${formatPaiseText(totals.incomePaise)} came in and ${formatPaiseText(totals.spendingPaise)} went out: ${saved}.`
}

export function CashFlowReport({ view }: { view: CashFlowView }) {
  if (view.empty) return <NothingToReport />
  const { buckets, totals } = view
  const labels = buckets.map((row) => periodLabel(row.bucket))
  const realised = totals.gainPaise !== "0" || totals.lossPaise !== "0"

  return (
    <div className="space-y-6">
      <SpotlightCard
        as="section"
        aria-labelledby="cash-flow-heading"
        className="surface rise overflow-hidden rounded-3xl p-6 sm:p-8"
        radius={420}
        strength={12}
      >
        <span aria-hidden className="pointer-events-none absolute inset-x-8 top-0 h-px bg-gradient-to-r from-transparent via-accent-edge/70 to-transparent" />
        <h2 id="cash-flow-heading" className="text-sm font-medium text-fg-soft">
          Income vs expense, {rangeWords(view)}
        </h2>
        <dl className="mt-4 grid gap-x-6 gap-y-5 sm:grid-cols-3">
          <div>
            <dt className="text-sm text-fg-soft">
              Income
            </dt>
            <dd className="figures mt-1 font-display text-3xl font-semibold tracking-tight">
              <DrillLink drill={totals.incomeDrill} context=", total income">{formatPaiseText(totals.incomePaise)}</DrillLink>
            </dd>
          </div>
          <div>
            <dt className="text-sm text-fg-soft">
              Spending
            </dt>
            <dd className="figures mt-1 font-display text-3xl font-semibold tracking-tight">
              <Spending paise={totals.spendingPaise} drill={totals.spendingDrill} context=", total spending" />
            </dd>
          </div>
          <div className="sm:border-l sm:border-line sm:pl-6">
            <dt className="text-sm text-fg-soft">Net saved</dt>
            <dd className={cn("figures mt-1 font-display text-3xl font-semibold tracking-tight", isNegative(totals.savedPaise) && "text-negative")}>
              {formatPaiseText(totals.savedPaise)}
            </dd>
          </div>
        </dl>
        {realised && (
          <p className="mt-5 max-w-xl text-sm text-fg-soft">
            Includes {formatPaiseText(totals.gainPaise)} realised gains and {formatPaiseText(totals.lossPaise)} realised losses from investment sales.
          </p>
        )}
      </SpotlightCard>

      <div className="rise" style={{ "--i": 1 } as React.CSSProperties}>
        <BarChart
          title="Income and spending by month"
          summary={summaryOf(view)}
          labels={labels}
          series={[
            { key: "income", label: "Income", tone: "positive", values: buckets.map((row) => row.incomePaise) },
            { key: "spending", label: "Spending", tone: "accent", values: buckets.map((row) => row.spendingPaise) },
          ]}
          table={{
            columns: ["Period", "Income", "Spending", "Net saved"],
            rows: buckets.map((row, index) => ({
              label: labels[index],
              cells: [formatPaiseText(row.incomePaise), spendingText(row.spendingPaise), formatPaiseText(row.savedPaise)],
            })),
          }}
        />
      </div>

      <SpotlightCard
        as="section"
        aria-labelledby="cash-flow-table-heading"
        className="surface rise rounded-3xl p-5 sm:p-6"
        radius={460}
        strength={9}
        style={{ "--i": 2 } as React.CSSProperties}
      >
        <h2 id="cash-flow-table-heading" className="font-display text-lg font-semibold tracking-tight">
          Month by month
        </h2>
        <p className="mt-1 text-sm text-fg-soft">Each income and spending figure opens the entries it is made of.</p>
        {/* Relative, so the screen-reader-only text in the cells (absolutely placed) is clipped with the table, not left out past the page edge. */}
        <div className="relative -mx-5 mt-4 overflow-x-auto px-5 sm:-mx-6 sm:px-6">
          <table className="figures w-full min-w-max border-collapse text-[13px] sm:text-[15px]">
            <caption className="sr-only">Income, spending and net saved by period, {rangeWords(view)}</caption>
            <thead>
              <tr className="border-b border-line text-fg-soft">
                <th scope="col" className="sticky left-0 bg-panel py-2.5 pr-3 text-left font-medium sm:static sm:bg-transparent sm:pr-4">
                  Period
                </th>
                <th scope="col" className="py-2.5 pl-3 sm:pl-4 text-right font-medium">
                  Income
                </th>
                <th scope="col" className="py-2.5 pl-3 sm:pl-4 text-right font-medium">
                  Spending
                </th>
                <th scope="col" className="py-2.5 pl-3 sm:pl-4 text-right font-medium">
                  Net saved
                </th>
              </tr>
            </thead>
            <tbody>
              {buckets.map((row, index) => (
                <tr key={row.bucket.key} className="border-b border-line transition-colors last:border-0 hover:bg-panel-raised">
                  <th scope="row" className="sticky left-0 bg-panel py-2.5 pr-3 text-left font-medium sm:static sm:bg-transparent sm:pr-4">
                    {labels[index]}
                  </th>
                  <td className="py-2.5 pl-3 sm:pl-4 text-right">
                    <DrillLink drill={row.incomeDrill} context={`, income, ${labels[index]}`}>{formatPaiseText(row.incomePaise)}</DrillLink>
                  </td>
                  <td className="py-2.5 pl-3 sm:pl-4 text-right">
                    <Spending paise={row.spendingPaise} drill={row.spendingDrill} context={`, spending, ${labels[index]}`} />
                  </td>
                  <td className={cn("py-2.5 pl-3 sm:pl-4 text-right", isNegative(row.savedPaise) ? "text-negative" : "text-fg-soft")}>
                    {formatPaiseText(row.savedPaise)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-line-strong font-semibold">
                <th scope="row" className="sticky left-0 bg-panel py-3 pr-3 text-left sm:static sm:bg-transparent sm:pr-4">
                  Total
                </th>
                <td className="py-3 pl-3 sm:pl-4 text-right">
                  <DrillLink drill={totals.incomeDrill} context=", total income">{formatPaiseText(totals.incomePaise)}</DrillLink>
                </td>
                <td className="py-3 pl-3 sm:pl-4 text-right">
                  <Spending paise={totals.spendingPaise} drill={totals.spendingDrill} context=", total spending" />
                </td>
                <td className={cn("py-3 pl-3 sm:pl-4 text-right", isNegative(totals.savedPaise) && "text-negative")}>{formatPaiseText(totals.savedPaise)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </SpotlightCard>
    </div>
  )
}
