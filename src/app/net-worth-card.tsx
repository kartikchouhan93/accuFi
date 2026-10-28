import { ArrowRight, CalendarClock } from "lucide-react"
import Link from "next/link"
import { Figure } from "@/app/figure"
import { PartialNote } from "@/app/partial-note"
import { StaleNote } from "@/app/stale-note"
import { Sparkline } from "@/components/charts/sparkline"
import { SpotlightCard } from "@/components/ui/spotlight-card"
import type { DashboardView } from "@/lib/dashboard-view"
import type { LedgerKind } from "@/domain/ledger-kind"
import { holdingsSplit } from "@/lib/holdings-split"
import { describeBalance, formatPaiseText } from "@/lib/node-money"
import { monthLabel } from "@/lib/report-text"
import { formatDay } from "@/lib/transaction-text"
import { cn } from "@/lib/utils"

// What you own less what you owe, as the dashboard opens with it. The figures arrive as paise text from the server, which
// summed every account, archived ones included. `liabilities` is already the positive amount owed (the total has
// subtracted it), so it is printed as it comes. When an investment could not be valued the total leaves it out, and the
// card says so in words next to the figure rather than letting a lower number pass for the whole picture.
//
// The figure is the one thing on the page set large, and its type does the work: the rupee sign and the paise are smaller
// and dimmer than the digits between them, because ₹1,09,749 is what matters at a glance and the .75 is not. The text is
// unbroken for anything that reads it; only the styling is split.
//
// Under the figure, its last twelve month-ends as a sparkline that opens the net worth report; each of the three parts
// of the sentence below opens its own section of the page. A month-end that left an unvalued investment out is a ring,
// and its name says it was partial. That is said in the line's name and not in the card's text: today's figure may be
// whole, and a "partial" in the card would read as being about it.

interface Props {
  netWorth: DashboardView["netWorth"]
  projected: DashboardView["projected"]
  /** The dashboard's month-ends. None on the ledger screen, which draws no trend. */
  trend?: Readonly<DashboardView["trend"]>
  /**
   * The kinds whose section is on the page (the dashboard's AccountSummary, `summary-<kind>`): a part of the sentence
   * links to its section only then. None on the ledger screen, which has no such sections.
   */
  sections?: readonly LedgerKind[]
}

const NONE: readonly never[] = []

function Dot({ className }: { className: string }) {
  return <span aria-hidden className={cn("mr-1.5 inline-block size-2 rounded-full align-middle", className)} />
}

/** A part of the sentence, as a link to its section of the page when the page has one. The words are the same either way. */
function Part({ kind, sections, children }: { kind: LedgerKind; sections: readonly LedgerKind[]; children: React.ReactNode }) {
  if (!sections.includes(kind)) return <>{children}</>
  return (
    <a
      href={`#summary-${kind}`}
      className="rounded-md underline decoration-line-strong decoration-dotted decoration-1 underline-offset-[5px] transition-colors hover:text-link hover:decoration-solid hover:decoration-current"
    >
      {children}
    </a>
  )
}

/** The sparkline's name: the span, where it began and where it stands, and which month-ends were partial. */
export function trendLabel(trend: Readonly<DashboardView["trend"]>): string {
  const first = trend[0]
  const last = trend[trend.length - 1]
  const now = `${formatPaiseText(last.totalPaise)} on ${formatDay(last.asOf)}`
  const shape =
    trend.length === 1
      ? `Net worth so far, ${monthLabel(last.asOf)}: ${now}.`
      : `Net worth at each month-end, ${monthLabel(first.asOf)} to ${monthLabel(last.asOf)}: ${formatPaiseText(first.totalPaise)} at the end of ${monthLabel(first.asOf)}, ${now}.`
  const partial = trend.filter((point) => point.partial).map((point) => monthLabel(point.asOf))
  if (partial.length === 0) return shape
  const months = partial.length === 1 ? partial[0] : `${partial.slice(0, -1).join(", ")} and ${partial[partial.length - 1]}`
  return `${shape} ${months} ${partial.length === 1 ? "is a partial figure" : "are partial figures"}: an investment could not be valued then.`
}

function Trend({ trend }: { trend: Readonly<DashboardView["trend"]> }) {
  const first = trend[0]
  const last = trend[trend.length - 1]
  const anyPartial = trend.some((point) => point.partial)
  return (
    <div className="mt-6">
      <Link
        href="/reports/net-worth"
        className="group -mx-2 block rounded-2xl px-2 pb-1 pt-1.5 transition-colors hover:bg-panel-raised"
      >
        <span className="flex items-baseline justify-between gap-3 text-xs font-medium text-fg-soft">
          <span>{trend.length === 1 ? `Since ${monthLabel(first.asOf)}` : `${monthLabel(first.asOf)} to ${monthLabel(last.asOf)}`}</span>
          <span className="inline-flex items-center gap-1 text-link">
            Net worth report
            <ArrowRight aria-hidden className="size-3.5 transition-transform group-hover:translate-x-0.5" />
          </span>
        </span>
        <Sparkline values={trend.map((point) => point.totalPaise)} hollow={trend.map((point) => point.partial)} label={trendLabel(trend)} className="mt-2" />
      </Link>
      {anyPartial && (
        <p className="mt-1.5 flex items-center gap-2 text-xs text-fg-soft">
          <span aria-hidden className="inline-block size-2.5 shrink-0 rounded-full border-2 border-accent" />
          A hollow point leaves out an investment that could not be valued at that month-end.
        </p>
      )}
    </div>
  )
}

export function NetWorthCard({ netWorth, projected, trend = NONE, sections = NONE }: Props) {
  const total = describeBalance("ASSET", netWorth.total) // a signed amount: negative reads in the negative colour with its minus sign
  const split = holdingsSplit(netWorth.assets, netWorth.investments)
  return (
    <SpotlightCard as="section" aria-labelledby="net-worth-heading" className="surface overflow-hidden rounded-3xl p-6 sm:p-8" radius={420} strength={12}>
      <span aria-hidden className="pointer-events-none absolute inset-x-8 top-0 h-px bg-gradient-to-r from-transparent via-accent-edge/70 to-transparent" />
      <h2 id="net-worth-heading" className="text-sm font-medium text-fg-soft">
        Net worth
      </h2>
      <p className={cn("figures mt-2 font-display text-5xl font-semibold tracking-tight sm:text-7xl", total.tone === "negative" && "text-negative")}>
        <Figure text={total.amount} />
      </p>
      {netWorth.isPartial && <PartialNote names={netWorth.unvaluedNames} />}
      {netWorth.staleNames.length > 0 && <StaleNote names={netWorth.staleNames} />}
      {trend.length > 0 && <Trend trend={trend} />}
      {split && (
        <div aria-hidden className="mt-7 flex h-2 w-full gap-1">
          {split.accounts > 0 && <span className="rounded-full bg-positive" style={{ flex: `${split.accounts} 1 0` }} />}
          {split.invested > 0 && <span className="rounded-full bg-link" style={{ flex: `${split.invested} 1 0` }} />}
        </div>
      )}
      <p className={cn("figures text-sm text-fg-soft", split ? "mt-3" : "mt-6")}>
        <Dot className="bg-positive" />
        <Part kind="ASSET" sections={sections}>
          <span className="font-medium text-fg">{formatPaiseText(netWorth.assets)}</span> in accounts
        </Part>
        , <Dot className="bg-link" />
        <Part kind="INVESTMENT" sections={sections}>
          <span className="font-medium text-fg">{formatPaiseText(netWorth.investments)}</span> invested
        </Part>
        , <Dot className="bg-negative" />
        <Part kind="LIABILITY" sections={sections}>
          <span className="font-medium text-negative">{formatPaiseText(netWorth.liabilities)}</span> owed
        </Part>
        .
        {netWorth.archivedCount > 0 && <span className="mt-1 block">Includes {netWorth.archivedCount} archived.</span>}
      </p>
      {projected && (
        <p className="figures mt-4 flex items-start gap-2 border-t border-line pt-4 text-sm text-fg-soft">
          <CalendarClock aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span>
            Projected <span className="font-medium text-fg">{formatPaiseText(projected.total)}</span>
            {projected.isPartial && " (partial)"} once everything dated up to{" "}
            {formatDay(projected.asOf)} has happened. Not counted above.
          </span>
        </p>
      )}
    </SpotlightCard>
  )
}
