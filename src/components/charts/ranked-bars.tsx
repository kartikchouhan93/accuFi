"use client"

import { cn } from "@/lib/utils"
import { useChartEntrance } from "./chart-interaction"

// A ranked list with a share-of-total bar under each name: the biggest first, as the report ranks them. It is a list, not a
// picture: the name, the amount and the share are text, and the bar beside them is decoration that only draws the share,
// so it is hidden from assistive technology. The bar's length is the share itself (85.2% of the track for 85.2%), so the
// bars of a list add up to about a whole track; a row with no share (a refund, a child line) has no bar and no percentage.
// The amount comes already formatted by the report; nothing here reads it as a number.

export interface RankedBarRow {
  key: string
  /** The row's name, usually a link to the entries it is made of. */
  label: React.ReactNode
  /** The amount as the report formats it. */
  amount: string
  /** Tenths of a percent (852 is 85.2%); null for no share. */
  shareTenths: number | null
  /** Drawn quieter: a line that is not ranked against the others. */
  muted?: boolean
  /** Shown under the row, inside it: what the row is made of, when the report lets it open. */
  detail?: React.ReactNode
}

/** 852 as "85.2%". Integer arithmetic on an integer that is at most 1000, so it is exact. */
export function formatShare(tenths: number): string {
  return `${Math.trunc(tenths / 10)}.${Math.abs(tenths % 10)}%`
}

export function RankedBars({ rows }: { rows: RankedBarRow[] }) {
  const entrance = useChartEntrance()
  return (
    <ol className={cn("space-y-1", entrance && "chart-enter")}>
      {rows.map((row, index) => (
        <li key={row.key} className={cn("rounded-2xl px-3 py-2.5 transition-colors hover:bg-panel-raised", row.muted && "text-fg-soft")}>
          <div className="flex items-baseline justify-between gap-4">
            {/* Padded on every side by more than the focus ring (2px outline, 2px offset) and pulled back by as much, so a
                link or button in the label keeps its whole ring although `truncate` clips what overflows. */}
            <span className="-m-1.5 min-w-0 truncate p-1.5 font-medium">{row.label}</span>
            <span className="figures flex shrink-0 items-baseline gap-3">
              <span className={cn(!row.muted && "font-medium text-fg")}>{row.amount}</span>
              {row.shareTenths !== null && <span className="w-14 text-right text-sm text-fg-soft">{formatShare(row.shareTenths)}</span>}
            </span>
          </div>
          {row.shareTenths !== null && (
            <div aria-hidden className="mt-2 h-1.5 overflow-hidden rounded-full bg-panel-raised ring-1 ring-line ring-inset">
              <div
                className={cn("chart-grow-x h-full rounded-full", row.muted ? "bg-fg-soft" : "bg-accent")}
                style={{ width: `${Math.min(100, Math.max(0, row.shareTenths / 10))}%`, "--i": index } as React.CSSProperties}
              />
            </div>
          )}
          {row.detail}
        </li>
      ))}
    </ol>
  )
}
