"use client"

import { LoaderCircle, Trash2 } from "lucide-react"
import { useRouter } from "next/navigation"
import { useEffect, useId, useRef, useState, useTransition, type ReactNode, type RefObject } from "react"
import { attempt, couldNot } from "@/app/feedback"
import type { Announce } from "@/app/transactions/notice"
import { Collapse } from "@/components/ui/collapse"
import { buttonClass } from "@/components/ui/styles"
import { deleteBudgetAction } from "./actions"

// Deleting a budget, as a card and an upcoming budget both do it: a Delete button that opens a confirm, a confirm that
// names the ledger and offers "Keep it" first, and the delete itself. The two halves sit in different places of their row (the
// button among the row's buttons, the confirm below them), so this is a hook and two small components rather than one.
//
// The in-flight guard is a ref, so two quick presses in the same frame cannot both start a delete; the buttons say they are
// busy with aria-disabled rather than disabled, because a disabled button drops the keyboard's place.

export interface DeleteControl {
  confirming: boolean
  pending: boolean
  confirmId: string
  keepButton: RefObject<HTMLButtonElement | null>
  deleteButton: RefObject<HTMLButtonElement | null>
  toggle: () => void
  keep: () => void
  remove: () => void
}

export function useDeleteBudget({ budgetId, name }: { budgetId: string; name: string }, announce: Announce): DeleteControl {
  const router = useRouter()
  const confirmId = useId()
  const inFlight = useRef(false)
  const keepButton = useRef<HTMLButtonElement>(null)
  const deleteButton = useRef<HTMLButtonElement>(null)
  const [confirming, setConfirming] = useState(false)
  const [pending, startTransition] = useTransition()

  // The confirm has just opened: the safe choice has the keyboard, so Enter cannot delete by accident.
  useEffect(() => {
    if (confirming) keepButton.current?.focus()
  }, [confirming])

  function remove() {
    if (inFlight.current) return
    inFlight.current = true
    startTransition(async () => {
      try {
        const result = await attempt(() => deleteBudgetAction({ id: budgetId }))
        if (result === null || !result.ok) {
          announce({ tone: "warning", lines: [couldNot(`delete the ${name} budget`, result)] })
          if (result !== null && !result.ok && result.error.code === "not_found") router.refresh() // gone already: this row is stale
          return
        }
        announce({ tone: "success", lines: [`Deleted the ${name} budget. Your transactions are untouched.`] }, true) // the row is gone, and the keyboard's place with it
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
    keepButton,
    deleteButton,
    toggle: () => {
      if (!pending) setConfirming((current) => !current)
    },
    keep: () => {
      if (pending) return
      setConfirming(false)
      deleteButton.current?.focus()
    },
    remove,
  }
}

export function DeleteButton({ control, name }: { control: DeleteControl; name: string }) {
  return (
    <button
      type="button"
      ref={control.deleteButton}
      aria-expanded={control.confirming}
      aria-controls={control.confirming ? control.confirmId : undefined}
      aria-disabled={control.pending}
      onClick={control.toggle}
      className={buttonClass({ variant: "ghost", size: "sm", className: "aria-disabled:opacity-55" })}
    >
      <Trash2 aria-hidden className="size-4" />
      Delete<span className="sr-only"> {name} budget</span>
    </button>
  )
}

/** The confirm: `children` says what deleting removes and what it leaves. */
export function DeleteConfirm({ control, name, children }: { control: DeleteControl; name: string; children: ReactNode }) {
  return (
    <Collapse open={control.confirming} id={control.confirmId}>
      <div role="group" aria-label={`Delete the ${name} budget?`} className="mt-4 rounded-2xl border border-negative/60 bg-negative-wash p-4">
        <p className="text-sm font-medium text-negative">Delete the {name} budget?</p>
        <p className="mt-1 text-sm text-fg">{children}</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            aria-disabled={control.pending}
            onClick={control.remove}
            className={buttonClass({ variant: "danger", size: "sm", className: "aria-disabled:opacity-55" })}
          >
            {control.pending && <LoaderCircle aria-hidden className="size-4 animate-spin" />}
            Delete budget<span className="sr-only"> {name}</span>
          </button>
          <button
            type="button"
            ref={control.keepButton}
            aria-disabled={control.pending}
            onClick={control.keep}
            className={buttonClass({ variant: "secondary", size: "sm", className: "aria-disabled:opacity-55" })}
          >
            Keep it<span className="sr-only"> {name} budget</span>
          </button>
        </div>
      </div>
    </Collapse>
  )
}
