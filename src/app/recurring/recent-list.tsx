"use client"

import { ChevronDown, Undo2 } from "lucide-react"
import { useRouter } from "next/navigation"
import { useId, useState, useTransition } from "react"
import { Amount } from "@/app/amount"
import type { Announce } from "@/app/transactions/notice"
import { Collapse } from "@/components/ui/collapse"
import { buttonClass } from "@/components/ui/styles"
import { calendarDate } from "@/domain/calendar-date"
import type { OccurrenceView } from "@/lib/recurring-view"
import { formatDay } from "@/lib/transaction-text"
import { cn } from "@/lib/utils"
import { restoreOccurrenceAction } from "./actions"
import { attempt, couldNot, figure } from "./feedback"

// What was posted or skipped lately, behind a disclosure: the screen is for what is waiting, and this is for the moment
// after a mistake. A skipped entry can be put back; a posted one is a transaction now and is changed on the Transactions
// screen. Nothing is drawn when there is nothing to show.

/** Put a skipped entry back in the inbox, and say so. Also the undo of a skip. */
export async function putBack(occurrence: OccurrenceView, announce: Announce, router: { refresh: () => void }) {
  const result = await attempt(() => restoreOccurrenceAction({ id: occurrence.id }))
  if (result === null || !result.ok) {
    announce({ tone: "warning", lines: [couldNot(`put back ${occurrence.ruleName}`, result)] })
    // A card that is gone (handled in another tab) is a stale screen: read it again.
    if (result !== null && !result.ok && result.error.code === "not_found") router.refresh()
    return
  }
  announce(
    { tone: "success", lines: [`Put back ${occurrence.ruleName}, due ${formatDay(calendarDate(occurrence.dueOn))}. It is waiting in the inbox again.`] },
    true, // the button that was pressed is gone with the row
  )
  router.refresh()
}

export function RecentList({ recent, announce }: { recent: OccurrenceView[]; announce: Announce }) {
  const panelId = useId()
  const headingId = useId()
  const [open, setOpen] = useState(false)
  if (recent.length === 0) return null
  return (
    <section aria-labelledby={headingId} className="mt-12">
      <h2 id={headingId} className="font-display text-lg font-semibold tracking-tight">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          onClick={() => setOpen((current) => !current)}
          className="-mx-2 inline-flex items-center gap-2 rounded-lg px-2 py-1 text-left hover:bg-panel-raised"
        >
          Recently handled
          <span className="text-sm font-normal text-fg-soft">{recent.length}</span>
          <ChevronDown aria-hidden className={cn("size-4 text-fg-soft transition-transform duration-200", open && "rotate-180")} />
        </button>
      </h2>
      <Collapse open={open} id={panelId}>
        <ul className="surface mt-3 divide-y divide-line rounded-2xl">
          {recent.map((occurrence) => (
            <Row key={occurrence.id} occurrence={occurrence} announce={announce} />
          ))}
        </ul>
      </Collapse>
    </section>
  )
}

function Row({ occurrence, announce }: { occurrence: OccurrenceView; announce: Announce }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const skipped = occurrence.status === "DISMISSED"
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
      <div className="min-w-0 flex-1 basis-48">
        <p className="truncate font-medium">{occurrence.ruleName}</p>
        <p className="text-sm text-fg-soft">
          {skipped ? "Skipped" : "Posted"}, due {formatDay(calendarDate(occurrence.dueOn))}
        </p>
      </div>
      <Amount text={figure(occurrence.amountPaise)} className={cn("font-medium", skipped && "line-through")} />
      {skipped && (
        <button
          type="button"
          disabled={pending}
          onClick={() => startTransition(() => putBack(occurrence, announce, router))}
          className={buttonClass({ variant: "secondary", size: "sm" })}
        >
          <Undo2 aria-hidden className="size-4" />
          Put back
        </button>
      )}
    </li>
  )
}
