"use client"

import { CircleAlert, LoaderCircle } from "lucide-react"
import { useMemo, useState, useTransition } from "react"
import { buttonClass } from "@/components/ui/styles"
import type { CalendarDate } from "@/domain/calendar-date"
import type { FilterValues, PickerNode, TransactionPage } from "@/lib/transaction-list-view"
import { formatDay } from "@/lib/transaction-text"
import type { TransactionView } from "@/lib/transaction-view"
import { listTransactionsAction } from "./actions"
import { appendEntries } from "./entries"
import type { Announce } from "./notice"
import { describeTransactionFailure } from "./transaction-failure"
import { EntryRow } from "./transaction-row"

// The list: the page the server rendered, then further pages on request, newest first. Pages are cut by keyset, never
// by offset (the cursor is a position in the order), so a row added meanwhile cannot shift what the next page holds.
// A split is one entry however many transactions it is, and it is shown whole even when a cut fell inside it; see
// appendEntries for how the second sighting of it is dropped.

interface Props {
  page: TransactionPage
  filter: FilterValues
  /** The filter had problems: nothing is listed, because a list the filter did not make would be wrong. */
  blocked: boolean
  nodes: PickerNode[]
  today: CalendarDate
  announce: Announce
  onEdit: (transaction: TransactionView) => void
}

function describeRange(filter: FilterValues): string {
  const day = (value: string) => (/^\d{4}-\d{2}-\d{2}$/.test(value) ? formatDay(value as CalendarDate) : null)
  const from = day(filter.from)
  const to = day(filter.to)
  if (from && to) return `${from} to ${to}`
  if (from) return `From ${from}`
  if (to) return `Up to ${to}`
  return "All dates"
}

export function TransactionList({ page, filter, blocked, nodes, today, announce, onEdit }: Props) {
  // The server sends a fresh `page` whenever something was written or the filter changed; what was appended to the old
  // one is then stale, so it is dropped and the list starts again from the new first page.
  const [shown, setShown] = useState(page)
  const [entries, setEntries] = useState(page.entries)
  const [cursor, setCursor] = useState(page.nextCursor)
  if (shown !== page) {
    setShown(page)
    setEntries(page.entries)
    setCursor(page.nextCursor)
  }

  const [pending, startTransition] = useTransition()
  const [problem, setProblem] = useState<string | null>(null)
  const byId = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes])

  function loadMore() {
    if (cursor === null) return
    setProblem(null)
    startTransition(async () => {
      const result = await listTransactionsAction({ ...filter, cursor })
      if (!result.ok) {
        setProblem(describeTransactionFailure(result).message)
        return
      }
      setEntries((current) => appendEntries(current, result.data.entries))
      setCursor(result.data.nextCursor)
    })
  }

  return (
    <section aria-labelledby="entries-heading" className="surface rounded-3xl p-4 sm:p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 px-2">
        <h2 id="entries-heading" className="font-display text-xl font-semibold tracking-tight">
          Entries
        </h2>
        <span className="figures text-sm text-fg-soft">{describeRange(filter)}</span>
      </div>
      {blocked ? (
        <p className="mt-3 px-2 text-fg-soft">Fix the highlighted filters to see transactions.</p>
      ) : entries.length === 0 ? (
        <p className="mt-3 px-2 text-fg-soft">Nothing recorded for these filters. Widen the dates, or record a transaction.</p>
      ) : (
        <ul className="mt-3 space-y-0.5">
          {entries.map((entry) => (
            <EntryRow
              key={entry.kind === "group" ? `group-${entry.groupId}` : entry.transaction.id}
              entry={entry}
              context={{ nodes: byId, today, announce, onEdit }}
            />
          ))}
        </ul>
      )}
      {cursor !== null && !blocked && (
        <div className="mt-4 px-2">
          <button type="button" disabled={pending} onClick={loadMore} className={buttonClass({ variant: "secondary", size: "sm" })}>
            {pending && <LoaderCircle aria-hidden className="size-4 animate-spin" />}
            Load more
          </button>
          {problem && (
            <p role="alert" className="mt-3 flex max-w-lg items-start gap-2.5 rounded-xl bg-negative-wash px-3.5 py-2.5 text-sm font-medium text-negative">
              <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
              <span>{problem}</span>
            </p>
          )}
        </div>
      )}
    </section>
  )
}
