"use client"

import { CircleAlert, LoaderCircle, TriangleAlert } from "lucide-react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useEffect, useId, useRef, useState, useTransition } from "react"
import { Field, NodePicker } from "@/app/transactions/transaction-form"
import { destinationChoices, groupWithSetup, sourceChoices } from "@/app/transactions/pickers"
import { NoticeToast, type ToastNotice } from "@/components/ui/notice-toast"
import { SpotlightCard } from "@/components/ui/spotlight-card"
import { buttonClass, inputClass } from "@/components/ui/styles"
import { Switch } from "@/components/ui/switch"
import { calendarDate, type CalendarDate } from "@/domain/calendar-date"
import { RECURRENCE_FREQUENCIES, type RecurrenceFrequency } from "@/domain/recurrence"
import { formatPaiseText } from "@/lib/node-money"
import { describeSchedule, nextDatesPreview } from "@/lib/recurring-text"
import { newRequestKey } from "@/lib/request-key"
import { RULE_NAME_MAX_LENGTH } from "@/lib/schemas/recurring"
import type { PickerNode } from "@/lib/transaction-list-view"
import { formatDay, parseTags } from "@/lib/transaction-text"
import type { ActionFailure } from "@/server/action-support"
import { createRuleAction, editRuleAction } from "./actions"
import { attempt, couldNot } from "./feedback"
import { leaveFlash, useFlash } from "./flash"
import {
  AUTO_POST_REASON,
  autoPostOffered,
  DAY_OF_MONTH_HINT,
  dayControlOf,
  endsBeforeStart,
  entriesDueNow,
  entriesNowLine,
  scheduleOfFields,
  wholeNumber,
  type RuleFormValues,
} from "./rule-fields"

// One form for a rule, new or edited: what moves (a source, a destination, an amount), how often, and from when. Choosing
// the source narrows the destinations to what the flow rules allow, as in the transaction form. Below the schedule a live
// preview shows the next three dates and, when the start is already past, how many entries will appear at once, so what a
// save will do is visible before it is saved. The preview is computed here from the same pure functions the server uses.
//
// The request key is chosen once, when the form opens, and kept across every attempt to submit it: a double click or a retry
// is then one rule, not two. Editing has no key, only the version it was opened at; a stale version is told the rule changed
// and offered a reload, which re-reads the rule (the page keys this form by its version, so it starts over from what is
// stored). A save goes to /recurring, which says what was done.

interface Props {
  /** Every node, archived included; the pickers narrow them. */
  nodes: PickerNode[]
  /** Today in the user's own zone. */
  today: CalendarDate
  /** What the form starts from: blank, a transaction's, or the rule's own. */
  initial: RuleFormValues
  /**
   * The rule being edited, with the version it was opened at, how many entries it already has and whether it is paused (a
   * paused rule makes no entries, so the preview must not promise any); null to create.
   */
  editing: { id: string; version: number; occurrences: number; paused?: boolean } | null
}

interface Outcome {
  fieldErrors: Record<string, string[]>
  message: string
  isFieldProblem: boolean
  /** The rule changed since the form opened. */
  conflict: boolean
}

const FREQUENCY_LABEL: Record<RecurrenceFrequency, string> = {
  DAILY: "Daily",
  WEEKLY: "Weekly",
  MONTHLY: "Monthly",
  QUARTERLY: "Quarterly",
  YEARLY: "Yearly",
}
const UNIT: Record<RecurrenceFrequency, string> = { DAILY: "day", WEEKLY: "week", MONTHLY: "month", QUARTERLY: "quarter", YEARLY: "year" }
const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
const DAYS_OF_MONTH = Array.from({ length: 31 }, (_, index) => index + 1)

const linkButtonClass = "rounded-md text-sm font-medium text-link underline underline-offset-4 disabled:opacity-60"
const secondaryButton = buttonClass({ variant: "secondary", size: "sm" })
const unique = (messages: string[]) => [...new Set(messages)]

/** The field a server complaint is shown beside: the edit's fields arrive under `rule.`, and the day is one control. */
function fieldKey(key: string): string {
  const bare = key.startsWith("rule.") ? key.slice("rule.".length) : key
  return bare === "startDate" || bare === "nextDue" ? "anchor" : bare
}

function describeFailure(failure: ActionFailure): Outcome {
  const { code, message } = failure.error
  const fieldErrors: Record<string, string[]> = {}
  for (const [key, messages] of Object.entries(failure.error.fieldErrors ?? {})) {
    fieldErrors[fieldKey(key)] = [...(fieldErrors[fieldKey(key)] ?? []), ...messages]
  }
  const hasFields = Object.keys(fieldErrors).length > 0
  return {
    fieldErrors,
    conflict: code === "version_conflict",
    isFieldProblem: code === "invalid_input" || (code === "invalid" && hasFields),
    message: code === "invalid_input" ? "Check the highlighted fields." : message,
  }
}

export function RuleForm({ nodes, today, initial, editing }: Props) {
  const router = useRouter()
  const formId = useId()
  const formRef = useRef<HTMLFormElement>(null)
  const statusRef = useRef<HTMLDivElement>(null)
  const inFlight = useRef(false)
  const [values, setValues] = useState<RuleFormValues>(initial)
  const [requestKey] = useState(newRequestKey)
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const [notice, setNotice] = useState<ToastNotice | null>(null)
  const [pending, startTransition] = useTransition()

  // Said once, when the form opens after a reload that a version conflict asked for.
  useFlash(setNotice)

  // The nodes the form opened with stay on offer however they are classed or archived, so a rule (or a transaction) that
  // names one can still be seen and corrected; the server refuses what cannot be used.
  const keep = [initial.from, initial.to].filter((id) => id !== "")
  const sources = sourceChoices(nodes, keep)
  const destinations = destinationChoices(nodes, values.from, keep)
  const destination = nodes.find((node) => node.id === values.to)
  const offered = autoPostOffered(destination)
  const control = dayControlOf(values.frequency)
  const existing = editing?.occurrences ?? 0
  const errorsAt = (key: string) => outcome?.fieldErrors[key]

  const schedule = scheduleOfFields(values)
  const dates = schedule ? nextDatesPreview(schedule, existing, 3) : []
  const nowLine = schedule ? entriesNowLine(entriesDueNow(schedule, existing, today), values.autoPost && offered, editing?.paused === true) : null
  const interval = wholeNumber(values.interval)
  const unit = `${UNIT[values.frequency]}${values.interval.trim() === "1" ? "" : "s"}`
  const anchorLabel = editing ? "Next due on" : "Starts on"

  // Every problem is shown beside its field; what cannot be placed (a refusal about the whole rule) is said once, above
  // the buttons.
  const placed = new Set([
    "name", "fromNodeId", "toNodeId", "amount", "frequency", "interval", "anchor", "endDate", "occurrenceLimit", "note", "tags",
    ...(control === "dayOfMonth" ? ["dayOfMonth"] : []),
    ...(control === "dayOfWeek" ? ["dayOfWeek"] : []),
    ...(offered ? ["autoPost"] : []),
  ])
  const unplaced = outcome ? Object.entries(outcome.fieldErrors).filter(([key]) => !placed.has(key)) : []
  const alertText = !outcome || outcome.conflict
    ? null
    : outcome.isFieldProblem
      ? unplaced.length > 0
        ? unique(unplaced.flatMap(([, messages]) => messages)).join(" ")
        : null
      : outcome.message

  // A refusal moves the keyboard to the first field that needs attention, so a screen-reader user hears what is wrong.
  useEffect(() => {
    if (outcome) formRef.current?.querySelector<HTMLElement>("[aria-invalid='true']")?.focus()
  }, [outcome])

  function patch(change: Partial<RuleFormValues>) {
    setValues((current) => ({ ...current, ...change }))
  }

  // Changing the source drops a destination the new source cannot pay, rather than leaving an impossible pair.
  function chooseSource(from: string) {
    const legal = new Set(destinationChoices(nodes, from, keep).map((node) => node.id))
    patch({ from, to: legal.has(values.to) ? values.to : "" })
  }

  /** What is needed before anything can be sent: a choice with no useful server message, and a number the schema takes as one. */
  function localProblems(): Record<string, string[]> | null {
    const problems: Record<string, string[]> = {}
    if (values.from === "") problems.fromNodeId = ["Choose where the money comes from"]
    if (values.to === "") problems.toNodeId = ["Choose where the money goes"]
    if (interval === null) problems.interval = ["Enter a whole number, such as 1 or 2"]
    if (values.occurrenceLimit.trim() !== "" && wholeNumber(values.occurrenceLimit) === null) {
      problems.occurrenceLimit = ["Enter a whole number, or leave it empty"]
    }
    if (endsBeforeStart(values.anchor, values.endDate)) problems.endDate = [`The end date cannot be before the ${editing ? "next due" : "start"} date`]
    return Object.keys(problems).length > 0 ? problems : null
  }

  function send() {
    const problems = localProblems()
    if (problems || interval === null) {
      setOutcome({ fieldErrors: problems ?? {}, message: "Check the highlighted fields.", isFieldProblem: true, conflict: false })
      return
    }
    // The button is disabled while a request is out, but a second submit can still arrive (Enter held down, a double click
    // before the disabled state paints): this makes it a no-op rather than a second request. The request key is the backstop.
    if (inFlight.current) return
    inFlight.current = true
    const note = values.note.trim()
    const dayOfMonth = control === "dayOfMonth" ? wholeNumber(values.dayOfMonth) : null
    const dayOfWeek = control === "dayOfWeek" ? wholeNumber(values.dayOfWeek) : null
    const limit = wholeNumber(values.occurrenceLimit)
    const rule = {
      name: values.name,
      fromNodeId: values.from,
      toNodeId: values.to,
      amount: values.amount,
      ...(note === "" ? {} : { note }),
      tags: parseTags(values.tags),
      frequency: values.frequency,
      interval,
      ...(dayOfMonth === null ? {} : { dayOfMonth }),
      ...(dayOfWeek === null ? {} : { dayOfWeek }),
      ...(values.endDate.trim() === "" ? {} : { endDate: values.endDate }),
      ...(limit === null ? {} : { occurrenceLimit: limit }),
      autoPost: values.autoPost && offered,
    }

    startTransition(async () => {
      try {
        const saving = editing ? "save changes to the rule" : "create the rule"
        const result = await attempt(() =>
          editing
            ? editRuleAction({ id: editing.id, expectedVersion: editing.version, rule: { ...rule, nextDue: values.anchor } })
            : createRuleAction({ ...rule, startDate: values.anchor, idempotencyKey: requestKey }),
        )
        if (result === null || !result.ok) {
          setOutcome(
            result === null
              ? { fieldErrors: {}, message: couldNot(saving, null), isFieldProblem: false, conflict: false }
              : describeFailure(result),
          )
          return
        }
        const saved = result.data
        leaveFlash({
          tone: "success",
          lines: [
            `${editing ? "Saved changes to" : "Created"} ${saved.name}, ${formatPaiseText(saved.amountPaise)}. ${saved.scheduleText}.`,
            saved.state === "paused"
              ? "It is paused, so it makes no entries until you resume it."
              : saved.nextDueOn
                ? `Next entry ${formatDay(calendarDate(saved.nextDueOn))}.`
                : "It has no more entries to make.",
          ],
        })
        // Pending stays on until the next screen is there, so the button cannot be pressed again in between.
        router.push("/recurring")
      } finally {
        inFlight.current = false
      }
    })
  }

  function reload() {
    leaveFlash({ tone: "warning", lines: ["Reloaded. This is the rule as it is now."] })
    router.refresh()
  }

  const dayText = editing ? "the next due date" : "the start date"

  return (
    <>
    <SpotlightCard className="surface rounded-3xl" radius={340} strength={10}>
      <form
        ref={formRef}
        onSubmit={(event) => {
          event.preventDefault()
          send()
        }}
        noValidate
        aria-label={editing ? "Edit rule" : "New rule"}
        className="p-5 sm:p-6"
      >
        <div className="space-y-4">
          <Field idBase={`${formId}-name`} label="Name" errors={errorsAt("name")}>
            {(props) => (
              <input
                {...props}
                type="text"
                maxLength={RULE_NAME_MAX_LENGTH}
                autoComplete="off"
                placeholder="Rent, SIP, gym"
                value={values.name}
                onChange={(event) => patch({ name: event.target.value })}
                className={inputClass}
                data-first-field=""
              />
            )}
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field idBase={`${formId}-from`} label="From" errors={errorsAt("fromNodeId")}>
              {(props) => (
                <NodePicker
                  {...props}
                  value={values.from}
                  onChange={chooseSource}
                  groups={groupWithSetup(sources)}
                  placeholder="Choose a source"
                />
              )}
            </Field>
            <Field idBase={`${formId}-to`} label="To" errors={errorsAt("toNodeId")}>
              {(props) => (
                <NodePicker
                  {...props}
                  value={values.to}
                  onChange={(to) => patch({ to })}
                  groups={groupWithSetup(destinations)}
                  placeholder={values.from === "" ? "Choose a source first" : "Choose a destination"}
                  disabled={values.from === ""}
                />
              )}
            </Field>
          </div>

          <Field idBase={`${formId}-amount`} label="Amount (₹)" errors={errorsAt("amount")}>
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

          <div className="grid gap-4 sm:grid-cols-2">
            <Field idBase={`${formId}-frequency`} label="Repeats" errors={errorsAt("frequency")}>
              {(props) => (
                <select
                  {...props}
                  value={values.frequency}
                  onChange={(event) => patch({ frequency: event.target.value as RecurrenceFrequency })}
                  className={inputClass}
                >
                  {RECURRENCE_FREQUENCIES.map((frequency) => (
                    <option key={frequency} value={frequency}>
                      {FREQUENCY_LABEL[frequency]}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Field idBase={`${formId}-interval`} label="Repeat every" hint={unit} errors={errorsAt("interval")}>
              {(props) => (
                <input
                  {...props}
                  type="text"
                  inputMode="numeric"
                  autoComplete="off"
                  value={values.interval}
                  onChange={(event) => patch({ interval: event.target.value })}
                  className={`${inputClass} figures`}
                />
              )}
            </Field>
          </div>

          <Field
            idBase={`${formId}-anchor`}
            label={anchorLabel}
            hint={editing ? "The schedule starts again from this day. Entries already waiting or posted are not changed." : undefined}
            errors={errorsAt("anchor")}
          >
            {(props) => (
              <input
                {...props}
                type="date"
                value={values.anchor}
                onChange={(event) => patch({ anchor: event.target.value })}
                className={`${inputClass} figures`}
              />
            )}
          </Field>

          {control === "dayOfMonth" && (
            <Field idBase={`${formId}-day-of-month`} label="Day of the month" hint={DAY_OF_MONTH_HINT} errors={errorsAt("dayOfMonth")}>
              {(props) => (
                <select {...props} value={values.dayOfMonth} onChange={(event) => patch({ dayOfMonth: event.target.value })} className={`${inputClass} figures`}>
                  <option value="">Same as {dayText}</option>
                  {DAYS_OF_MONTH.map((day) => (
                    <option key={day} value={String(day)}>
                      {day}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          )}

          {control === "dayOfWeek" && (
            <Field idBase={`${formId}-day-of-week`} label="Day of the week" errors={errorsAt("dayOfWeek")}>
              {(props) => (
                <select {...props} value={values.dayOfWeek} onChange={(event) => patch({ dayOfWeek: event.target.value })} className={inputClass}>
                  <option value="">Same as {dayText}</option>
                  {WEEKDAYS.map((name, index) => (
                    <option key={name} value={String(index + 1)}>
                      {name}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <Field idBase={`${formId}-end`} label="Ends on" optional errors={errorsAt("endDate")}>
              {(props) => (
                <input {...props} type="date" value={values.endDate} onChange={(event) => patch({ endDate: event.target.value })} className={`${inputClass} figures`} />
              )}
            </Field>
            <Field idBase={`${formId}-limit`} label="Stops after" optional hint="Number of entries" errors={errorsAt("occurrenceLimit")}>
              {(props) => (
                <input
                  {...props}
                  type="text"
                  inputMode="numeric"
                  autoComplete="off"
                  value={values.occurrenceLimit}
                  onChange={(event) => patch({ occurrenceLimit: event.target.value })}
                  className={`${inputClass} figures`}
                />
              )}
            </Field>
          </div>

          <section aria-label="Schedule preview" className="rounded-2xl border border-line bg-canvas/60 p-4">
            <div aria-live="polite" className="text-sm">
              {schedule ? (
                <>
                  <p className="font-medium">{describeSchedule(schedule)}</p>
                  {dates.length > 0 && (
                    <>
                      <p className="mt-2 text-fg-soft">Next dates</p>
                      <ol className="mt-1.5 flex flex-wrap gap-2">
                        {dates.map((date) => (
                          <li key={date} className="figures rounded-full border border-line-strong px-3 py-1">
                            {formatDay(date)}
                          </li>
                        ))}
                      </ol>
                    </>
                  )}
                  <p className="mt-2 text-fg-soft">
                    {dates.length === 0
                      ? "It has no dates left: its end date or its limit has been reached."
                      : dates.length < 3
                        ? "Then it ends."
                        : schedule.endDate !== null || schedule.occurrenceLimit !== null
                          ? "And so on, until it ends."
                          : "And so on, with no end."}
                  </p>
                  {nowLine && <p className="mt-2 font-medium">{nowLine}</p>}
                </>
              ) : (
                <p className="text-fg-soft">Fill in the schedule to see its next dates.</p>
              )}
            </div>
          </section>

          <Field idBase={`${formId}-note`} label="Note" optional errors={errorsAt("note")}>
            {(props) => (
              <input {...props} type="text" maxLength={500} autoComplete="off" value={values.note} onChange={(event) => patch({ note: event.target.value })} className={inputClass} />
            )}
          </Field>

          <Field idBase={`${formId}-tags`} label="Tags" optional hint="Separate with commas" errors={errorsAt("tags")}>
            {(props) => (
              <input {...props} type="text" autoComplete="off" value={values.tags} onChange={(event) => patch({ tags: event.target.value })} className={inputClass} />
            )}
          </Field>

          <div>
            {offered ? (
              <>
                <Switch checked={values.autoPost} onChange={(autoPost) => patch({ autoPost })}>
                  Post automatically
                </Switch>
                <p className="mt-1.5 text-xs text-fg-soft">
                  Off: each entry waits in your inbox for you to post or skip. On: it posts itself on its day.
                </p>
                {errorsAt("autoPost") && (
                  <p className="mt-1 text-sm font-medium text-negative">{errorsAt("autoPost")?.join(" ")}</p>
                )}
              </>
            ) : (
              <>
                <p className="text-sm font-medium">Post automatically</p>
                <p id={`${formId}-autopost-reason`} className="mt-1 text-sm text-fg-soft">
                  Not available here. {AUTO_POST_REASON} Each entry waits in your inbox instead.
                </p>
              </>
            )}
          </div>
        </div>

        {outcome?.conflict && (
          <div role="alert" className="mt-4 rounded-2xl bg-notice-wash p-4 text-sm text-notice-fg">
            <p className="flex items-start gap-2.5 font-medium">
              <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
              <span>{outcome.message}</span>
            </p>
            <p className="mt-1">Nothing was saved. Reload to see the rule as it is now; what you typed here will be replaced.</p>
            <div className="mt-2">
              <button type="button" className={secondaryButton} onClick={reload}>
                Reload the rule
              </button>
            </div>
          </div>
        )}

        {alertText && (
          <p role="alert" className="mt-4 flex items-start gap-2.5 rounded-xl bg-negative-wash px-3.5 py-2.5 text-sm font-medium text-negative">
            <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
            <span>{alertText}</span>
          </p>
        )}

        <div className="mt-6 flex flex-wrap items-center gap-3">
          <button type="submit" disabled={pending} className={buttonClass()}>
            {pending && <LoaderCircle aria-hidden className="size-4 animate-spin" />}
            {editing ? "Save changes" : "Create rule"}
          </button>
          <Link href="/recurring" className={linkButtonClass}>
            Cancel
          </Link>
        </div>
      </form>
    </SpotlightCard>
    <NoticeToast notice={notice} onDismiss={() => setNotice(null)} statusRef={statusRef} />
    </>
  )
}
