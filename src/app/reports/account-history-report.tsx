import { Landmark } from "lucide-react"
import Link from "next/link"
import { LineChart } from "@/components/charts/line-chart"
import { SpotlightCard } from "@/components/ui/spotlight-card"
import { buttonClass } from "@/components/ui/styles"
import type { RangeChoice } from "@/domain/periods"
import { KIND_COPY } from "@/lib/node-kinds"
import { describeBalance, formatPaiseText, type BalanceText } from "@/lib/node-money"
import { periodLabel } from "@/lib/report-text"
import type { AccountHistoryView, AccountRef } from "@/lib/report-view"
import { formatDay } from "@/lib/transaction-text"
import { cn } from "@/lib/utils"
import { DrillLink } from "./drill-link"
import { NodePicker } from "./node-picker"
import { NothingToReport } from "./report-notes"
import { STICKY_CELL } from "./report-table"

// The running balance of one account or liability: what it opened at, what came in and went out, and what it closed at,
// by day over a short range and by month over a long one (AccountHistoryView; the server stepped every balance). A
// liability is read as it is everywhere else in the app, as an amount owed ("₹15,000.00 owed"), never as a negative
// balance, and its line is drawn as the amount owed, so paying a card down reads as the line falling. Each period opens
// its entries in the account, so its movement can be checked on the Transactions screen.

const COLUMNS = ["Period", "Opening", "Money in", "Money out", "Closing"] as const

const TONE: Record<BalanceText["tone"], string> = {
  negative: "text-negative",
  positive: "text-positive",
  muted: "text-fg-soft",
  neutral: "",
}

/** The balance as its row shows it: "₹15,000.00 owed", "₹1,23,500.00". */
function balanceWords(kind: AccountRef["kind"], paise: string): { text: string; tone: string } {
  const balance = describeBalance(kind, paise)
  return { text: balance.qualifier ? `${balance.amount} ${balance.qualifier}` : balance.amount, tone: TONE[balance.tone] }
}

/** Paise text with its sign turned over: what a liability's balance is as an amount owed. Text only, never a number. */
const owedOf = (paise: string) => (paise === "0" ? paise : paise.startsWith("-") ? paise.slice(1) : `-${paise}`)

function Picker({ view, choice }: { view: AccountHistoryView; choice: RangeChoice }) {
  const of = (kind: AccountRef["kind"]) =>
    view.accounts.filter((account) => account.kind === kind).map((account) => ({ value: account.id, label: account.name, archived: account.archived }))
  const groups = (["ASSET", "LIABILITY"] as const).flatMap((kind) => {
    const options = of(kind)
    return options.length > 0 ? [{ label: KIND_COPY[kind].plural, options }] : []
  })
  return <NodePicker slug="accounts" choice={choice} label="Account" value={view.selected?.id ?? ""} groups={groups} placeholder="Choose an account" />
}

export function AccountHistoryReport({ view, choice }: { view: AccountHistoryView; choice: RangeChoice }) {
  if (view.empty) return <NothingToReport />
  if (view.accounts.length === 0) return <NoAccounts />
  const { selected, steps } = view
  if (selected === null || steps.length === 0) {
    return (
      <div className="space-y-6">
        <Picker view={view} choice={choice} />
        <p className="text-fg-soft">Choose an account to see how its balance moved over this range.</p>
      </div>
    )
  }

  const owed = selected.kind === "LIABILITY"
  const labels = steps.map((row) => periodLabel(row.bucket))
  const unit = view.granularity === "day" ? "day" : "month"
  const first = steps[0]
  const last = steps[steps.length - 1]
  const words = (paise: string) => balanceWords(selected.kind, paise)
  const title = `${selected.name}: ${owed ? "amount owed" : "balance"} at the end of each ${unit}`
  const summary = `${selected.name} opened at ${words(first.openingPaise).text} on ${formatDay(first.bucket.from)} and closed at ${words(last.closingPaise).text} on ${formatDay(last.bucket.to)}.`

  return (
    <div className="space-y-6">
      <Picker view={view} choice={choice} />

      <div className="rise">
        <LineChart
          title={title}
          summary={summary}
          labels={labels}
          series={[
            {
              key: "closing",
              label: owed ? "Owed" : "Balance",
              tone: "accent",
              values: steps.map((row) => (owed ? owedOf(row.closingPaise) : row.closingPaise)),
              texts: steps.map((row) => words(row.closingPaise).text),
            },
          ]}
          table={{
            columns: [...COLUMNS],
            rows: steps.map((row, index) => ({
              label: labels[index],
              cells: [words(row.openingPaise).text, formatPaiseText(row.inPaise), formatPaiseText(row.outPaise), words(row.closingPaise).text],
            })),
          }}
        />
      </div>

      <SpotlightCard
        as="section"
        aria-labelledby="account-table-heading"
        className="surface rise rounded-3xl p-5 sm:p-6"
        radius={460}
        strength={9}
        style={{ "--i": 1 } as React.CSSProperties}
      >
        <h2 id="account-table-heading" className="font-display text-lg font-semibold tracking-tight">
          {unit === "day" ? "Day by day" : "Month by month"}
        </h2>
        <p className="mt-1 text-sm text-fg-soft">Each {unit} opens its entries in {selected.name}.</p>
        {/* Relative, so the screen-reader-only text in the cells (absolutely placed) is clipped with the table, not left out past the page edge. */}
        <div className="relative -mx-5 mt-4 overflow-x-auto px-5 sm:-mx-6 sm:px-6">
          <table data-report-table className="figures w-full border-collapse text-[13px] sm:text-[15px]">
            <caption className="sr-only">
              {selected.name}: opening balance, money in, money out and closing balance by {unit}, {formatDay(view.range.from)} to {formatDay(view.range.to)}
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
            {steps.map((row, index) => {
              const opening = words(row.openingPaise)
              const closing = words(row.closingPaise)
              return (
                <tbody key={row.bucket.key} className="border-b border-line last:border-0">
                  <tr data-row className="transition-colors hover:bg-panel-raised">
                    <th scope="row" className={cn(STICKY_CELL, "whitespace-nowrap py-2.5 pr-3 text-left font-medium sm:pr-4")}>
                      <DrillLink drill={row.drill} context={`, entries of ${selected.name}`}>
                        {labels[index]}
                      </DrillLink>
                    </th>
                    <td className={cn("whitespace-nowrap py-2.5 pl-3 text-right sm:pl-4", opening.tone)}>{opening.text}</td>
                    <td className="whitespace-nowrap py-2.5 pl-3 text-right sm:pl-4">{formatPaiseText(row.inPaise)}</td>
                    <td className="whitespace-nowrap py-2.5 pl-3 text-right sm:pl-4">{formatPaiseText(row.outPaise)}</td>
                    <td className={cn("whitespace-nowrap py-2.5 pl-3 text-right font-semibold sm:pl-4", closing.tone)}>{closing.text}</td>
                  </tr>
                </tbody>
              )
            })}
          </table>
        </div>
      </SpotlightCard>
    </div>
  )
}

function NoAccounts() {
  return (
    <section aria-labelledby="no-accounts-heading" className="surface max-w-xl rounded-3xl p-8">
      <span aria-hidden className="grid size-12 place-items-center rounded-2xl bg-panel-raised text-accent-edge">
        <Landmark className="size-6" />
      </span>
      <h2 id="no-accounts-heading" className="mt-5 font-display text-2xl font-semibold tracking-tight">
        No accounts yet
      </h2>
      <p className="mt-2 text-fg-soft">Add a bank account, a wallet or a card, and its balance over time shows here.</p>
      <Link href="/nodes" className={buttonClass({ className: "mt-6" })}>
        Go to your ledger
      </Link>
    </section>
  )
}
