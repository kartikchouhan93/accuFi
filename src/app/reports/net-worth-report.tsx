import { Figure } from "@/app/figure"
import { PartialNote } from "@/app/partial-note"
import { StaleNote, staleText } from "@/app/stale-note"
import { LineChart } from "@/components/charts/line-chart"
import { SpotlightCard } from "@/components/ui/spotlight-card"
import { NOT_VALUED_COPY } from "@/lib/investment-view"
import { describeBalance, formatPaiseText } from "@/lib/node-money"
import { isNegative, periodLabel } from "@/lib/report-text"
import type { NetWorthPointView, NetWorthReportView } from "@/lib/report-view"
import { formatDay } from "@/lib/transaction-text"
import { cn } from "@/lib/utils"
import { DrillLink } from "./drill-link"
import { NothingToReport } from "./report-notes"
import { NoteRow, STICKY_CELL, type RowNote } from "./report-table"

// Net worth over time: what was owned less what was owed at the end of each month of the range, valued at the prices
// known on that day (NetWorthReportView; the server did every sum). It opens with the latest figure, in the dashboard's
// words when it is partial or rests on a stale price. A month that leaves out an investment it could not value is drawn
// as an outlined point and says, under its row, what it excludes and why, so a dip is never read as a loss. Each of the
// three parts opens the month's entries that touch accounts, investments or liabilities, and "Entries" opens all of them;
// the net worth is their difference and has no entries of its own, so it is printed, not linked.

const COLUMNS = ["Month", "Assets", "Investments", "Owed", "Net worth", "Entries"] as const

function notesOf(point: NetWorthPointView): RowNote[] {
  const notes: RowNote[] = []
  if (point.partial) {
    const excluded = point.unvalued.map((entry) => `${entry.name} (${NOT_VALUED_COPY[entry.reason]})`).join(", ")
    notes.push({ key: "partial", kind: "partial", text: `Excludes: ${excluded}` })
  }
  if (point.staleNames.length > 0) notes.push({ key: "stale", kind: "stale", text: staleText(point.staleNames) })
  return notes
}

function pointText(point: NetWorthPointView): string {
  return `${formatPaiseText(point.totalPaise)}${point.partial ? ", partial" : ""}${point.staleNames.length > 0 ? ", at an old price" : ""}`
}

function summaryOf(points: readonly NetWorthPointView[]): string {
  const first = points[0]
  const last = points[points.length - 1]
  const span =
    points.length === 1
      ? `Net worth was ${formatPaiseText(last.totalPaise)} on ${formatDay(last.asOf)}.`
      : `Net worth was ${formatPaiseText(first.totalPaise)} on ${formatDay(first.asOf)} and ${formatPaiseText(last.totalPaise)} on ${formatDay(last.asOf)}.`
  const outlined = points.some((point) => point.partial) ? " An outlined point leaves out an investment that could not be valued." : ""
  return span + outlined
}

export function NetWorthReport({ view }: { view: NetWorthReportView }) {
  if (view.empty || view.points.length === 0) return <NothingToReport />
  const { points } = view
  const labels = points.map((point) => periodLabel(point.bucket))
  const last = points[points.length - 1]
  const total = describeBalance("ASSET", last.totalPaise) // a signed amount, in the negative colour below zero

  return (
    <div className="space-y-6">
      <SpotlightCard
        as="section"
        aria-labelledby="net-worth-report-heading"
        className="surface rise overflow-hidden rounded-3xl p-6 sm:p-8"
        radius={420}
        strength={12}
      >
        <span aria-hidden className="pointer-events-none absolute inset-x-8 top-0 h-px bg-gradient-to-r from-transparent via-accent-edge/70 to-transparent" />
        <h2 id="net-worth-report-heading" className="text-sm font-medium text-fg-soft">
          Net worth on {formatDay(last.asOf)}
        </h2>
        <p className={cn("figures mt-2 font-display text-4xl font-semibold tracking-tight sm:text-6xl", total.tone === "negative" && "text-negative")}>
          <Figure text={total.amount} />
        </p>
        {last.partial && <PartialNote names={last.unvalued.map((entry) => entry.name)} />}
        {last.staleNames.length > 0 && <StaleNote names={last.staleNames} />}
        <p className="figures mt-4 text-sm text-fg-soft">
          <span className="font-medium text-fg">{formatPaiseText(last.assetsPaise)}</span> in accounts,{" "}
          <span className="font-medium text-fg">{formatPaiseText(last.investmentsPaise)}</span> invested,{" "}
          <span className="font-medium text-negative">{formatPaiseText(last.liabilitiesPaise)}</span> owed.
        </p>
      </SpotlightCard>

      <div className="rise" style={{ "--i": 1 } as React.CSSProperties}>
        <LineChart
          title="Net worth by month"
          summary={summaryOf(points)}
          labels={labels}
          series={[
            {
              key: "total",
              label: "Net worth",
              tone: "accent",
              values: points.map((point) => point.totalPaise),
              hollow: points.map((point) => point.partial),
              texts: points.map(pointText),
            },
          ]}
          table={{
            columns: ["Month", "Assets", "Investments", "Owed", "Net worth"],
            rows: points.map((point, index) => ({
              label: labels[index],
              cells: [
                formatPaiseText(point.assetsPaise),
                formatPaiseText(point.investmentsPaise),
                formatPaiseText(point.liabilitiesPaise),
                pointText(point),
              ],
            })),
          }}
        />
      </div>

      <SpotlightCard
        as="section"
        aria-labelledby="net-worth-table-heading"
        className="surface rise rounded-3xl p-5 sm:p-6"
        radius={460}
        strength={9}
        style={{ "--i": 2 } as React.CSSProperties}
      >
        <h2 id="net-worth-table-heading" className="font-display text-lg font-semibold tracking-tight">
          Month by month
        </h2>
        <p className="mt-1 text-sm text-fg-soft">
          Each part is its balance at the month&apos;s end and opens that month&apos;s entries in it. Entries opens every entry of the month.
        </p>
        {/* Relative, so the screen-reader-only text in the cells (absolutely placed) is clipped with the table, not left out past the page edge. */}
        <div className="relative -mx-5 mt-4 overflow-x-auto px-5 sm:-mx-6 sm:px-6">
          <table data-report-table className="figures w-full border-collapse text-[13px] sm:text-[15px]">
            <caption className="sr-only">
              Assets, investments, amount owed and net worth at the end of each month, {formatDay(view.range.from)} to {formatDay(view.range.to)}
            </caption>
            <thead>
              <tr className="border-b border-line text-fg-soft">
                {COLUMNS.map((column, index) => (
                  <th
                    key={column}
                    scope="col"
                    className={cn(
                      "whitespace-nowrap py-2.5 font-medium",
                      index === 0 ? cn(STICKY_CELL, "pr-3 text-left sm:pr-4") : "pl-3 text-right sm:pl-4",
                    )}
                  >
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            {points.map((point, index) => {
              const label = labels[index]
              const notes = notesOf(point)
              return (
                <tbody key={point.bucket.key} className="border-b border-line last:border-0">
                  <tr data-row className="transition-colors hover:bg-panel-raised">
                    <th scope="row" className={cn(STICKY_CELL, "whitespace-nowrap py-2.5 pr-3 text-left font-medium sm:pr-4")}>
                      {label}
                    </th>
                    <td className="whitespace-nowrap py-2.5 pl-3 text-right sm:pl-4">
                      <DrillLink drill={point.assetsDrill} context={`, assets, ${label}`}>
                        {formatPaiseText(point.assetsPaise)}
                      </DrillLink>
                    </td>
                    <td className="whitespace-nowrap py-2.5 pl-3 text-right sm:pl-4">
                      <DrillLink drill={point.investmentsDrill} context={`, investments, ${label}`}>
                        {formatPaiseText(point.investmentsPaise)}
                      </DrillLink>
                    </td>
                    <td className="whitespace-nowrap py-2.5 pl-3 text-right sm:pl-4">
                      <DrillLink drill={point.liabilitiesDrill} context={`, owed, ${label}`}>
                        {formatPaiseText(point.liabilitiesPaise)}
                      </DrillLink>
                    </td>
                    <td className={cn("whitespace-nowrap py-2.5 pl-3 text-right font-semibold sm:pl-4", isNegative(point.totalPaise) && "text-negative")}>
                      {formatPaiseText(point.totalPaise)}
                      {point.partial && <span className="sr-only">, partial</span>}
                    </td>
                    <td className="whitespace-nowrap py-2.5 pl-3 text-right sm:pl-4">
                      <DrillLink drill={point.movementDrill} context={` every entry of ${label}`} className="text-link">
                        View
                      </DrillLink>
                    </td>
                  </tr>
                  <NoteRow colSpan={COLUMNS.length} notes={notes} />
                </tbody>
              )
            })}
          </table>
        </div>
      </SpotlightCard>
    </div>
  )
}
