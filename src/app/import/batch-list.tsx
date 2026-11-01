"use client"

import { CircleCheck, FileUp, ListChecks, Trash2, Undo2, Upload } from "lucide-react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useEffect, useId, useRef, useState, useTransition } from "react"
import { attempt, couldNot } from "@/app/feedback"
import type { Announce, TransactionNotice } from "@/app/transactions/notice"
import { Collapse } from "@/components/ui/collapse"
import { NoticeToast, type ToastNotice } from "@/components/ui/notice-toast"
import { SpotlightCard } from "@/components/ui/spotlight-card"
import { buttonClass } from "@/components/ui/styles"
import type { BatchView } from "@/lib/import-view"
import { discardBatchAction } from "./actions"

// The import list (design §6): every batch the user has ever uploaded, newest first, each with its account, file
// name, row count, a status chip that says its state in words (never by colour alone) and the one action that moves
// it forward. A batch still in UPLOADED or STAGED can be discarded, behind a confirm naming exactly what goes;
// COMMITTED, REVERSED and DISCARDED are final, and offer no discard.

type Status = BatchView["status"]

const STATUS: Record<Status, { label: string; Icon: typeof Upload; className: string }> = {
  UPLOADED: { label: "Uploaded", Icon: FileUp, className: "border-line-strong bg-panel text-fg-soft" },
  STAGED: { label: "Staged", Icon: ListChecks, className: "border-accent-edge/60 bg-accent/10 text-accent-edge" },
  COMMITTED: { label: "Committed", Icon: CircleCheck, className: "border-positive/60 bg-positive/10 text-positive" },
  REVERSED: { label: "Reversed", Icon: Undo2, className: "border-notice-fg/60 bg-notice-wash text-notice-fg" },
  DISCARDED: { label: "Discarded", Icon: Trash2, className: "border-line-strong text-fg-soft" },
}

function StatusChip({ status }: { status: Status }) {
  const { label, Icon, className } = STATUS[status]
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium ${className}`}>
      <Icon aria-hidden className="size-3.5" />
      {label}
    </span>
  )
}

/** What the next step is, for a batch in this status; null for a final status with nothing more to do here. */
function nextAction(batch: BatchView): { href: string; label: string } | null {
  switch (batch.status) {
    case "UPLOADED":
      return { href: `/import/${batch.id}/map`, label: "Continue" }
    case "STAGED":
      return { href: `/import/${batch.id}/review`, label: "Review" }
    case "COMMITTED":
    case "REVERSED":
      return { href: `/import/${batch.id}`, label: "View" }
    case "DISCARDED":
      return null
  }
}

const canDiscard = (status: Status) => status === "UPLOADED" || status === "STAGED"

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function useDiscardBatch(batch: BatchView, announce: Announce) {
  const router = useRouter()
  const confirmId = useId()
  const keepId = `${confirmId}-keep`
  const discardId = `${confirmId}-discard`
  const inFlight = useRef(false)
  const [confirming, setConfirming] = useState(false)
  const [pending, startTransition] = useTransition()

  useEffect(() => {
    if (confirming) document.getElementById(keepId)?.focus()
  }, [confirming, keepId])

  function remove() {
    if (inFlight.current) return
    inFlight.current = true
    startTransition(async () => {
      try {
        const result = await attempt(() => discardBatchAction({ id: batch.id }))
        if (result === null || !result.ok) {
          announce({ tone: "warning", lines: [couldNot(`discard the ${batch.fileName} import`, result)] })
          if (result !== null && !result.ok && result.error.code === "not_found") router.refresh()
          return
        }
        announce({ tone: "success", lines: [`Discarded ${batch.fileName}. Nothing from it was recorded.`] }, true)
        router.refresh()
      } finally {
        inFlight.current = false
      }
    })
  }

  return {
    confirming,
    pending,
    confirmId,
    keepId,
    discardId,
    toggle: () => {
      if (!pending) setConfirming((current) => !current)
    },
    keep: () => {
      if (pending) return
      setConfirming(false)
      document.getElementById(discardId)?.focus()
    },
    remove,
  }
}

function BatchRow({ batch, index, announce }: { batch: BatchView; index: number; announce: Announce }) {
  const discard = useDiscardBatch(batch, announce)
  const action = nextAction(batch)
  return (
    <SpotlightCard as="li" className="surface rise rounded-2xl p-4 sm:p-5" style={{ "--i": index } as React.CSSProperties} radius={300} strength={10}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
            <h3 className="min-w-0 font-display text-lg font-semibold tracking-tight [overflow-wrap:anywhere]">{batch.fileName}</h3>
            <StatusChip status={batch.status} />
          </div>
          <p className="mt-1 text-sm text-fg-soft">
            {batch.accountName} &middot; {batch.rowCount} {batch.rowCount === 1 ? "row" : "rows"} &middot; {formatFileSize(batch.fileSize)}
          </p>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {action && (
          <Link href={action.href} className={buttonClass({ variant: "primary", size: "sm" })}>
            {action.label}
            <span className="sr-only"> importing {batch.fileName}</span>
          </Link>
        )}
        {canDiscard(batch.status) && (
          <button
            type="button"
            id={discard.discardId}
            aria-expanded={discard.confirming}
            aria-controls={discard.confirming ? discard.confirmId : undefined}
            aria-disabled={discard.pending}
            onClick={discard.toggle}
            className={buttonClass({ variant: "ghost", size: "sm", className: "aria-disabled:opacity-55" })}
          >
            <Trash2 aria-hidden className="size-4" />
            Discard<span className="sr-only"> {batch.fileName} import</span>
          </button>
        )}
      </div>

      <Collapse open={discard.confirming} id={discard.confirmId}>
        <div role="group" aria-label={`Discard the ${batch.fileName} import?`} className="mt-4 rounded-2xl border border-negative/60 bg-negative-wash p-4">
          <p className="text-sm font-medium text-negative">Discard the {batch.fileName} import?</p>
          <p className="mt-1 text-sm text-fg">
            {batch.status === "STAGED"
              ? "This removes every row it staged. No transaction has been recorded from it, so nothing else is touched."
              : "Nothing was recorded from it yet, so nothing else is touched."}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              aria-disabled={discard.pending}
              onClick={discard.remove}
              className={buttonClass({ variant: "danger", size: "sm", className: "aria-disabled:opacity-55" })}
            >
              Discard import<span className="sr-only"> {batch.fileName}</span>
            </button>
            <button
              type="button"
              id={discard.keepId}
              aria-disabled={discard.pending}
              onClick={discard.keep}
              className={buttonClass({ variant: "secondary", size: "sm", className: "aria-disabled:opacity-55" })}
            >
              Keep it<span className="sr-only"> {batch.fileName} import</span>
            </button>
          </div>
        </div>
      </Collapse>
    </SpotlightCard>
  )
}

function EmptyState() {
  return (
    <section aria-labelledby="no-imports" className="surface rounded-3xl p-6 sm:p-10">
      <Upload aria-hidden className="size-8 text-accent-edge" />
      <h2 id="no-imports" className="mt-4 font-display text-xl font-semibold tracking-tight">
        Bring in a bank or card statement
      </h2>
      <p className="mt-2 max-w-prose text-fg-soft">
        An import reads a CSV statement from your bank or card, lets you choose what each column means and preview the
        result, then adds the rows you confirm as transactions on an account of your own. Nothing is recorded until you
        say so.
      </p>
      <Link href="/import/new" className={`${buttonClass()} mt-6`}>
        <Upload aria-hidden className="size-4" />
        New import
      </Link>
    </section>
  )
}

export function BatchList({ batches }: { batches: BatchView[] }) {
  const [notice, setNotice] = useState<ToastNotice | null>(null)
  const statusRef = useRef<HTMLDivElement>(null)

  const announce: Announce = (next: TransactionNotice, moveFocus = false) => {
    setNotice(next)
    if (moveFocus) requestAnimationFrame(() => statusRef.current?.focus())
  }

  return (
    <main className="mx-auto max-w-5xl px-4 pb-28 pt-8 sm:px-8">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="font-display text-3xl font-semibold tracking-tight sm:text-4xl">Import</h1>
        {batches.length > 0 && (
          <Link href="/import/new" className={buttonClass()}>
            <Upload aria-hidden className="size-4" />
            New import
          </Link>
        )}
      </div>
      <div className="mt-8">
        {batches.length === 0 ? (
          <EmptyState />
        ) : (
          <ul aria-label="Your imports" className="space-y-4">
            {batches.map((batch, index) => (
              <BatchRow key={batch.id} batch={batch} index={index} announce={announce} />
            ))}
          </ul>
        )}
      </div>
      <NoticeToast notice={notice} onDismiss={() => setNotice(null)} statusRef={statusRef} />
    </main>
  )
}
