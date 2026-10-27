"use client"

import { useRouter } from "next/navigation"
import { useId, useState } from "react"
import { ChoiceGroup, type Choice } from "@/components/ui/choice-group"
import { Collapse } from "@/components/ui/collapse"
import { buttonClass, inputClass } from "@/components/ui/styles"
import type { CalendarDate } from "@/domain/calendar-date"
import type { RangeChoice } from "@/domain/periods"
import { reportHref, type ReportSlug } from "@/lib/report-nav"
import type { RangeOptions, RangeView } from "@/lib/report-view"
import { formatDay } from "@/lib/transaction-text"
import { cn } from "@/lib/utils"

// The one range control every report shares: the last 12 months, one month, one financial year, or from one day to
// another. The range lives in the URL, so applying it navigates (the back button undoes it, and the report can be
// bookmarked); the node a report is looking at comes along. The server parses the URL strictly and, when it cannot use
// what it was given, says why (`rangeError`) and shows the default; the message sits beside the control and is tied to it
// with aria-describedby. Only an empty field is caught here, since there is nothing to send for it.

// The pickers' options are made by the server (loadRangeOptions); the type lives with the other report views.
export type { RangeOptions }

type Kind = RangeChoice["kind"]

const KINDS: readonly Choice<Kind>[] = [
  { value: "last12", label: "Last 12 months" },
  { value: "month", label: "Month" },
  { value: "fy", label: "Financial year" },
  { value: "custom", label: "Custom" },
]

const pad = (n: number) => String(n).padStart(2, "0")
const monthValue = ({ year, month }: { year: number; month: number }) => `${year}-${pad(month)}`

/** "FY 2025–26" for the financial year starting in 2025; "FY 2025" when financial years are calendar years. */
export function fyLabel(startYear: number, startMonth = 4): string {
  return startMonth === 1 ? `FY ${startYear}` : `FY ${startYear}–${pad((startYear + 1) % 100)}`
}

interface Props {
  current: ReportSlug
  choice: RangeChoice
  range: RangeView
  options: RangeOptions
  rangeError: string | null
}

export function RangeControl({ current, choice, range, options, rangeError }: Props) {
  const router = useRouter()
  const id = useId()
  const [kind, setKind] = useState<Kind>(choice.kind)
  const [month, setMonth] = useState(
    choice.kind === "month" ? monthValue(choice) : options.months[0] ? monthValue(options.months[0]) : range.to.slice(0, 7),
  )
  const [fy, setFy] = useState(String(choice.kind === "fy" ? choice.startYear : (options.fys[0] ?? Number(range.from.slice(0, 4)))))
  const [from, setFrom] = useState<string>(choice.kind === "custom" ? choice.from : range.from)
  const [to, setTo] = useState<string>(choice.kind === "custom" ? choice.to : range.to)
  const [missing, setMissing] = useState<string | null>(null)

  // A year asked for by URL that is not in the list (before the first entry) still shows as chosen.
  const fys = choice.kind === "fy" && !options.fys.includes(choice.startYear) ? [choice.startYear, ...options.fys] : options.fys
  const oldest = options.months.at(-1)
  const newest = options.months[0]

  const problem = missing ?? rangeError
  const errorId = `${id}-error`
  const described = problem ? errorId : undefined

  function chosen(): RangeChoice | string {
    switch (kind) {
      case "last12":
        return { kind: "last12" }
      case "month": {
        const match = /^(\d{4})-(\d{2})$/.exec(month)
        return match ? { kind: "month", year: Number(match[1]), month: Number(match[2]) } : "Choose a month."
      }
      case "fy":
        return /^\d{4}$/.test(fy) ? { kind: "fy", startYear: Number(fy) } : "Choose a financial year."
      case "custom":
        // The dates are checked on the server, which says what is wrong with them; here only that both are there.
        return from && to ? { kind: "custom", from: from as CalendarDate, to: to as CalendarDate } : "Choose both a start and an end date."
    }
  }

  function apply(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const next = chosen()
    if (typeof next === "string") {
      setMissing(next)
      return
    }
    setMissing(null)
    const node = new URLSearchParams(window.location.search).get("node") ?? undefined
    router.push(reportHref(current, next, { node }))
  }

  const invalid = problem ? (true as const) : undefined

  return (
    <form onSubmit={apply} noValidate aria-label="Report range" className="surface rounded-3xl p-4 sm:p-5">
      <div className="flex flex-col gap-4 lg:flex-row lg:flex-wrap lg:items-end">
        <fieldset aria-describedby={described} className="min-w-0">
          <legend className="mb-2 text-sm font-medium">Range</legend>
          <ChoiceGroup name={`${id}-kind`} value={kind} onChange={setKind} options={KINDS} />
        </fieldset>
        <Collapse open={kind === "month"}>
          <label htmlFor={`${id}-month`} className="text-sm font-medium">
            Which month
          </label>
          <input
            id={`${id}-month`}
            type="month"
            value={month}
            min={oldest ? monthValue(oldest) : undefined}
            max={newest ? monthValue(newest) : undefined}
            onChange={(event) => setMonth(event.target.value)}
            aria-invalid={invalid}
            aria-describedby={described}
            className={cn(inputClass, "figures mt-1.5 sm:w-52")}
          />
        </Collapse>
        <Collapse open={kind === "fy"}>
          <label htmlFor={`${id}-fy`} className="text-sm font-medium">
            Which financial year
          </label>
          <select
            id={`${id}-fy`}
            value={fy}
            onChange={(event) => setFy(event.target.value)}
            aria-invalid={invalid}
            aria-describedby={described}
            className={cn(inputClass, "figures mt-1.5 sm:w-52")}
          >
            {fys.length === 0 && <option value="">No entries yet</option>}
            {fys.map((year) => (
              <option key={year} value={year}>
                {fyLabel(year, options.fyStartMonth)}
              </option>
            ))}
          </select>
        </Collapse>
        <Collapse open={kind === "custom"}>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor={`${id}-from`} className="text-sm font-medium">
                From date
              </label>
              <input
                id={`${id}-from`}
                type="date"
                value={from}
                onChange={(event) => setFrom(event.target.value)}
                aria-invalid={invalid}
                aria-describedby={described}
                className={cn(inputClass, "figures mt-1.5")}
              />
            </div>
            <div>
              <label htmlFor={`${id}-to`} className="text-sm font-medium">
                To date
              </label>
              <input
                id={`${id}-to`}
                type="date"
                value={to}
                onChange={(event) => setTo(event.target.value)}
                aria-invalid={invalid}
                aria-describedby={described}
                className={cn(inputClass, "figures mt-1.5")}
              />
            </div>
          </div>
        </Collapse>
        <button type="submit" className={buttonClass({ size: "md", className: "self-start lg:self-end" })}>
          Show
        </button>
      </div>
      {problem && (
        <p id={errorId} className="mt-3 text-sm font-medium text-negative">
          {/* The server's messages carry no full stop of their own. */}
          {problem.replace(/\.?$/, ".")}
          {/* Holds only because the report page falls back to last12 whenever it passes a rangeError: keep the two in step. */}
          {rangeError && !missing && " Showing the last 12 months instead."}
        </p>
      )}
      <p className="figures mt-3 text-sm text-fg-soft">
        Showing {formatDay(range.from)} to {range.clampedToToday ? `today, ${formatDay(range.to)}` : formatDay(range.to)}.
      </p>
    </form>
  )
}
