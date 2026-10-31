import { ChevronLeft, ChevronRight } from "lucide-react"
import Link from "next/link"
import { monthLabel } from "@/lib/budget-view"
import { buttonClass, inputClass } from "@/components/ui/styles"

// Which month the screen shows: previous and next, and a select of every month there is. All of it is plain links and a GET
// form, so it works with no scripting at all and the month is in the URL (back undoes it; it can be bookmarked). It is
// bounded by `months`, the months from the first budget to the current one: no previous link at the first, no next at the
// last, and the select offers nothing outside them.

const key = (month: string) => month.slice(0, 7)
const href = (month: string) => `/budgets?month=${key(month)}`

const STEP = "grid size-11 shrink-0 place-items-center rounded-xl border border-line-strong bg-panel text-fg transition-colors hover:border-fg-soft hover:bg-panel-raised"

export function MonthPicker({ month, months }: { month: string; months: string[] }) {
  const at = months.indexOf(month)
  const previous = at > 0 ? months[at - 1] : null
  const next = at >= 0 && at < months.length - 1 ? months[at + 1] : null
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
      <div className="flex items-center gap-2">
        {previous ? (
          <Link href={href(previous)} className={STEP}>
            <ChevronLeft aria-hidden className="size-5" />
            <span className="sr-only">Previous month, {monthLabel(previous)}</span>
          </Link>
        ) : (
          <span aria-hidden className="size-11 shrink-0" />
        )}
        <h2 className="min-w-28 text-center font-display text-lg font-semibold tracking-tight">{monthLabel(month)}</h2>
        {next ? (
          <Link href={href(next)} className={STEP}>
            <ChevronRight aria-hidden className="size-5" />
            <span className="sr-only">Next month, {monthLabel(next)}</span>
          </Link>
        ) : (
          <span aria-hidden className="size-11 shrink-0" />
        )}
      </div>
      <form action="/budgets" method="get" className="flex items-center gap-2">
        <label htmlFor="budgets-month" className="sr-only">
          Month
        </label>
        <select id="budgets-month" name="month" defaultValue={key(month)} className={`${inputClass} w-auto min-w-40`}>
          {[...months].reverse().map((option) => (
            <option key={option} value={key(option)}>
              {monthLabel(option)}
            </option>
          ))}
        </select>
        <button type="submit" className={buttonClass({ variant: "secondary" })}>
          Show
        </button>
      </form>
    </div>
  )
}
