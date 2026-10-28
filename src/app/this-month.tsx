import Link from "next/link"
import { GlowingEffect } from "@/components/ui/glowing-effect"
import { SpotlightCard } from "@/components/ui/spotlight-card"
import type { DashboardView } from "@/lib/dashboard-view"
import { formatPaiseText } from "@/lib/node-money"
import { isNegative, monthLabel } from "@/lib/report-text"
import { cn } from "@/lib/utils"

// The month so far, under the net worth: what came in, what went out and what was left, as the cash flow report has
// them for the user's current month. Each tile is a link to the report that breaks its figure down, for the same month,
// so a figure here can be followed to the entries it is made of. The figures arrive as paise text; nothing is summed here.

interface Props {
  thisMonth: DashboardView["thisMonth"]
}

const MONTH_PARAM = /^month-(\d{4})-(\d{2})$/

export function ThisMonth({ thisMonth }: Props) {
  if (thisMonth === null) return null
  const { monthParam, incomePaise, spendingPaise, savedPaise } = thisMonth
  const parsed = MONTH_PARAM.exec(monthParam)
  const month = parsed ? monthLabel(`${parsed[1]}-${parsed[2]}-01`) : null
  const query = `?range=${encodeURIComponent(monthParam)}`
  const tiles = [
    { key: "income", label: "Income", report: "income", paise: incomePaise, dot: "bg-positive", opens: "the income report" },
    { key: "spending", label: "Spending", report: "spending", paise: spendingPaise, dot: "bg-accent", opens: "the spending report" },
    { key: "saved", label: "Net saved", report: "cash-flow", paise: savedPaise, dot: "bg-fg-soft", opens: "income vs expense" },
  ] as const

  return (
    <section aria-labelledby="this-month-heading">
      <div className="flex items-baseline justify-between gap-4">
        <h2 id="this-month-heading" className="font-display text-lg font-semibold tracking-tight">
          This month
        </h2>
        {month && <span className="text-sm text-fg-soft">{month}</span>}
      </div>
      <ul className="mt-4 grid gap-3 sm:grid-cols-3">
        {tiles.map((tile, index) => (
          <li key={tile.key} className="rise" style={{ "--i": index } as React.CSSProperties}>
            <SpotlightCard className="surface h-full rounded-2xl p-4 transition-transform duration-200 hover:-translate-y-0.5" radius={220}>
              <GlowingEffect />
              {/* The whole tile is the link; its name is the label and the figure, then what it opens. */}
              <Link
                href={`/reports/${tile.report}${query}`}
                className="flex items-baseline justify-between gap-3 rounded-lg after:absolute after:inset-0 after:rounded-2xl sm:block"
              >
                <span className="text-sm text-fg-soft">
                  <span aria-hidden className={cn("mr-1.5 inline-block size-2 rounded-full align-middle", tile.dot)} />
                  {tile.label}
                </span>
                <span
                  className={cn(
                    "figures block text-xl font-medium tracking-tight sm:mt-2 sm:text-2xl",
                    tile.key === "saved" && isNegative(tile.paise) && "text-negative",
                  )}
                >
                  {formatPaiseText(tile.paise)}
                </span>
                <span className="sr-only">{` in ${month ?? "this month"}: open ${tile.opens}`}</span>
              </Link>
            </SpotlightCard>
          </li>
        ))}
      </ul>
    </section>
  )
}
