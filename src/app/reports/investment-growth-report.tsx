import { ArrowUpRight, TrendingUp } from "lucide-react"
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
// that values only some of the investments compares like with like: both lines are over the valued ones (the chart's
// Invested is `investedCoveredPaise`), both points are outlined, and the table, which keeps everything put in, says so.
// A month counted at a stale price says so too. Each month opens the entries of the investments in it; the lots and
// prices behind a value are on the Investments screen, which the report links to.

const COLUMNS = ["Month", "Invested", "Value", "Gain", "Realised"] as const

const isPartial = (point: GrowthPointView) => point.covered !== null && point.covered.covered < point.covered.total

/** A portfolio month that values some of the investments but not all: drawn as outlined points. */
const isOutlined = (point: GrowthPointView) => isPartial(point) && point.covered!.covered > 0

/** "covers 1 of 2" for a portfolio month that values only some of the investments; null when it values them all. */
const coverage = (point: GrowthPointView): string | null =>
  point.covered && isPartial(point) ? `covers ${point.covered.covered} of ${point.covered.total}` : null

/** "Gold", "Gold and Fund", "Gold, Fund and Silver". */
function listed(names: readonly string[]): string {
  return names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`
}

function valueText(point: GrowthPointView): string {
  if (point.valuePaise === null) return "Not valued"
  const covered = coverage(point) ? `, ${coverage(point)}` : ""
  return `${formatPaiseText(point.valuePaise)}${covered}${point.stale ? ", at an old price" : ""}`
}

/** What the chart's Invested point says: on an outlined month, what went into the valued investments only. */
function investedText(point: GrowthPointView): string {
  return `${formatPaiseText(point.investedCoveredPaise)}${isOutlined(point) ? `, ${coverage(point)}` : ""}`
}

function notesOf(point: GrowthPointView, name: string | null): RowNote[] {
  const notes: RowNote[] = []
  if (point.covered && isPartial(point)) {
    const names = point.unvaluedNames
    if (point.covered.covered === 0) {
      notes.push({ key: "partial", kind: "partial", text: `${listed(names)} not valued in this month.` })
    } else {
      const left = names.length > 0 ? ` (${names.join(", ")} not valued)` : ""
      const invested = names.length > 0 ? ` Invested includes ${listed(names)}; the chart's lines compare the valued investments only.` : ""
      notes.push({
        key: "partial",
        kind: "partial",
        text: `Value and gain cover ${point.covered.covered} of ${point.covered.total} investments${left}.${invested}`,
      })
    }
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
  let lead: string
  if (last.valuePaise === null) {
    lead = `On ${formatDay(last.asOf)}, ${formatPaiseText(last.investedPaise)} was in ${who}, which could not be valued.`
  } else if (isOutlined(last)) {
    const { covered, total } = last.covered!
    lead =
      `On ${formatDay(last.asOf)}, ${formatPaiseText(last.investedPaise)} was in ${who}. The ${covered} of ${total} that could be valued had ` +
      `${formatPaiseText(last.investedCoveredPaise)} in them and were worth ${formatPaiseText(last.valuePaise)}.`
  } else {
    lead = `On ${formatDay(last.asOf)}, ${formatPaiseText(last.investedPaise)} was in ${who}, worth ${formatPaiseText(last.valuePaise)}.`
  }
  const outlined = view.points.some(isOutlined)
    ? " An outlined point is a month that values only some of the investments: there both lines cover the valued ones only."
    : ""
  const gap = view.points.some((point) => point.valuePaise === null) ? " A gap in Value is a month it could not be valued." : ""
  return lead + outlined + gap
}

/** The investments in the view that have no prices: worth what was put in, so at cost on both lines. */
function atCostNote(view: InvestmentGrowthView): string | null {
  const inView = view.selected ? view.investments.filter((investment) => investment.id === view.selected!.id) : view.investments
  const names = inView.filter((investment) => investment.valuedAtCost).map((investment) => investment.name)
  if (names.length === 0) return null
  return names.length === 1
    ? `${names[0]} is valued at what was put in (no prices), so it shows no gain.`
    : `${listed(names)} are valued at what was put in (no prices), so they show no gain.`
}

/** The Investments screen, at the selected investment's card: where the lots and prices behind a value are listed. */
export function investmentsHref(selected: { id: string } | null): string {
  return selected ? `/investments#holding-${selected.id}` : "/investments"
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
  const atCost = atCostNote(view)

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
        <NodePicker key={selected?.id ?? ""} slug="investments" choice={choice} label="Investment" value={selected?.id ?? ""} groups={[{ options }]} />
        <Link href={investmentsHref(selected)} className={buttonClass({ variant: "secondary", className: "self-start sm:self-auto" })}>
          {selected ? `Open ${selected.name} in Investments` : "Open Investments"}
          <span className="sr-only">, where the lots and prices are listed</span>
          <ArrowUpRight aria-hidden className="size-4" />
        </Link>
      </div>

      <div className="rise">
        <LineChart
          title={`${selected?.name ?? "All investments"}: invested and value`}
          summary={summaryOf(view)}
          labels={labels}
          series={[
            {
              key: "invested",
              label: "Invested",
              tone: "muted",
              // Like with like: on a month that values only some of the investments, what went into those.
              values: points.map((point) => point.investedCoveredPaise),
              hollow: points.map(isOutlined),
              texts: points.map(investedText),
            },
            {
              key: "value",
              label: "Value",
              tone: "accent",
              values: points.map((point) => point.valuePaise),
              hollow: points.map(isOutlined),
              texts: points.map(valueText),
            },
          ]}
          table={{
            columns: [...COLUMNS],
            rows: points.map((point, index) => ({
              label: labels[index],
              cells: [
                investedText(point),
                valueText(point),
                point.gainPaise === null ? "Not valued" : `${formatPaiseText(point.gainPaise)}${coverage(point) ? `, ${coverage(point)}` : ""}`,
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
                    {/* The gain is over the valued investments only, so it is not read as a gain on all that was invested. */}
                    {point.gainPaise !== null && coverage(point) && (
                      <>
                        {" "}
                        <span className="ml-1 text-xs font-medium text-fg-soft">{coverage(point)}</span>
                      </>
                    )}
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
        {atCost && (
          <p role="note" className="mt-4 max-w-xl text-sm text-fg-soft">
            {atCost}
          </p>
        )}
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
