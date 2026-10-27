import { AppShell } from "@/app/app-shell"
import type { RangeChoice } from "@/domain/periods"
import type { ReportSlug } from "@/lib/report-nav"
import type { RangeView } from "@/lib/report-view"
import { RangeControl, type RangeOptions } from "./range-control"
import { ReportNotes } from "./report-notes"
import { ReportTabs } from "./report-tabs"

// The frame of every report screen: the app's navigation, the heading, one tab per report, the range control that scopes
// everything under it, and the notes on what the range leaves out. The report itself is `children`.

interface Props {
  current: ReportSlug
  /** The range the report was drawn over, as the server resolved it. */
  range: RangeView
  /** The range as asked for (or the default, when what was asked for could not be used). */
  choice: RangeChoice
  options: RangeOptions
  /** Why the range in the URL could not be used, shown beside the control; null when it could. */
  rangeError: string | null
  children: React.ReactNode
}

export function ReportShell({ current, range, choice, options, rangeError, children }: Props) {
  return (
    <AppShell current="reports">
      <main className="mx-auto max-w-6xl px-4 pb-20 pt-8 sm:px-8">
        <h1 className="font-display text-3xl font-semibold tracking-tight sm:text-4xl">Reports</h1>
        <div className="mt-6 space-y-4">
          <ReportTabs current={current} choice={choice} />
          {/* Keyed by the range, so the control starts again from what the server resolved whenever the range changes. */}
          <RangeControl
            key={`${current}:${JSON.stringify(choice)}:${rangeError ?? ""}`}
            current={current}
            choice={choice}
            range={range}
            options={options}
            rangeError={rangeError}
          />
          <ReportNotes range={range} />
        </div>
        <div className="mt-8">{children}</div>
      </main>
    </AppShell>
  )
}
