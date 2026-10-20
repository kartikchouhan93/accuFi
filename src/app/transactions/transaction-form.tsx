"use client"

import { useEffect, useId, useRef, useState, useTransition } from "react"
import type { CalendarDate } from "@/domain/calendar-date"
import { formatPaiseText } from "@/lib/node-money"
import { newRequestKey } from "@/lib/request-key"
import { SPLIT_LEGS_MAX, SPLIT_LEGS_MIN } from "@/lib/schemas/transaction"
import type { PickerNode } from "@/lib/transaction-list-view"
import { describeTally, divideEqually, paiseTextToRupees, parseTags, sumPaiseText } from "@/lib/transaction-text"
import type { TransactionView, Warning } from "@/lib/transaction-view"
import type { FailureText } from "@/app/nodes/node-failure"
import type { ActionFailure } from "@/server/action-support"
import { editTransactionAction, recordSplitAction, recordTransactionAction } from "./actions"
import type { Announce } from "./notice"
import { destinationChoices, groupByKind, nodeLabel, sourceChoices } from "./pickers"
import { describeTransactionFailure } from "./transaction-failure"

// One form for every flow: salary into a bank, groceries on a card, paying the card, moving money between accounts. They
// are all one movement from one node to another, so the form is a source, a destination, an amount and a day. Choosing
// the source narrows the destinations to what the flow rules allow. "Add split" turns the one destination into a list of
// legs whose amounts must reach the total.
//
// The request key is chosen once, when the form opens, and kept across every attempt to submit it: a double click or a
// retry is then the same request to the server, which records it once. It is replaced only after a success, because the
// next thing entered is a new request. The same form edits a transaction (`editing`), which has no key, only the
// version it was opened at.

interface Props {
  nodes: PickerNode[]
  today: CalendarDate
  /** The transaction being edited, or null for a new entry. The parent remounts the form when this changes. */
  editing: TransactionView | null
  /** An edit was saved or abandoned. */
  onFinished: () => void
  announce: Announce
}

interface Leg {
  to: string
  amount: string
}

// `legs` is null for a single destination. Everything is the text of its field: amounts are parsed by the server's
// schema, so the rules about what an amount may look like live in one place.
interface Draft {
  from: string
  to: string
  amount: string
  date: string
  note: string
  tags: string
  legs: Leg[] | null
}

interface Outcome {
  fieldErrors: Record<string, string[]>
  failure: FailureText
  /** With a version conflict: what is stored now. */
  conflict?: TransactionView
}

const blankDraft = (today: CalendarDate): Draft => ({ from: "", to: "", amount: "", date: today, note: "", tags: "", legs: null })

const draftOf = (transaction: TransactionView): Draft => ({
  from: transaction.fromNodeId,
  to: transaction.toNodeId,
  amount: paiseTextToRupees(transaction.amountPaise),
  date: transaction.occurredAt,
  note: transaction.note ?? "",
  tags: transaction.tags.join(", "),
  legs: null,
})

const inputClass =
  "w-full rounded-sm border border-rule-strong bg-paper px-3 py-2 text-ink placeholder:text-ink-soft/70 disabled:opacity-60 aria-[invalid=true]:border-red aria-[invalid=true]:border-2"
const buttonClass = "rounded-sm border border-rule-strong px-3 py-1.5 text-sm font-medium hover:bg-paper disabled:opacity-60"
const linkButtonClass = "rounded-sm text-sm font-medium text-pen underline underline-offset-4 disabled:opacity-60"

const unique = (messages: string[]) => [...new Set(messages)]

export function TransactionForm({ nodes, today, editing, onFinished, announce }: Props) {
  const formId = useId()
  const formRef = useRef<HTMLFormElement>(null)
  const inFlight = useRef(false)
  const [values, setValues] = useState<Draft>(() => (editing ? draftOf(editing) : blankDraft(today)))
  const [requestKey, setRequestKey] = useState(newRequestKey)
  const [version, setVersion] = useState(editing?.version ?? 0)
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const [pending, startTransition] = useTransition()

  // The nodes the row being edited already names stay choosable, however they are classed (EC-14).
  const keep = editing ? [editing.fromNodeId, editing.toNodeId] : []
  const sources = sourceChoices(nodes, keep)
  const destinations = destinationChoices(nodes, values.from, keep)
  const nameOf = (id: string) => nodes.find((node) => node.id === id)?.name ?? "an unknown account"
  const isSplit = values.legs !== null
  const legs = values.legs ?? []
  const errorsAt = (key: string) => outcome?.fieldErrors[key]

  // Every problem is shown beside the field it belongs to. What cannot be placed (a refusal about the whole request) is
  // said once, above the button.
  const placedKeys = new Set(["fromNodeId", "occurredAt", "note", "tags", isSplit ? "total" : "amount", ...(isSplit ? [] : ["toNodeId"])])
  const isPlaced = (key: string) =>
    placedKeys.has(key) || (isSplit && legs.some((_, index) => key === `legs.${index}.toNodeId` || key === `legs.${index}.amount` || key === `legs.${index}.note`))
  const unplaced = outcome ? Object.entries(outcome.fieldErrors).filter(([key]) => !isPlaced(key)) : []
  const alertText = !outcome || outcome.conflict
    ? null
    : outcome.failure.isFieldProblem
      ? unplaced.length > 0
        ? unique(unplaced.flatMap(([, messages]) => messages)).join(" ")
        : null
      : outcome.failure.message
  const noteErrors = unique([...(errorsAt("note") ?? []), ...legs.flatMap((_, index) => errorsAt(`legs.${index}.note`) ?? [])])

  // A refusal moves the keyboard to the first field that needs attention, so a screen-reader user hears what is wrong.
  useEffect(() => {
    if (outcome) formRef.current?.querySelector<HTMLElement>("[aria-invalid='true']")?.focus()
  }, [outcome])

  function patch(change: Partial<Draft>) {
    setValues((current) => ({ ...current, ...change }))
  }

  // Changing the source drops every destination the new source cannot pay, rather than leaving an impossible pair.
  function chooseSource(from: string) {
    const legal = new Set(destinationChoices(nodes, from, keep).map((node) => node.id))
    setValues((current) => ({
      ...current,
      from,
      to: legal.has(current.to) ? current.to : "",
      legs: current.legs && current.legs.map((leg) => ({ ...leg, to: legal.has(leg.to) ? leg.to : "" })),
    }))
  }

  function setLeg(index: number, change: Partial<Leg>) {
    setValues((current) => ({ ...current, legs: (current.legs ?? []).map((leg, at) => (at === index ? { ...leg, ...change } : leg)) }))
  }

  function divide() {
    const shares = divideEqually(values.amount, legs.length)
    if (shares === null) {
      setOutcome({ fieldErrors: { total: ["Enter the total first, then divide it."] }, failure: { message: "Enter the total first.", isFieldProblem: true } })
      return
    }
    patch({ legs: legs.map((leg, index) => ({ ...leg, amount: shares[index] })) })
    setOutcome(null)
  }

  /** Required choices, checked before sending: a missing node has no useful server message, so it is said here. */
  function missingChoices(): Record<string, string[]> | null {
    const problems: Record<string, string[]> = {}
    if (values.from === "") problems.fromNodeId = ["Choose where the money comes from"]
    if (isSplit) {
      legs.forEach((leg, index) => {
        if (leg.to === "") problems[`legs.${index}.toNodeId`] = ["Choose where this part goes"]
      })
    } else if (values.to === "") {
      problems.toNodeId = ["Choose where the money goes"]
    }
    return Object.keys(problems).length > 0 ? problems : null
  }

  function reportFailure(failure: ActionFailure) {
    setOutcome({
      fieldErrors: failure.error.fieldErrors ?? {},
      failure: describeTransactionFailure(failure),
      conflict: failure.error.code === "version_conflict" ? failure.error.current : undefined,
    })
  }

  function warningLines(warnings: Warning[]): string[] {
    return warnings.map((warning) => warning.message)
  }

  function afterRecording(lines: string[], warnings: Warning[]) {
    announce({ tone: warnings.length > 0 ? "warning" : "success", lines: [...lines, ...warningLines(warnings)] })
    setOutcome(null)
    // The next entry is a new request, so it gets a new key. The source and the day stay: a run of entries usually shares both.
    setRequestKey(newRequestKey())
    setValues((current) => ({ ...blankDraft(today), from: current.from, date: current.date }))
    formRef.current?.querySelector<HTMLElement>("[data-first-field]")?.focus()
  }

  function send(expectedVersion: number) {
    const missing = missingChoices()
    if (missing) {
      setOutcome({ fieldErrors: missing, failure: { message: "Check the highlighted fields.", isFieldProblem: true } })
      return
    }
    // The button is disabled while a request is out, but a second submit can still arrive (Enter held down, a double
    // click before the disabled state paints): this makes it a no-op rather than a second request. The request key is
    // the backstop for everything this cannot catch.
    if (inFlight.current) return
    inFlight.current = true
    const note = values.note.trim()
    const tags = parseTags(values.tags)

    startTransition(async () => {
      try {
        if (editing) {
          const result = await editTransactionAction({
            id: editing.id,
            expectedVersion,
            changes: {
              fromNodeId: values.from,
              toNodeId: values.to,
              amount: values.amount,
              occurredAt: values.date,
              note: note === "" ? null : note,
              tags,
            },
          })
          if (!result.ok) return reportFailure(result)
          const saved = result.data
          announce({
            tone: saved.warnings.length > 0 ? "warning" : "success",
            lines: [
              `Saved changes to ${nameOf(saved.fromNodeId)} → ${nameOf(saved.toNodeId)}, ${formatPaiseText(saved.amountPaise)}.`,
              ...warningLines(saved.warnings),
            ],
          })
          onFinished()
        } else if (isSplit) {
          const result = await recordSplitAction({
            fromNodeId: values.from,
            occurredAt: values.date,
            legs: legs.map((leg) => ({ toNodeId: leg.to, amount: leg.amount, ...(note === "" ? {} : { note }) })),
            total: values.amount,
            tags,
            idempotencyKey: requestKey,
          })
          if (!result.ok) return reportFailure(result)
          const total = formatPaiseText(sumPaiseText(result.data.legs.map((leg) => leg.amountPaise)))
          afterRecording(
            [`Recorded a split of ${total} from ${nameOf(values.from)} in ${result.data.legs.length} legs.`],
            result.data.warnings, // once: every leg carries the same list
          )
        } else {
          const result = await recordTransactionAction({
            fromNodeId: values.from,
            toNodeId: values.to,
            amount: values.amount,
            occurredAt: values.date,
            ...(note === "" ? {} : { note }),
            tags,
            idempotencyKey: requestKey,
          })
          if (!result.ok) return reportFailure(result)
          const recorded = result.data
          afterRecording(
            [`Recorded ${nameOf(recorded.fromNodeId)} → ${nameOf(recorded.toNodeId)}, ${formatPaiseText(recorded.amountPaise)}.`],
            recorded.warnings,
          )
        }
      } finally {
        inFlight.current = false
      }
    })
  }

  function clear() {
    setValues(blankDraft(today))
    setRequestKey(newRequestKey())
    setOutcome(null)
  }

  const heading = editing ? "Edit transaction" : "Record a transaction"
  const tally = isSplit ? describeTally(values.amount, legs.map((leg) => leg.amount)) : null

  return (
    <form
      ref={formRef}
      onSubmit={(event) => {
        event.preventDefault()
        send(version)
      }}
      noValidate
      aria-labelledby={`${formId}-title`}
      className="border border-rule border-t-4 border-t-ink bg-sheet p-5"
    >
      <h2 id={`${formId}-title`} className="font-display text-xl font-semibold">
        {heading}
      </h2>

      <div className="mt-5 space-y-4">
        <Field idBase={`${formId}-from`} label="From" errors={errorsAt("fromNodeId")}>
          {(props) => (
            <NodePicker
              {...props}
              value={values.from}
              onChange={chooseSource}
              choices={sources}
              placeholder="Choose a source"
              data-first-field=""
            />
          )}
        </Field>

        {!isSplit && (
          <Field idBase={`${formId}-to`} label="To" errors={errorsAt("toNodeId")}>
            {(props) => (
              <NodePicker
                {...props}
                value={values.to}
                onChange={(to) => patch({ to })}
                choices={destinations}
                placeholder={values.from === "" ? "Choose a source first" : "Choose a destination"}
                disabled={values.from === ""}
              />
            )}
          </Field>
        )}

        <Field
          idBase={`${formId}-amount`}
          label={isSplit ? "Total (₹)" : "Amount (₹)"}
          errors={errorsAt(isSplit ? "total" : "amount")}
        >
          {(props) => (
            <input
              {...props}
              type="text"
              inputMode="decimal"
              autoComplete="off"
              placeholder="0.00"
              value={values.amount}
              onChange={(event) => patch({ amount: event.target.value })}
              className={`${inputClass} figures`}
            />
          )}
        </Field>

        {isSplit && (
          <fieldset className="space-y-3">
            <legend className="text-sm font-medium">Split across</legend>
            {legs.map((leg, index) => (
              <div key={index} role="group" aria-label={`Leg ${index + 1}`} className="space-y-3 border-l-2 border-rule-strong pl-3">
                <Field idBase={`${formId}-leg-${index}-to`} label="To" errors={errorsAt(`legs.${index}.toNodeId`)}>
                  {(props) => (
                    <NodePicker
                      {...props}
                      value={leg.to}
                      onChange={(to) => setLeg(index, { to })}
                      choices={destinations}
                      placeholder={values.from === "" ? "Choose a source first" : "Choose a destination"}
                      disabled={values.from === ""}
                    />
                  )}
                </Field>
                <Field idBase={`${formId}-leg-${index}-amount`} label="Amount (₹)" errors={errorsAt(`legs.${index}.amount`)}>
                  {(props) => (
                    <div className="flex items-start gap-2">
                      <input
                        {...props}
                        type="text"
                        inputMode="decimal"
                        autoComplete="off"
                        placeholder="0.00"
                        value={leg.amount}
                        onChange={(event) => setLeg(index, { amount: event.target.value })}
                        className={`${inputClass} figures`}
                      />
                      {legs.length > SPLIT_LEGS_MIN && (
                        <button
                          type="button"
                          aria-label={`Remove leg ${index + 1}`}
                          onClick={() => patch({ legs: legs.filter((_, at) => at !== index) })}
                          className={`${buttonClass} shrink-0`}
                        >
                          Remove
                        </button>
                      )}
                    </div>
                  )}
                </Field>
              </div>
            ))}
            <div className="flex flex-wrap gap-2">
              <button type="button" className={buttonClass} onClick={divide}>
                Divide equally
              </button>
              <button
                type="button"
                className={buttonClass}
                disabled={legs.length >= SPLIT_LEGS_MAX}
                onClick={() => patch({ legs: [...legs, { to: "", amount: "" }] })}
              >
                Add leg
              </button>
              <button type="button" className={linkButtonClass} onClick={() => patch({ to: legs[0]?.to ?? "", legs: null })}>
                Use one destination
              </button>
            </div>
            <p aria-live="polite" className="figures text-sm text-ink-soft">
              {tally}
            </p>
          </fieldset>
        )}

        <Field idBase={`${formId}-date`} label="Date" errors={errorsAt("occurredAt")}>
          {(props) => (
            <input
              {...props}
              type="date"
              value={values.date}
              onChange={(event) => patch({ date: event.target.value })}
              className={`${inputClass} figures`}
            />
          )}
        </Field>

        <Field idBase={`${formId}-note`} label="Note" optional errors={noteErrors.length > 0 ? noteErrors : undefined}>
          {(props) => (
            <input
              {...props}
              type="text"
              maxLength={500}
              autoComplete="off"
              value={values.note}
              onChange={(event) => patch({ note: event.target.value })}
              className={inputClass}
            />
          )}
        </Field>

        <Field idBase={`${formId}-tags`} label="Tags" optional hint="Separate with commas" errors={errorsAt("tags")}>
          {(props) => (
            <input
              {...props}
              type="text"
              autoComplete="off"
              value={values.tags}
              onChange={(event) => patch({ tags: event.target.value })}
              className={inputClass}
            />
          )}
        </Field>
      </div>

      {!editing && !isSplit && (
        <p className="mt-4 text-sm">
          <button
            type="button"
            className={linkButtonClass}
            onClick={() => patch({ legs: [{ to: values.to, amount: "" }, { to: "", amount: "" }] })}
          >
            Add split
          </button>
          <span className="text-ink-soft"> to divide it across several destinations</span>
        </p>
      )}

      {outcome?.conflict && (
        <div role="alert" className="mt-4 bg-amber-wash p-3 text-sm text-amber-ink">
          <p className="font-medium">{outcome.failure.message}</p>
          <p className="figures mt-1">
            Stored now: {nameOf(outcome.conflict.fromNodeId)} → {nameOf(outcome.conflict.toNodeId)},{" "}
            {formatPaiseText(outcome.conflict.amountPaise)}, {outcome.conflict.occurredAt}
            {outcome.conflict.note ? `, "${outcome.conflict.note}"` : ""}.
          </p>
          <p className="mt-1">What you typed is still in the form.</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              className={buttonClass}
              onClick={() => {
                const stored = outcome.conflict
                if (!stored) return
                setValues(draftOf(stored))
                setVersion(stored.version)
                setOutcome(null)
              }}
            >
              Use the stored version
            </button>
            <button
              type="button"
              className={buttonClass}
              disabled={pending}
              onClick={() => {
                const stored = outcome.conflict
                if (!stored) return
                setVersion(stored.version)
                send(stored.version)
              }}
            >
              Save mine over it
            </button>
          </div>
        </div>
      )}

      {alertText && (
        <p role="alert" className="mt-4 bg-red-wash px-3 py-2 text-sm text-red">
          {alertText}
        </p>
      )}

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <button type="submit" disabled={pending} className="rounded-sm bg-pen px-4 py-2.5 font-medium text-pen-ink disabled:opacity-60">
          {editing ? "Save changes" : isSplit ? "Record split" : "Record transaction"}
        </button>
        {editing ? (
          <button type="button" className={linkButtonClass} onClick={onFinished}>
            Cancel
          </button>
        ) : (
          <button type="button" className={linkButtonClass} onClick={clear} disabled={pending}>
            Clear form
          </button>
        )}
      </div>
    </form>
  )
}

interface FieldProps {
  idBase: string
  label: string
  optional?: boolean
  hint?: string
  errors: string[] | undefined
  /** Given the attributes that tie the control to its label, hint and error. */
  children: (control: ControlAttributes) => React.ReactNode
}

interface ControlAttributes {
  id: string
  "aria-invalid": true | undefined
  "aria-describedby": string | undefined
}

function Field({ idBase, label, optional, hint, errors, children }: FieldProps) {
  const hintId = `${idBase}-hint`
  const errorId = `${idBase}-error`
  const invalid = errors !== undefined && errors.length > 0
  const describedBy = [hint ? hintId : null, invalid ? errorId : null].filter(Boolean).join(" ") || undefined
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <label htmlFor={idBase} className="text-sm font-medium">
          {label}
        </label>
        {optional && <span className="text-xs text-ink-soft">optional</span>}
      </div>
      <div className="mt-1">{children({ id: idBase, "aria-invalid": invalid || undefined, "aria-describedby": describedBy })}</div>
      {hint && (
        <p id={hintId} className="mt-1 text-xs text-ink-soft">
          {hint}
        </p>
      )}
      {invalid && (
        <p id={errorId} className="mt-1 text-sm font-medium text-red">
          {errors.join(" ")}
        </p>
      )}
    </div>
  )
}

interface NodePickerProps extends ControlAttributes {
  value: string
  onChange: (id: string) => void
  choices: PickerNode[]
  placeholder: string
  disabled?: boolean
  "data-first-field"?: string
}

/** A select of nodes, grouped by kind. The placeholder is the empty choice: a destination is never chosen by default. */
function NodePicker({ value, onChange, choices, placeholder, disabled, ...attributes }: NodePickerProps) {
  return (
    <select {...attributes} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)} className={inputClass}>
      <option value="">{placeholder}</option>
      {groupByKind(choices).map((group) => (
        <optgroup key={group.kind} label={group.label}>
          {group.nodes.map((node) => (
            <option key={node.id} value={node.id}>
              {nodeLabel(node)}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  )
}
