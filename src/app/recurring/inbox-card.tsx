"use client"

import { ArrowRight, CircleAlert, LoaderCircle, TriangleAlert } from "lucide-react"
import { useRouter } from "next/navigation"
import { useEffect, useId, useRef, useState, useTransition } from "react"
import { Amount } from "@/app/amount"
import { Field } from "@/app/transactions/transaction-form"
import type { Announce } from "@/app/transactions/notice"
import { Collapse } from "@/components/ui/collapse"
import { GlowingEffect } from "@/components/ui/glowing-effect"
import { SpotlightCard } from "@/components/ui/spotlight-card"
import { buttonClass, inputClass } from "@/components/ui/styles"
import { Tag } from "@/components/ui/tag"
import { calendarDate } from "@/domain/calendar-date"
import { formatQuantity, parseQuantity, QuantityParseError } from "@/domain/quantity"
import { quantityText } from "@/lib/investment-text"
import { formatPaiseText } from "@/lib/node-money"
import type { OccurrenceView } from "@/lib/recurring-view"
import { formatDay, paiseTextToRupees } from "@/lib/transaction-text"
import type { ActionFailure } from "@/server/action-support"
import { dismissOccurrenceAction, postOccurrenceAction } from "./actions"
import { attempt, couldNot, figure } from "./feedback"
import { putBack } from "./recent-list"
import { postPayload } from "./rule-fields"

// One entry waiting to be posted: what posting it would record (the rule's amount, ends and note), and three choices.
//  - Post records it as shown, in one press.
//  - Edit and post opens a small form to change the amount, the day or the note first.
//  - Skip drops this one entry; the toast offers Put back, and so does Recently handled.
// An entry into an investment valued by quantity cannot be posted blind, since each purchase needs its quantity: there
// Post opens the same form with the quantity field ready. An entry whose account has been archived can be skipped but not
// posted, and the card says so. Posting is exactly-once on the server, so there is no request key here.

interface Props {
  occurrence: OccurrenceView
  index: number
  announce: Announce
}

interface Draft {
  amount: string
  date: string
  note: string
  quantity: string
}

interface Outcome {
  fieldErrors: Record<string, string[]>
  message: string | null
}

const unique = (messages: string[]) => [...new Set(messages)]

/** The quantity as the server will read it, normalised ("8.000" is "8"), or the text as typed when it does not parse. */
function normalisedQuantity(text: string): string {
  try {
    return formatQuantity(parseQuantity(text.trim()))
  } catch (error) {
    if (error instanceof QuantityParseError) return text.trim()
    throw error
  }
}

export function InboxCard({ occurrence, index, announce }: Props) {
  const router = useRouter()
  const formId = useId()
  const blockedId = useId()
  const formRef = useRef<HTMLFormElement>(null)
  const inFlight = useRef(false)
  const opener = useRef<HTMLButtonElement>(null)
  const [editing, setEditing] = useState(false)
  // Which field the form opens on: the quantity when Post had to open it, else the amount.
  const [focusOn, setFocusOn] = useState<"amount" | "quantity">("amount")
  const [values, setValues] = useState<Draft>({
    amount: paiseTextToRupees(occurrence.amountPaise),
    date: occurrence.dueOn,
    note: occurrence.note ?? "",
    quantity: "",
  })
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const [pending, startTransition] = useTransition()

  const { needsQuantity, nodeArchived } = occurrence
  const unit = occurrence.unitLabel || null
  const dueText = formatDay(calendarDate(occurrence.dueOn))

  // The form has just opened: put the keyboard where the person is about to type.
  useEffect(() => {
    if (!editing) return
    formRef.current?.querySelector<HTMLElement>(`[name='${focusOn}']`)?.focus()
  }, [editing, focusOn])

  // A refusal moves the keyboard to the first field that needs attention, so a screen-reader user hears what is wrong.
  useEffect(() => {
    if (outcome) formRef.current?.querySelector<HTMLElement>("[aria-invalid='true']")?.focus()
  }, [outcome])

  function open(field: "amount" | "quantity") {
    setFocusOn(field)
    setEditing(true)
  }

  function close() {
    setEditing(false)
    setOutcome(null)
    opener.current?.focus() // the form had the focus; it goes back to what opened it
  }

  function patch(change: Partial<Draft>) {
    setValues((current) => ({ ...current, ...change }))
    setOutcome(null)
  }

  function posted(view: OccurrenceView) {
    announce(
      {
        tone: "success",
        lines: [`Posted ${view.ruleName}: ${formatPaiseText(view.amountPaise)} from ${view.fromName} to ${view.toName}.`],
      },
      true, // the card is gone, and the keyboard's place with it
    )
    router.refresh()
  }

  function refused(failure: ActionFailure | null) {
    announce({ tone: "warning", lines: [couldNot(`post ${occurrence.ruleName}`, failure)] })
    if (failure !== null && failure.error.code === "not_found") router.refresh() // handled elsewhere: this card is stale
  }

  // One press, the entry as the card shows it: the amount and note are sent, so a rule edited elsewhere since this card
  // was drawn does not change what is recorded.
  function postAsProposed() {
    if (needsQuantity) return open("quantity")
    if (inFlight.current) return
    inFlight.current = true
    startTransition(async () => {
      try {
        const result = await attempt(() => postOccurrenceAction(postPayload(occurrence)))
        if (result?.ok) posted(result.data)
        else refused(result)
      } finally {
        inFlight.current = false
      }
    })
  }

  // The form: the amount and note it holds are sent as they stand (an untouched one is the card's own), and the day only
  // when it was changed, so what is recorded is what the form showed and not what the rule says by now.
  function submit() {
    if (inFlight.current) return
    inFlight.current = true
    const input = postPayload(occurrence, { ...values, quantity: needsQuantity ? values.quantity : "" })
    startTransition(async () => {
      try {
        const result = await attempt(() => postOccurrenceAction(input))
        if (result?.ok) return posted(result.data)
        if (result !== null && !result.ok && result.error.code !== "not_found") {
          setOutcome({ fieldErrors: result.error.fieldErrors ?? {}, message: result.error.message })
          return
        }
        refused(result)
      } finally {
        inFlight.current = false
      }
    })
  }

  function skip() {
    if (inFlight.current) return
    inFlight.current = true
    startTransition(async () => {
      try {
        const result = await attempt(() => dismissOccurrenceAction({ id: occurrence.id }))
        if (result === null || !result.ok) {
          announce({ tone: "warning", lines: [couldNot(`skip ${occurrence.ruleName}`, result)] })
          if (result !== null && !result.ok && result.error.code === "not_found") router.refresh()
          return
        }
        announce(
          {
            tone: "success",
            lines: [`Skipped ${occurrence.ruleName}, due ${dueText}.`],
            undo: { label: "Put back", run: () => void putBack(occurrence, announce, router) },
          },
          true,
        )
        router.refresh()
      } finally {
        inFlight.current = false
      }
    })
  }

  const errorsAt = (key: string) => outcome?.fieldErrors[key]
  // A refusal that names none of this form's fields (the flow, an overdraft) is said once, above the buttons.
  const placed = new Set(["amount", "occurredAt", "note", "quantity"])
  const unplaced = outcome ? Object.entries(outcome.fieldErrors).filter(([key]) => !placed.has(key)) : []
  const alertText = outcome
    ? unplaced.length > 0
      ? unique(unplaced.flatMap(([, messages]) => messages)).join(" ")
      : Object.keys(outcome.fieldErrors).length === 0
        ? outcome.message
        : null
    : null

  return (
    <SpotlightCard
      as="li"
      className="surface rise rounded-2xl p-4 sm:p-5"
      style={{ "--i": index } as React.CSSProperties}
      radius={300}
      strength={10}
    >
      <GlowingEffect />
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <h3 className="font-display text-lg font-semibold tracking-tight">
            {occurrence.ruleName}
          </h3>
          <p className="text-sm text-fg-soft">Due {dueText}</p>
        </div>
        <Amount text={figure(occurrence.amountPaise)} className="text-xl font-medium tracking-tight" />
      </div>

      <p className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
        <span className="font-medium">{occurrence.fromName}</span>
        <span className="sr-only"> to </span>
        <ArrowRight aria-hidden className="size-4 shrink-0 text-fg-soft" />
        <span className="font-medium">{occurrence.toName}</span>
      </p>

      {(occurrence.note || occurrence.tags.length > 0) && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-fg-soft">
          {occurrence.note && <span className="min-w-0 break-words">{occurrence.note}</span>}
          {occurrence.tags.map((tag) => (
            <Tag key={tag}>{tag}</Tag>
          ))}
        </div>
      )}

      {occurrence.postFailure && (
        <p role="note" className="mt-3 flex items-start gap-2.5 rounded-xl bg-notice-wash px-3.5 py-2.5 text-sm font-medium text-notice-fg">
          <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span>Not posted automatically: {occurrence.postFailure}</span>
        </p>
      )}

      {nodeArchived ? (
        <p id={blockedId} className="mt-3 text-sm text-fg-soft">
          An account this entry uses is archived, so it cannot be posted. Restore the account on the Ledger screen, or skip the entry.
        </p>
      ) : (
        needsQuantity && (
          <p className="mt-3 text-sm text-fg-soft">
            This buys into {occurrence.toName}, which is valued by quantity: posting asks how much{unit ? ` (${unit})` : ""} you bought.
          </p>
        )
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          ref={needsQuantity ? opener : undefined}
          disabled={pending || nodeArchived}
          aria-describedby={nodeArchived ? blockedId : undefined}
          {...(needsQuantity && !nodeArchived ? { "aria-expanded": editing, "aria-controls": editing ? formId : undefined } : {})}
          onClick={postAsProposed}
          className={buttonClass({ size: "sm" })}
        >
          {pending && !editing && <LoaderCircle aria-hidden className="size-4 animate-spin" />}
          Post<span className="sr-only"> {occurrence.ruleName}</span>
        </button>
        {!needsQuantity && (
          <button
            type="button"
            ref={opener}
            disabled={pending || nodeArchived}
            aria-expanded={editing}
            aria-controls={editing ? formId : undefined}
            aria-describedby={nodeArchived ? blockedId : undefined}
            onClick={() => (editing ? close() : open("amount"))}
            className={buttonClass({ variant: "secondary", size: "sm" })}
          >
            Edit and post<span className="sr-only"> {occurrence.ruleName}</span>
          </button>
        )}
        <button type="button" disabled={pending} onClick={skip} className={buttonClass({ variant: "ghost", size: "sm" })}>
          Skip<span className="sr-only"> {occurrence.ruleName}</span>
        </button>
      </div>

      {!nodeArchived && (
        <Collapse open={editing} id={formId}>
          <form
            ref={formRef}
            aria-label={`Edit and post ${occurrence.ruleName}`}
            noValidate
            onSubmit={(event) => {
              event.preventDefault()
              submit()
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape" && !pending) close()
            }}
            className="mt-4 rounded-2xl border border-line bg-canvas/60 p-4"
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <Field idBase={`${formId}-amount`} label="Amount (₹)" errors={errorsAt("amount")}>
                {(props) => (
                  <input
                    {...props}
                    name="amount"
                    type="text"
                    inputMode="decimal"
                    autoComplete="off"
                    value={values.amount}
                    onChange={(event) => patch({ amount: event.target.value })}
                    className={`${inputClass} figures`}
                  />
                )}
              </Field>
              <Field idBase={`${formId}-date`} label="Date" errors={errorsAt("occurredAt")}>
                {(props) => (
                  <input
                    {...props}
                    name="date"
                    type="date"
                    value={values.date}
                    onChange={(event) => patch({ date: event.target.value })}
                    className={`${inputClass} figures`}
                  />
                )}
              </Field>
              {needsQuantity && (
                <Field idBase={`${formId}-quantity`} label={unit ? `Quantity (${unit})` : "Quantity"} errors={errorsAt("quantity")}>
                  {(props) => (
                    <input
                      {...props}
                      name="quantity"
                      type="text"
                      inputMode="decimal"
                      autoComplete="off"
                      placeholder="0"
                      value={values.quantity}
                      onChange={(event) => patch({ quantity: event.target.value })}
                      className={`${inputClass} figures`}
                    />
                  )}
                </Field>
              )}
              <div className={needsQuantity ? undefined : "sm:col-span-2"}>
                <Field idBase={`${formId}-note`} label="Note" optional errors={errorsAt("note")}>
                  {(props) => (
                    <input
                      {...props}
                      name="note"
                      type="text"
                      maxLength={500}
                      autoComplete="off"
                      value={values.note}
                      onChange={(event) => patch({ note: event.target.value })}
                      className={inputClass}
                    />
                  )}
                </Field>
              </div>
            </div>

            {needsQuantity && values.quantity.trim() !== "" && (
              <p className="figures mt-3 text-sm text-fg-soft">Records {quantityText(normalisedQuantity(values.quantity), unit)} bought.</p>
            )}

            {alertText && (
              <p role="alert" className="mt-4 flex items-start gap-2.5 rounded-xl bg-negative-wash px-3.5 py-2.5 text-sm font-medium text-negative">
                <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
                <span>{alertText}</span>
              </p>
            )}

            <div className="mt-4 flex flex-wrap items-center gap-2">
              <button type="submit" disabled={pending} className={buttonClass({ size: "sm" })}>
                {pending && <LoaderCircle aria-hidden className="size-4 animate-spin" />}
                Post entry
              </button>
              <button type="button" disabled={pending} onClick={close} className={buttonClass({ variant: "secondary", size: "sm" })}>
                Cancel
              </button>
            </div>
          </form>
        </Collapse>
      )}
    </SpotlightCard>
  )
}
