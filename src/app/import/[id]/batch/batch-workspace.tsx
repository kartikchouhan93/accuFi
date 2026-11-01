"use client"

import { ArrowLeft, Undo2 } from "lucide-react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useEffect, useId, useRef, useState, useTransition } from "react"
import { Amount } from "@/app/amount"
import { attempt, couldNot, figure } from "@/app/feedback"
import type { TransactionNotice } from "@/app/transactions/notice"
import { Collapse } from "@/components/ui/collapse"
import { NoticeToast, type ToastNotice } from "@/components/ui/notice-toast"
import { buttonClass } from "@/components/ui/styles"
import { calendarDate } from "@/domain/calendar-date"
import type { BatchView } from "@/lib/import-view"
import { formatDay } from "@/lib/transaction-text"
import type { CommitSummary } from "@/server/services/import-service"
import { reverseBatchAction } from "../../actions"

// The committed (or reversed) batch's own page, one client component reading one server-built view, the same "one
// load, one workspace" shape as the import list and the review screen. A reversed batch shows when it was reversed
// instead of offering Reverse again — reversing twice is a no-op on the server, but offering the button again would
// invite a confusing "nothing happened" click.

/** When the reversal happened, in the reader's own local time (unlike every other date here, a point in time, not a
 * calendar day, so this is the one place that reads a timestamp directly rather than through CalendarDate). */
function timeOf(iso: string): string {
  const date = new Date(iso)
  return date.toLocaleString(undefined, { day: "numeric", month: "long", year: "numeric", hour: "numeric", minute: "2-digit" })
}

/** Exactly what Reverse would delete, named by number rather than left vague: pulled out as its own function (rather
 * than written straight into the JSX below) so a test can pin the exact wording without needing the confirm open in
 * the document — `Collapse` removes its children from the DOM while closed. */
export function reverseConfirmText(summary: CommitSummary): string {
  return `Reversing deletes the ${summary.imported} transaction${summary.imported === 1 ? "" : "s"} this import created and returns ${summary.linked} linked recurring ${
    summary.linked === 1 ? "entry" : "entries"
  } to pending.`
}

function useReverse(batchId: string, fileName: string, summary: CommitSummary, announce: (notice: TransactionNotice, moveFocus?: boolean) => void) {
  const router = useRouter()
  const confirmId = useId()
  const keepId = `${confirmId}-keep`
  const reverseId = `${confirmId}-reverse`
  const inFlight = useRef(false)
  const [confirming, setConfirming] = useState(false)
  const [pending, startTransition] = useTransition()

  useEffect(() => {
    if (confirming) document.getElementById(keepId)?.focus()
  }, [confirming, keepId])

  function reverse() {
    if (inFlight.current) return
    inFlight.current = true
    startTransition(async () => {
      try {
        const result = await attempt(() => reverseBatchAction({ id: batchId }))
        if (result === null || !result.ok) {
          announce({ tone: "warning", lines: [couldNot(`reverse the ${fileName} import`, result)] })
          return
        }
        announce(
          {
            tone: "success",
            lines: [
              `Reversed. ${result.data.reversed} transaction${result.data.reversed === 1 ? "" : "s"} deleted${
                result.data.reopened > 0 ? `, ${result.data.reopened} recurring ${result.data.reopened === 1 ? "entry" : "entries"} reopened to pending` : ""
              }.`,
            ],
          },
          true,
        )
        router.refresh()
      } finally {
        inFlight.current = false
      }
    })
  }

  const deleteWording = reverseConfirmText(summary)

  return {
    confirming,
    pending,
    confirmId,
    keepId,
    reverseId,
    deleteWording,
    toggle: () => {
      if (!pending) setConfirming((current) => !current)
    },
    keep: () => {
      if (pending) return
      setConfirming(false)
      document.getElementById(reverseId)?.focus()
    },
    reverse,
  }
}

export function BatchWorkspace({ batch, summary }: { batch: BatchView; summary: CommitSummary }) {
  const [notice, setNotice] = useState<ToastNotice | null>(null)
  const statusRef = useRef<HTMLDivElement>(null)
  const announce = (next: TransactionNotice, moveFocus = false) => {
    setNotice(next)
    if (moveFocus) requestAnimationFrame(() => statusRef.current?.focus())
  }
  const reversed = batch.status === "REVERSED"
  const reverse = useReverse(batch.id, batch.fileName, summary, announce)

  return (
    <main className="mx-auto max-w-3xl px-4 pb-28 pt-8 sm:px-8">
      <Link href="/import" className="inline-flex items-center gap-1.5 rounded-md text-sm font-medium text-link underline underline-offset-4">
        <ArrowLeft aria-hidden className="size-4" />
        Import
      </Link>
      <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <h1 className="font-display text-3xl font-semibold tracking-tight sm:text-4xl [overflow-wrap:anywhere]">{batch.fileName}</h1>
        <span
          className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium ${
            reversed ? "border-notice-fg/60 bg-notice-wash text-notice-fg" : "border-positive/60 bg-positive/10 text-positive"
          }`}
        >
          {reversed ? <Undo2 aria-hidden className="size-3.5" /> : null}
          {reversed ? "Reversed" : "Committed"}
        </span>
      </div>
      <p className="mt-2 text-fg-soft">Onto {batch.accountName}.</p>

      <dl className="surface mt-6 grid grid-cols-2 gap-x-6 gap-y-4 rounded-2xl p-5 sm:grid-cols-4">
        <div>
          <dt className="text-sm text-fg-soft">Imported</dt>
          <dd className="figures text-xl font-medium">{summary.imported}</dd>
        </div>
        <div>
          <dt className="text-sm text-fg-soft">Skipped</dt>
          <dd className="figures text-xl font-medium">{summary.skipped}</dd>
        </div>
        <div>
          <dt className="text-sm text-fg-soft">Linked to recurring</dt>
          <dd className="figures text-xl font-medium">{summary.linked}</dd>
        </div>
        <div>
          <dt className="text-sm text-fg-soft">Errored</dt>
          <dd className="figures text-xl font-medium">{summary.errored}</dd>
        </div>
        <div>
          <dt className="text-sm text-fg-soft">Date range</dt>
          <dd className="text-lg font-medium">
            {summary.firstDate && summary.lastDate ? `${formatDay(calendarDate(summary.firstDate))} – ${formatDay(calendarDate(summary.lastDate))}` : "—"}
          </dd>
        </div>
        <div>
          <dt className="text-sm text-fg-soft">Total in</dt>
          <dd className="text-lg font-medium">
            <Amount text={figure(summary.totalInPaise)} />
          </dd>
        </div>
        <div>
          <dt className="text-sm text-fg-soft">Total out</dt>
          <dd className="text-lg font-medium">
            <Amount text={figure(summary.totalOutPaise)} />
          </dd>
        </div>
      </dl>

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <Link href={`/transactions?batch=${batch.id}`} className={buttonClass({ variant: "secondary" })}>
          See these transactions
        </Link>
        {reversed ? (
          <p className="text-sm text-fg-soft">Reversed {batch.reversedAt ? timeOf(batch.reversedAt) : ""}.</p>
        ) : (
          <button
            type="button"
            id={reverse.reverseId}
            aria-expanded={reverse.confirming}
            aria-controls={reverse.confirming ? reverse.confirmId : undefined}
            aria-disabled={reverse.pending}
            onClick={reverse.toggle}
            className={buttonClass({ variant: "ghost", className: "aria-disabled:opacity-55" })}
          >
            Reverse this import
          </button>
        )}
      </div>

      {!reversed && (
        <Collapse open={reverse.confirming} id={reverse.confirmId}>
          <div role="group" aria-label={`Reverse the ${batch.fileName} import?`} className="mt-4 rounded-2xl border border-negative/60 bg-negative-wash p-4">
            <p className="text-sm font-medium text-negative">Reverse the {batch.fileName} import?</p>
            <p className="mt-1 text-sm text-fg">{reverse.deleteWording}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button type="button" aria-disabled={reverse.pending} onClick={reverse.reverse} className={buttonClass({ variant: "danger", size: "sm", className: "aria-disabled:opacity-55" })}>
                Reverse import<span className="sr-only"> {batch.fileName}</span>
              </button>
              <button
                type="button"
                id={reverse.keepId}
                aria-disabled={reverse.pending}
                onClick={reverse.keep}
                className={buttonClass({ variant: "secondary", size: "sm", className: "aria-disabled:opacity-55" })}
              >
                Keep it<span className="sr-only"> {batch.fileName} import</span>
              </button>
            </div>
          </div>
        </Collapse>
      )}

      <NoticeToast notice={notice} onDismiss={() => setNotice(null)} statusRef={statusRef} />
    </main>
  )
}
