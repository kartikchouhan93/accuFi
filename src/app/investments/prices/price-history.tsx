"use client"

import { CircleAlert, LoaderCircle, Trash2 } from "lucide-react"
import { useId, useState } from "react"
import { buttonClass } from "@/components/ui/styles"
import { Tag } from "@/components/ui/tag"
import type { CalendarDate } from "@/domain/calendar-date"
import { priceText } from "@/lib/investment-text"
import { formatDay } from "@/lib/transaction-text"
import { deletePriceAction } from "../actions"
import type { KnownPrice, PriceTarget } from "./price-form"

// The chosen investment's prices, newest first: the day, the price, and a Delete for each. Deleting asks nothing; the
// message that follows offers Undo, which saves the same price for the same day again (the screen does that). The newest
// price is the one that values the investment today, so it is marked, and it carries a Stale label once it is older than
// the investment's window, as on the cards (EC-24); older prices are history and are not marked.

/** What was read for the chosen investment: its prices and whether the latest is stale, or why they could not be read. */
export type HistoryState =
  | { status: "reading" }
  | { status: "failed"; message: string }
  | { status: "read"; prices: KnownPrice[]; latest: { asOf: CalendarDate; stale: boolean } | null }

interface Props {
  target: PriceTarget
  state: HistoryState
  onRetry: () => void
  /** The price was deleted: the screen says so, offers Undo, and reads the prices again. */
  onDeleted: (deleted: KnownPrice) => void
}

const linkClass = "rounded-md font-medium text-link underline underline-offset-4"

export function PriceHistory({ target, state, onRetry, onDeleted }: Props) {
  const headingId = useId()
  const [deleting, setDeleting] = useState<CalendarDate | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

  async function remove(point: KnownPrice) {
    if (deleting !== null) return
    setDeleting(point.asOf)
    setFailure(null)
    try {
      const result = await deletePriceAction({ nodeId: target.nodeId, asOf: point.asOf })
      if (!result.ok) return setFailure(`Could not delete the price for ${formatDay(point.asOf)}. ${result.error.message}`)
      onDeleted(point)
    } catch {
      setFailure(`Could not delete the price for ${formatDay(point.asOf)} just now. Check your connection and try again.`)
    } finally {
      setDeleting(null)
    }
  }

  return (
    <section aria-labelledby={headingId}>
      <h2 id={headingId} className="font-display text-lg font-semibold tracking-tight">
        Prices of {target.name}
      </h2>
      {state.status === "reading" ? (
        <p className="mt-3 text-sm text-fg-soft">Reading the prices…</p>
      ) : state.status === "failed" ? (
        <div role="alert" className="mt-3 flex flex-wrap items-start gap-2.5 rounded-xl bg-negative-wash px-3.5 py-2.5 text-sm font-medium text-negative">
          <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span className="flex-1">Could not read the prices. {state.message}</span>
          <button type="button" className={linkClass} onClick={onRetry}>
            Try again
          </button>
        </div>
      ) : state.prices.length === 0 ? (
        <p className="mt-3 text-sm text-fg-soft">No prices yet. Until it has one, {target.name} is not valued.</p>
      ) : (
        <ul className="mt-3 divide-y divide-line rounded-2xl border border-line bg-canvas/60">
          {state.prices.map((point) => {
            const latest = state.latest?.asOf === point.asOf
            return (
              <li key={point.asOf} className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-3.5 py-2.5 transition-colors duration-200 hover:bg-panel-raised">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-1.5">
                    <span className="figures whitespace-nowrap text-sm font-medium">{formatDay(point.asOf)}</span>
                    {latest && <Tag>Values it today</Tag>}
                    {latest && state.latest?.stale && <Tag className="border-negative/60 text-negative">Stale</Tag>}
                  </p>
                  <p className="figures whitespace-nowrap text-sm text-fg-soft">{priceText(point.pricePerUnitPaise, target.unit, target.lump)}</p>
                </div>
                <button
                  type="button"
                  aria-label={`Delete the price for ${formatDay(point.asOf)}`}
                  disabled={deleting !== null}
                  onClick={() => void remove(point)}
                  className={buttonClass({ variant: "ghost", size: "sm", className: "hover:text-negative" })}
                >
                  {deleting === point.asOf ? <LoaderCircle aria-hidden className="size-4 animate-spin" /> : <Trash2 aria-hidden className="size-4" />}
                  Delete
                </button>
              </li>
            )
          })}
        </ul>
      )}
      {failure && (
        <p role="alert" className="mt-3 flex items-start gap-2.5 rounded-xl bg-negative-wash px-3.5 py-2.5 text-sm font-medium text-negative">
          <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span>{failure}</span>
        </p>
      )}
    </section>
  )
}
