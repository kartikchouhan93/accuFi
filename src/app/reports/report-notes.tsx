import { CalendarClock, ChartColumn, Flag, Plus } from "lucide-react"
import Link from "next/link"
import { buttonClass } from "@/components/ui/styles"
import { addDays } from "@/domain/calendar-date"
import type { RangeView } from "@/lib/report-view"
import { formatDay } from "@/lib/transaction-text"

// What a report's range leaves out, said in words beside it rather than left to be guessed from the chart: that the
// ledger only begins partway through (so the months before are not a run of zeros), and how many entries are dated after
// today and so are in no figure (EC-10), with a link to them. And, for someone who has recorded nothing, a way to start
// instead of a flat chart of zeros.

export function ReportNotes({ range }: { range: RangeView }) {
  const notes: React.ReactNode[] = []
  if (range.historyBegins) {
    notes.push(
      <li key="history" className="flex items-start gap-2">
        <Flag aria-hidden className="mt-0.5 size-4 shrink-0" />
        <span>History begins {formatDay(range.historyBegins)}.</span>
      </li>,
    )
  }
  if (range.futureCount > 0) {
    const one = range.futureCount === 1
    notes.push(
      <li key="future" className="flex items-start gap-2">
        <CalendarClock aria-hidden className="mt-0.5 size-4 shrink-0" />
        <span>
          <Link href={`/transactions?from=${addDays(range.to, 1)}&to=`} className="rounded-md font-medium text-link underline underline-offset-4">
            {range.futureCount} future-dated {one ? "entry" : "entries"}
          </Link>{" "}
          {one ? "is" : "are"} not included.
        </span>
      </li>,
    )
  }
  if (notes.length === 0) return null
  return <ul className="figures flex flex-wrap gap-x-6 gap-y-2 text-sm text-fg-soft">{notes}</ul>
}

/** The empty state of every report: nothing has been recorded, so there is nothing to chart. */
export function NothingToReport() {
  return (
    <section aria-labelledby="nothing-heading" className="surface max-w-xl rounded-3xl p-8">
      <span aria-hidden className="grid size-12 place-items-center rounded-2xl bg-panel-raised text-accent-edge">
        <ChartColumn className="size-6" />
      </span>
      <h2 id="nothing-heading" className="mt-5 font-display text-2xl font-semibold tracking-tight">
        Nothing to report yet
      </h2>
      <p className="mt-2 text-fg-soft">
        Reports are drawn from what you record. Once money has come in, gone out or moved between accounts, this page shows where it went and how
        things have changed.
      </p>
      <Link href="/transactions" className={buttonClass({ className: "mt-6" })}>
        <Plus aria-hidden className="size-4" />
        Record a transaction
      </Link>
    </section>
  )
}
