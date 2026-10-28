"use client"

import { ArrowRight, LoaderCircle, Pause, Pencil, Play, Trash2 } from "lucide-react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useEffect, useId, useRef, useState, useTransition } from "react"
import { Amount } from "@/app/amount"
import type { Announce } from "@/app/transactions/notice"
import { Collapse } from "@/components/ui/collapse"
import { GlowingEffect } from "@/components/ui/glowing-effect"
import { SpotlightCard } from "@/components/ui/spotlight-card"
import { buttonClass } from "@/components/ui/styles"
import { Tag } from "@/components/ui/tag"
import { calendarDate } from "@/domain/calendar-date"
import type { RuleView } from "@/lib/recurring-view"
import { formatDay } from "@/lib/transaction-text"
import { cn } from "@/lib/utils"
import { deleteRuleAction, pauseRuleAction, resumeRuleAction } from "./actions"
import { attempt, couldNot, figure } from "./feedback"

// Every rule, with its schedule in words, the next day it fires, and what state it is in: paused (by the user), finished
// (it has run out) or blocked (an account it uses is archived, so nothing is generated until it is restored). Pause and
// Resume are one press; Delete is behind a confirm, because it takes the rule's waiting entries with it.

export function RulesList({ rules, announce }: { rules: RuleView[]; announce: Announce }) {
  if (rules.length === 0) return null
  return (
    <section aria-labelledby="rules-heading" className="mt-12">
      <div className="flex items-baseline justify-between gap-4">
        <h2 id="rules-heading" className="font-display text-lg font-semibold tracking-tight">
          Rules
        </h2>
        <span className="text-sm text-fg-soft">{rules.length}</span>
      </div>
      <ul className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2 lg:items-start">
        {rules.map((rule, index) => (
          <RuleRow key={rule.id} rule={rule} index={index} announce={announce} />
        ))}
      </ul>
    </section>
  )
}

const CHIP_NOTICE = "border-notice-fg/60 bg-notice-wash text-notice-fg"

function RuleRow({ rule, index, announce }: { rule: RuleView; index: number; announce: Announce }) {
  const router = useRouter()
  const confirmId = useId()
  const stateId = useId()
  const [confirming, setConfirming] = useState(false)
  const [pending, startTransition] = useTransition()
  const keepButton = useRef<HTMLButtonElement>(null)
  const deleteButton = useRef<HTMLButtonElement>(null)

  // The confirm has just opened: the safe choice has the keyboard, so Enter cannot delete by accident.
  useEffect(() => {
    if (confirming) keepButton.current?.focus()
  }, [confirming])

  const paused = rule.state === "paused"

  function togglePause() {
    startTransition(async () => {
      const result = await attempt(() => (paused ? resumeRuleAction : pauseRuleAction)({ id: rule.id }))
      if (result === null || !result.ok) {
        announce({ tone: "warning", lines: [couldNot(`${paused ? "resume" : "pause"} ${rule.name}`, result)] })
        if (result !== null && !result.ok && result.error.code === "not_found") router.refresh()
        return
      }
      const next = result.data.nextDueOn
      announce({
        tone: "success",
        lines: [
          paused
            ? `Resumed ${rule.name}.${next ? ` Its next entry is due ${formatDay(calendarDate(next))}.` : ""}`
            : `Paused ${rule.name}. It makes no new entries until you resume it.`,
        ],
      })
      router.refresh()
    })
  }

  function remove() {
    startTransition(async () => {
      const result = await attempt(() => deleteRuleAction({ id: rule.id }))
      if (result === null || !result.ok) {
        announce({ tone: "warning", lines: [couldNot(`delete ${rule.name}`, result)] })
        if (result !== null && !result.ok && result.error.code === "not_found") router.refresh()
        return
      }
      announce({ tone: "success", lines: [`Deleted ${rule.name}. What it already posted stays in your transactions.`] }, true)
      router.refresh()
    })
  }

  const ends = [
    rule.endDate ? `Until ${formatDay(calendarDate(rule.endDate))}` : null,
    rule.occurrenceLimit ? `${rule.occurrenceLimit} ${rule.occurrenceLimit === 1 ? "entry" : "entries"} in all` : null,
  ].filter((part): part is string => part !== null)

  return (
    <SpotlightCard as="li" className="surface rise rounded-2xl p-4 sm:p-5" style={{ "--i": index } as React.CSSProperties} radius={300} strength={10}>
      <GlowingEffect />
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-display text-lg font-semibold tracking-tight">{rule.name}</h3>
            {rule.state === "paused" && <Tag>Paused</Tag>}
            {rule.state === "finished" && <Tag>Finished</Tag>}
            {rule.state === "blocked" && <Tag className={CHIP_NOTICE}>Blocked</Tag>}
            {rule.autoPost && <Tag>Posts itself</Tag>}
          </div>
          <p className="text-sm text-fg-soft">
            {rule.scheduleText}
            {ends.length > 0 && `. ${ends.join(", ")}`}
          </p>
        </div>
        <Amount text={figure(rule.amountPaise)} className="text-xl font-medium tracking-tight" />
      </div>

      <p className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
        <span className="font-medium">{rule.fromName}</span>
        <span className="sr-only"> to </span>
        <ArrowRight aria-hidden className="size-4 shrink-0 text-fg-soft" />
        <span className="font-medium">{rule.toName}</span>
      </p>

      <p id={stateId} className={cn("mt-2 text-sm", rule.state === "blocked" ? "font-medium text-notice-fg" : "text-fg-soft")}>
        {rule.state === "blocked"
          ? "An account it uses is archived, so it makes no entries until you restore the account."
          : rule.state === "finished"
            ? "It has made its last entry."
            : paused
              ? rule.nextDueOn
                ? `Paused. It was next due ${formatDay(calendarDate(rule.nextDueOn))}.`
                : "Paused."
              : rule.nextDueOn
                ? `Next entry ${formatDay(calendarDate(rule.nextDueOn))}.`
                : ""}
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Link href={`/recurring/${rule.id}/edit`} className={buttonClass({ variant: "secondary", size: "sm" })}>
          <Pencil aria-hidden className="size-4" />
          Edit<span className="sr-only"> {rule.name}</span>
        </Link>
        {rule.state !== "finished" && (
          <button type="button" disabled={pending} onClick={togglePause} className={buttonClass({ variant: "secondary", size: "sm" })}>
            {pending ? <LoaderCircle aria-hidden className="size-4 animate-spin" /> : paused ? <Play aria-hidden className="size-4" /> : <Pause aria-hidden className="size-4" />}
            {paused ? "Resume" : "Pause"}
            <span className="sr-only"> {rule.name}</span>
          </button>
        )}
        <button
          type="button"
          ref={deleteButton}
          disabled={pending}
          aria-expanded={confirming}
          aria-controls={confirming ? confirmId : undefined}
          onClick={() => setConfirming((current) => !current)}
          className={buttonClass({ variant: "ghost", size: "sm" })}
        >
          <Trash2 aria-hidden className="size-4" />
          Delete<span className="sr-only"> {rule.name}</span>
        </button>
      </div>

      <Collapse open={confirming} id={confirmId}>
        <div role="group" aria-label={`Delete ${rule.name}?`} className="mt-4 rounded-2xl border border-negative/60 bg-negative-wash p-4">
          <p className="text-sm font-medium text-negative">Delete {rule.name}?</p>
          <p className="mt-1 text-sm text-fg">Its waiting entries go with it. What it already posted stays in your transactions.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" disabled={pending} onClick={remove} className={buttonClass({ variant: "danger", size: "sm" })}>
              {pending && <LoaderCircle aria-hidden className="size-4 animate-spin" />}
              Delete rule
            </button>
            <button
              type="button"
              ref={keepButton}
              disabled={pending}
              onClick={() => {
                setConfirming(false)
                deleteButton.current?.focus()
              }}
              className={buttonClass({ variant: "secondary", size: "sm" })}
            >
              Keep it
            </button>
          </div>
        </div>
      </Collapse>
    </SpotlightCard>
  )
}
