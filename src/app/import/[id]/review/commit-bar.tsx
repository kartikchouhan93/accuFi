"use client"

import { LoaderCircle } from "lucide-react"
import { useRouter } from "next/navigation"
import { useEffect, useId, useRef, useState, useTransition } from "react"
import { attempt, couldNot } from "@/app/feedback"
import type { Announce } from "@/app/transactions/notice"
import { Collapse } from "@/components/ui/collapse"
import { buttonClass } from "@/components/ui/styles"
import type { ReviewScreen } from "@/lib/import-view"
import type { ActionFailure } from "@/server/action-support"
import { backToMappingAction, commitBatchAction, confirmSuggestionsAction, discardBatchAction } from "../../actions"

// The sticky bar above the rows: what the batch stands at, and the four things that move it along. Commit and Confirm
// suggested ledgers act at once; Back to mapping and Discard are behind a confirm, in the same ref-guarded, "keep the
// safe choice focused" shape `delete-budget.tsx` established, because both genuinely throw staged work away.

function summaryParts(counts: ReviewScreen["counts"]): string[] {
  const parts: string[] = []
  if (counts.pending > 0) parts.push(`${counts.pending} need${counts.pending === 1 ? "s" : ""} a decision`)
  if (counts.errored > 0) parts.push(`${counts.errored} error${counts.errored === 1 ? "" : "s"}`)
  parts.push(`${counts.ready} ready`)
  if (counts.skipped > 0) parts.push(`${counts.skipped} skipped`)
  return parts
}

/** Why Commit is disabled, or null once it may be pressed. Mirrors `loadReview`'s own `canCommit` rule exactly. */
function commitBlockedReason(counts: ReviewScreen["counts"]): string | null {
  if (counts.pending > 0) return `${counts.pending} row${counts.pending === 1 ? "" : "s"} still need${counts.pending === 1 ? "s" : ""} a decision.`
  if (counts.ready === 0) return "No rows are ready to import."
  return null
}

/** What "Back to mapping" throws away: pulled out as its own function (rather than written straight into the JSX
 * below) so it has one exact wording a test can check without needing the confirm actually open in the document —
 * `Collapse` removes its children from the DOM while closed, so this is the only way to pin the words themselves. */
export const backToMappingConfirmText = (fileName: string): string =>
  `Every decision staged on ${fileName}'s rows is discarded; you will stage it again from the mapping screen.`

/** What "Discard" removes: the same wording `batch-list.tsx` uses for a STAGED batch, since the review screen is only ever
 * reached for one. Exported for the same reason as `backToMappingConfirmText`. */
export const discardConfirmText = (): string => "This removes every row it staged. No transaction has been recorded from it, so nothing else is touched."

function onNotFound(code: ActionFailure["error"]["code"], refresh: () => void) {
  if (code === "not_found") refresh()
}

/** A destructive step behind a confirm: the toggle button's id, the confirm's id, "Keep it" taking the keyboard when it opens. */
function useConfirm() {
  const confirmId = useId()
  const keepId = `${confirmId}-keep`
  const goId = `${confirmId}-go`
  const [confirming, setConfirming] = useState(false)

  useEffect(() => {
    if (confirming) document.getElementById(keepId)?.focus()
  }, [confirming, keepId])

  return {
    confirming,
    confirmId,
    keepId,
    goId,
    toggle: (pending: boolean) => {
      if (!pending) setConfirming((current) => !current)
    },
    keep: (pending: boolean) => {
      if (pending) return
      setConfirming(false)
      document.getElementById(goId)?.focus()
    },
  }
}

export function CommitBar({
  batchId,
  fileName,
  counts,
  canCommit,
  announce,
  onCommittingChange,
}: {
  batchId: string
  fileName: string
  counts: ReviewScreen["counts"]
  canCommit: boolean
  announce: Announce
  /** Told when a commit starts and ends, so the workspace can hold every row's controls still meanwhile. */
  onCommittingChange?: (committing: boolean) => void
}) {
  const router = useRouter()
  const reason = commitBlockedReason(counts)
  const reasonId = useId()

  const [committing, startCommit] = useTransition()
  const commitInFlight = useRef(false)
  const [confirming, startConfirming] = useTransition()
  const confirmInFlight = useRef(false)
  const [mapping, startMapping] = useTransition()
  const mappingInFlight = useRef(false)
  const [discarding, startDiscarding] = useTransition()
  const discardInFlight = useRef(false)

  const backToMapping = useConfirm()
  const discard = useConfirm()

  function onCommit() {
    if (!canCommit || commitInFlight.current) return
    commitInFlight.current = true
    onCommittingChange?.(true)
    startCommit(async () => {
      try {
        const result = await attempt(() => commitBatchAction({ id: batchId }))
        if (result === null || !result.ok) {
          announce({ tone: "warning", lines: [couldNot("commit this import", result)] })
          // Any refusal re-reads the screen, not only a vanished batch: a commit that finds a duplicate recorded since
          // staging sends that row back to review, and the person needs to see it there to decide it.
          if (result !== null) router.refresh()
          return
        }
        router.push(`/import/${batchId}/batch`)
      } finally {
        commitInFlight.current = false
        onCommittingChange?.(false)
      }
    })
  }

  function onConfirmSuggestions() {
    if (confirmInFlight.current) return
    confirmInFlight.current = true
    startConfirming(async () => {
      try {
        const result = await attempt(() => confirmSuggestionsAction({ id: batchId }))
        if (result === null || !result.ok) {
          announce({ tone: "warning", lines: [couldNot("confirm the suggested ledgers", result)] })
          if (result !== null) onNotFound(result.error.code, router.refresh)
          return
        }
        announce(
          { tone: "success", lines: [result.data > 0 ? `Marked ${result.data} row${result.data === 1 ? "" : "s"} ready to import.` : "No rows had a suggested ledger to confirm."] },
          true,
        )
        router.refresh()
      } finally {
        confirmInFlight.current = false
      }
    })
  }

  function onBackToMapping() {
    if (mappingInFlight.current) return
    mappingInFlight.current = true
    startMapping(async () => {
      try {
        const result = await attempt(() => backToMappingAction({ id: batchId }))
        if (result === null || !result.ok) {
          announce({ tone: "warning", lines: [couldNot("go back to mapping", result)] })
          if (result !== null) onNotFound(result.error.code, router.refresh)
          return
        }
        router.push(`/import/${batchId}/map`)
      } finally {
        mappingInFlight.current = false
      }
    })
  }

  function onDiscard() {
    if (discardInFlight.current) return
    discardInFlight.current = true
    startDiscarding(async () => {
      try {
        const result = await attempt(() => discardBatchAction({ id: batchId }))
        if (result === null || !result.ok) {
          announce({ tone: "warning", lines: [couldNot(`discard the ${fileName} import`, result)] })
          if (result !== null) onNotFound(result.error.code, router.refresh)
          return
        }
        router.push("/import")
      } finally {
        discardInFlight.current = false
      }
    })
  }

  return (
    <div className="surface sticky top-4 z-10 rounded-2xl border border-line-strong bg-panel p-4 shadow-[0_18px_40px_-28px_rgb(0_0_0/0.45)] sm:p-5">
      <p className="text-sm text-fg-soft">{summaryParts(counts).join(", ")}.</p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          aria-disabled={!canCommit || committing}
          aria-describedby={reason ? reasonId : undefined}
          onClick={onCommit}
          className={buttonClass({ className: "aria-disabled:opacity-55" })}
        >
          {committing && <LoaderCircle aria-hidden className="size-4 animate-spin" />}
          Commit
        </button>
        <button type="button" aria-disabled={confirming} onClick={onConfirmSuggestions} className={buttonClass({ variant: "secondary", className: "aria-disabled:opacity-55" })}>
          Confirm suggested ledgers
        </button>
        <button
          type="button"
          id={backToMapping.goId}
          aria-expanded={backToMapping.confirming}
          aria-controls={backToMapping.confirming ? backToMapping.confirmId : undefined}
          aria-disabled={mapping}
          onClick={() => backToMapping.toggle(mapping)}
          className={buttonClass({ variant: "ghost", className: "aria-disabled:opacity-55" })}
        >
          Back to mapping
        </button>
        <button
          type="button"
          id={discard.goId}
          aria-expanded={discard.confirming}
          aria-controls={discard.confirming ? discard.confirmId : undefined}
          aria-disabled={discarding}
          onClick={() => discard.toggle(discarding)}
          className={buttonClass({ variant: "ghost", className: "aria-disabled:opacity-55" })}
        >
          Discard
        </button>
      </div>
      {reason && (
        <p id={reasonId} className="mt-2 text-sm font-medium text-notice-fg">
          {reason}
        </p>
      )}

      <Collapse open={backToMapping.confirming} id={backToMapping.confirmId}>
        <div role="group" aria-label="Back to mapping?" className="mt-4 rounded-2xl border border-negative/60 bg-negative-wash p-4">
          <p className="text-sm font-medium text-negative">Back to mapping?</p>
          <p className="mt-1 text-sm text-fg">{backToMappingConfirmText(fileName)}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" aria-disabled={mapping} onClick={onBackToMapping} className={buttonClass({ variant: "danger", size: "sm", className: "aria-disabled:opacity-55" })}>
              Back to mapping<span className="sr-only"> {fileName}</span>
            </button>
            <button
              type="button"
              id={backToMapping.keepId}
              aria-disabled={mapping}
              onClick={() => backToMapping.keep(mapping)}
              className={buttonClass({ variant: "secondary", size: "sm", className: "aria-disabled:opacity-55" })}
            >
              Keep reviewing
            </button>
          </div>
        </div>
      </Collapse>

      <Collapse open={discard.confirming} id={discard.confirmId}>
        <div role="group" aria-label={`Discard the ${fileName} import?`} className="mt-4 rounded-2xl border border-negative/60 bg-negative-wash p-4">
          <p className="text-sm font-medium text-negative">Discard the {fileName} import?</p>
          <p className="mt-1 text-sm text-fg">{discardConfirmText()}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" aria-disabled={discarding} onClick={onDiscard} className={buttonClass({ variant: "danger", size: "sm", className: "aria-disabled:opacity-55" })}>
              Discard import<span className="sr-only"> {fileName}</span>
            </button>
            <button
              type="button"
              id={discard.keepId}
              aria-disabled={discarding}
              onClick={() => discard.keep(discarding)}
              className={buttonClass({ variant: "secondary", size: "sm", className: "aria-disabled:opacity-55" })}
            >
              Keep it<span className="sr-only"> {fileName} import</span>
            </button>
          </div>
        </div>
      </Collapse>
    </div>
  )
}
