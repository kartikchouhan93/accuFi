import { TrendingUp } from "lucide-react"
import Link from "next/link"
import { staleText } from "@/app/stale-note"
import { LineChart } from "@/components/charts/line-chart"
import { SpotlightCard } from "@/components/ui/spotlight-card"
import { buttonClass } from "@/components/ui/styles"
import type { RangeChoice } from "@/domain/periods"
import { formatPaiseText } from "@/lib/node-money"
import { isNegative, periodLabel } from "@/lib/report-text"
import type { GrowthPointView, InvestmentGrowthView } from "@/lib/report-view"
import { formatDay } from "@/lib/transaction-text"
import { cn } from "@/lib/utils"
import { DrillLink } from "./drill-link"
import { NodePicker } from "./node-picker"
import { NothingToReport } from "./report-notes"
import { NoteRow, STICKY_CELL, type RowNote } from "./report-table"

// What went into the investments against what they were worth, at the end of each month, with what sales realised
// (InvestmentGrowthView; the server did every sum), for the whole portfolio or for one investment. Invested is dashed and
// Value solid, so the two lines differ without colour. A month an investment could not be valued in is "Not valued" and
// a gap in the Value line, never ₹0 or its cost, since either would pass for a real figure. For the portfolio a month
// that values only some of the investments is an outlined point and says which it covers; a month counted at a stale
// price says so too. Each month opens the entries of the investments in it.

const COLUMNS = ["Month", "Invested", "Value", "Gain", "Realised"] as const

const isPartial = (point: GrowthPointView) => point.covered !== null && point.covered.covered < point.covered.total

function valueText(point: GrowthPointView): string {
  if (point.valuePaise === null) return "Not valued"
  const covered = point.covered && isPartial(point) ? `, covers ${point.covered.covered} of ${point.covered.total}` : ""
  return `${formatPaiseText(point.valuePaise)}${covered}${point.stale ? ", at an old price" : ""}`
}

function notesOf(point: GrowthPointView, name: string | null): RowNote[] {
  const notes: RowNote[] = []
  if (point.covered && isPartial(point)) {
    const names = point.unvaluedNames
    const left = names.length > 0 ? ` ${names.join(", ")} could not be valued and ${names.length === 1 ? "is" : "are"} left out of it.` : ""
    notes.push({ key: "partial", kind: "partial", text: `Value covers ${point.covered.covered} of ${point.covered.total} investments.${left}` })
  }
  if (point.stale) {
    notes.push({
      key: "stale",
      kind: "stale",
      text: name ? staleText([name]) : "An investment here is valued at a price more than its stale window old.",
    })
  }
  return notes
}

function summaryOf(view: InvestmentGrowthView): string {
  const last = view.points[view.points.length - 1]
  const who = view.selected?.name ?? "your investments"
  const worth = last.valuePaise === null ? "it could not be valued" : `worth ${formatPaiseText(last.valuePaise)}`
  const lead = `On ${formatDay(last.asOf)}, ${formatPaiseText(last.investedPaise)} was in ${who}, ${worth}.`
  const outlined = view.points.some(isPartial) ? " An outlined point values only some of the investments." : ""
  const gap = view.points.some((point) => point.valuePaise === null) ? " A gap in Value is a month it could not be valued." : ""
  return lead + outlined + gap
}

function Signed({ paise }: { paise: string | null }) {
  if (paise === null) {
    return (
      <>
        <span aria-hidden className="text-fg-soft">
          —
        </span>
        <span className="sr-only">not valued</span>
      </>
    )
  }
  return <span className={cn(isNegative(paise) && "text-negative")}>{formatPaiseText(paise)}</span>
}

export function InvestmentGrowthReport({ view, choice }: { view: InvestmentGrowthView; choice: RangeChoice }) {
  if (view.empty) return <NothingToReport />
  if (view.investments.length === 0 || view.points.length === 0) return <NoInvestments />
  const { points, selected } = view
  const labels = points.map((point) => periodLabel(point.bucket))
  const options = [
    { value: "", label: "All investments" },
    ...view.investments.map((investment) => ({ value: investment.id, label: investment.name, archived: investment.archived })),
  ]
  const entriesOf = selected ? `, entries of ${selected.name}` : ", entries of every investment"

  return (
    <div className="space-y-6">
      <NodePicker slug="investments" choice={choice} label="Investment" value={selected?.id ?? ""} groups={[{ options }]} />

      <div className="rise">
        <LineChart
          title={`${selected?.name ?? "All investments"}: invested and value`}
          summary={summaryOf(view)}
          labels={labels}
          series={[
            { key: "invested", label: "Invested", tone: "muted", values: points.map((point) => point.investedPaise) },
            {
              key: "value",
              label: "Value",
              tone: "accent",
              values: points.map((point) => point.valuePaise),
              hollow: points.map(isPartial),
              texts: points.map(valueText),
            },
          ]}
          table={{
            columns: [...COLUMNS],
            rows: points.map((point, index) => ({
              label: labels[index],
              cells: [
                formatPaiseText(point.investedPaise),
                valueText(point),
                point.gainPaise === null ? "Not valued" : formatPaiseText(point.gainPaise),
                formatPaiseText(point.realisedPaise),
              ],
            })),
          }}
        />
      </div>

      <SpotlightCard
        as="section"
        aria-labelledby="growth-table-heading"
        className="surface rise rounded-3xl p-5 sm:p-6"
        radius={460}
        strength={9}
        style={{ "--i": 1 } as React.CSSProperties}
      >
        <h2 id="growth-table-heading" className="font-display text-lg font-semibold tracking-tight">
          Month by month
        </h2>
        <p className="mt-1 text-sm text-fg-soft">
          Invested and value are at the month&apos;s end; gain is value less invested; realised is what sales in the month made. Each month opens its
          entries.
        </p>
        {/* Relative, so the screen-reader-only text in the cells (absolutely placed) is clipped with the table, not left out past the page edge. */}
        <div className="relative -mx-5 mt-4 overflow-x-auto px-5 sm:-mx-6 sm:px-6">
          <table data-report-table className="figures w-full border-collapse text-[13px] sm:text-[15px]">
            <caption className="sr-only">
              {selected?.name ?? "All investments"}: invested, value, gain and realised by month, {formatDay(view.range.from)} to {formatDay(view.range.to)}
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
            {points.map((point, index) => (
              <tbody key={point.bucket.key} className="border-b border-line last:border-0">
                <tr data-row className="transition-colors hover:bg-panel-raised">
                  <th scope="row" className={cn(STICKY_CELL, "whitespace-nowrap py-2.5 pr-3 text-left font-medium sm:pr-4")}>
                    <DrillLink drill={point.drill} context={entriesOf}>
                      {labels[index]}
                    </DrillLink>
                  </th>
                  <td className="whitespace-nowrap py-2.5 pl-3 text-right sm:pl-4">{formatPaiseText(point.investedPaise)}</td>
                  <td className={cn("whitespace-nowrap py-2.5 pl-3 text-right font-semibold sm:pl-4", point.valuePaise === null && "font-medium text-fg-soft")}>
                    {point.valuePaise === null ? "Not valued" : formatPaiseText(point.valuePaise)}
                    {point.valuePaise !== null && isPartial(point) && <span className="sr-only">, partial</span>}
                  </td>
                  <td className="whitespace-nowrap py-2.5 pl-3 text-right sm:pl-4">
                    <Signed paise={point.gainPaise} />
                  </td>
                  <td className="whitespace-nowrap py-2.5 pl-3 text-right sm:pl-4">
                    <Signed paise={point.realisedPaise} />
                  </td>
                </tr>
                <NoteRow colSpan={COLUMNS.length} notes={notesOf(point, selected?.name ?? null)} />
              </tbody>
            ))}
          </table>
        </div>
      </SpotlightCard>
    </div>
  )
}

function NoInvestments() {
  return (
    <section aria-labelledby="no-investments-heading" className="surface max-w-xl rounded-3xl p-8">
      <span aria-hidden className="grid size-12 place-items-center rounded-2xl bg-panel-raised text-accent-edge">
        <TrendingUp className="size-6" />
      </span>
      <h2 id="no-investments-heading" className="mt-5 font-display text-2xl font-semibold tracking-tight">
        No investments yet
      </h2>
      <p className="mt-2 text-fg-soft">Once you hold an investment, what went into it and what it is worth show here month by month.</p>
      <Link href="/investments" className={buttonClass({ className: "mt-6" })}>
        Go to investments
      </Link>
    </section>
  )
}
