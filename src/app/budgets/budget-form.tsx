"use client"

import { CircleAlert, LoaderCircle } from "lucide-react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useEffect, useId, useRef, useState, useTransition } from "react"
import { attempt, couldNot } from "@/app/feedback"
import { groupWithSetup } from "@/app/transactions/pickers"
import { Field, NodePicker } from "@/app/transactions/transaction-form"
import { SpotlightCard } from "@/components/ui/spotlight-card"
import { buttonClass, inputClass } from "@/components/ui/styles"
import { Switch } from "@/components/ui/switch"
import type { CalendarDate } from "@/domain/calendar-date"
import { spanLabel, type BudgetSettingsView } from "@/lib/budget-view"
import { formatPaiseText } from "@/lib/node-money"
import type { PickerNode } from "@/lib/transaction-list-view"
import type { ActionResult } from "@/server/action-support"
import { createBudgetAction, reviseBudgetAction, updateBudgetSettingsAction } from "./actions"
import {
  appliesFromOptions,
  blankValues,
  describeFailure,
  describeRevision,
  endMonthOptions,
  landingMonth,
  ledgerChoices,
  monthText,
  monthValue,
  ROLLOVER_NOTE,
  startMonthOptions,
  valuesOfBudget,
  type EditBudgetValues,
  type NewBudgetValues,
  type Outcome,
} from "./budget-fields"
import { leaveFlash } from "./flash"

// One form for a budget. New: the ledger (a live expense ledger), the monthly amount, the month it starts in, an optional
// last month and whether unspent budget carries over. Edit: the ledger is shown and fixed, and there are two sections, each
// saved on its own: Amount (a new amount and the month it applies from, with a sentence saying in words what that will do)
// and Settings (the last month and the rollover). A save goes to /budgets, which says what was done.
//
// There is no request key: a second submit of a new budget is refused by the server (a ledger cannot have two budgets for
// the same month), and the in-flight guard below stops it being sent in the first place. A refusal is shown beside its
// field and focus moves to the first field that needs attention.

interface Props {
  /** The user's expense ledgers, as the loader offers them; a budget's own ledger is among them even when archived. */
  nodes: PickerNode[]
  /** Today in the user's own zone. */
  today: CalendarDate
  /** The budget being edited; null to create one. */
  budget: BudgetSettingsView | null
}

type Section = "new" | "amount" | "settings"
type Saved = BudgetSettingsView | BudgetSettingsView[]

const linkButtonClass = "rounded-md text-sm font-medium text-link underline underline-offset-4"

const options = (items: { value: string; label: string }[]) =>
  items.map((item) => (
    <option key={item.value} value={item.value}>
      {item.label}
    </option>
  ))

/** What one save needs: the action's call, the verb for a failure message, and the lines the next screen says. */
interface Save {
  section: Section
  saving: string
  call: () => Promise<ActionResult<Saved>>
  said: (saved: BudgetSettingsView[]) => string[]
}

/** Sending, the guard against a second send, filing a refusal, and the hop to /budgets with its message. */
function useSaver(today: CalendarDate) {
  const router = useRouter()
  const inFlight = useRef(false)
  const [outcome, setOutcome] = useState<(Outcome & { section: Section }) | null>(null)
  const [pending, startTransition] = useTransition()

  function save({ section, saving, call, said }: Save) {
    // The buttons are disabled while a request is out, but a second submit can still arrive (Enter held down, a double click
    // before the disabled state paints): this makes it a no-op rather than a second request.
    if (inFlight.current) return
    inFlight.current = true
    startTransition(async () => {
      try {
        const result = await attempt(call)
        if (result === null) {
          setOutcome({ section, fieldErrors: {}, message: couldNot(saving, null), isFieldProblem: false })
          return
        }
        if (!result.ok) {
          setOutcome({ section, ...describeFailure(result) })
          return
        }
        const saved = Array.isArray(result.data) ? result.data : [result.data]
        const last = saved[saved.length - 1]
        leaveFlash({ tone: "success", lines: said(saved) })
        // Pending stays on until the next screen is there, so a button cannot be pressed again in between.
        router.push(`/budgets?month=${landingMonth(last, today)}`)
      } finally {
        inFlight.current = false
      }
    })
  }

  /** A problem found before anything is sent, filed like a server refusal so focus goes to it. */
  function refuse(section: Section, fieldErrors: Record<string, string[]>) {
    setOutcome({ section, fieldErrors, message: "Check the highlighted fields.", isFieldProblem: true })
  }

  return { outcome, pending, save, refuse }
}

const money = (paise: string) => formatPaiseText(paise)
const spanLine = (budget: BudgetSettingsView) =>
  `${spanLabel(budget.startMonth, budget.endMonth)}${budget.rollover ? ". Unspent budget carries over." : "."}`

export function BudgetForm({ nodes, today, budget }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const { outcome, pending, save, refuse } = useSaver(today)

  // A refusal moves the keyboard to the first field that needs attention, so a screen-reader user hears what is wrong.
  useEffect(() => {
    if (outcome) containerRef.current?.querySelector<HTMLElement>("[aria-invalid='true']")?.focus()
  }, [outcome])

  /** What this section shows of the last refusal: its fields' messages, and the sentence for what no field can show. */
  const feedback = (section: Section, placed: string[]) => {
    const mine = outcome?.section === section ? outcome : null
    const unplaced = mine ? Object.entries(mine.fieldErrors).filter(([key]) => !placed.includes(key)) : []
    const alertText = !mine
      ? null
      : mine.isFieldProblem
        ? unplaced.length > 0 ? [...new Set(unplaced.flatMap(([, messages]) => messages))].join(" ") : null
        : mine.message
    return { errorsAt: (key: string) => mine?.fieldErrors[key], alertText }
  }

  return (
    <SpotlightCard className="surface rounded-3xl" radius={340} strength={10}>
      <div ref={containerRef}>
        {budget ? (
          <EditSections nodes={nodes} today={today} budget={budget} pending={pending} save={save} feedback={feedback} />
        ) : (
          <NewBudget nodes={nodes} today={today} pending={pending} save={save} refuse={refuse} feedback={feedback} />
        )}
      </div>
    </SpotlightCard>
  )
}

interface Feedback {
  errorsAt: (key: string) => string[] | undefined
  alertText: string | null
}
interface SectionProps {
  nodes: PickerNode[]
  today: CalendarDate
  pending: boolean
  save: (save: Save) => void
  feedback: (section: Section, placed: string[]) => Feedback
}
interface NewProps extends SectionProps {
  refuse: (section: Section, fieldErrors: Record<string, string[]>) => void
}

function Alert({ text }: { text: string | null }) {
  if (!text) return null
  return (
    <p role="alert" className="mt-4 flex items-start gap-2.5 rounded-xl bg-negative-wash px-3.5 py-2.5 text-sm font-medium text-negative">
      <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
      <span>{text}</span>
    </p>
  )
}

function Rollover({ checked, onChange }: { checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <div>
      <Switch checked={checked} onChange={onChange}>
        Carry unspent budget over
      </Switch>
      <p className="mt-1.5 text-xs text-fg-soft">{ROLLOVER_NOTE}</p>
    </div>
  )
}

function SubmitRow({ label, pending, cancel }: { label: string; pending: boolean; cancel?: boolean }) {
  return (
    <div className="mt-6 flex flex-wrap items-center gap-3">
      <button type="submit" disabled={pending} className={buttonClass()}>
        {pending && <LoaderCircle aria-hidden className="size-4 animate-spin" />}
        {label}
      </button>
      {cancel && (
        <Link href="/budgets" className={linkButtonClass}>
          Cancel
        </Link>
      )}
    </div>
  )
}

// -- New ------------------------------------------------------------------------------------------------------------------

function NewBudget({ nodes, today, pending, save, refuse, feedback }: NewProps) {
  const formId = useId()
  const [values, setValues] = useState<NewBudgetValues>(() => blankValues(today))
  const { errorsAt, alertText } = feedback("new", ["nodeId", "amount", "startMonth", "endMonth"])
  const ledgers = ledgerChoices(nodes)

  function patch(change: Partial<NewBudgetValues>) {
    setValues((current) => ({ ...current, ...change }))
  }

  // Moving the start past the last month would leave an end the list no longer offers: the end is cleared instead.
  function chooseStart(startMonth: string) {
    patch({ startMonth, ...(values.endMonth !== "" && values.endMonth < startMonth ? { endMonth: "" } : {}) })
  }

  function send() {
    if (values.nodeId === "") {
      refuse("new", { nodeId: ["Choose a ledger"] })
      return
    }
    save({
      section: "new",
      saving: "create the budget",
      call: () =>
        createBudgetAction({
          nodeId: values.nodeId,
          amount: values.amount,
          startMonth: values.startMonth,
          endMonth: values.endMonth === "" ? null : values.endMonth,
          rollover: values.rollover,
        }),
      said: ([created]) => [`Created a budget of ${money(created.amountPaise)} a month for ${created.nodeName}.`, spanLine(created)],
    })
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        send()
      }}
      noValidate
      aria-label="New budget"
      className="p-5 sm:p-6"
    >
      <div className="space-y-4">
        <Field idBase={`${formId}-node`} label="Ledger" hint="A budget counts what you spend on this ledger and the ledgers inside it." errors={errorsAt("nodeId")}>
          {(props) => (
            <NodePicker
              {...props}
              value={values.nodeId}
              onChange={(nodeId) => patch({ nodeId })}
              groups={groupWithSetup(ledgers)}
              placeholder="Choose a ledger"
              data-first-field=""
            />
          )}
        </Field>

        <Field idBase={`${formId}-amount`} label="Monthly amount (₹)" errors={errorsAt("amount")}>
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
          <Field idBase={`${formId}-start`} label="Starts in" errors={errorsAt("startMonth")}>
            {(props) => (
              <select {...props} value={values.startMonth} onChange={(event) => chooseStart(event.target.value)} className={inputClass}>
                {options(startMonthOptions(today))}
              </select>
            )}
          </Field>
          <Field idBase={`${formId}-end`} label="Last month" optional errors={errorsAt("endMonth")}>
            {(props) => (
              <select {...props} value={values.endMonth} onChange={(event) => patch({ endMonth: event.target.value })} className={inputClass}>
                <option value="">No end</option>
                {options(endMonthOptions(values.startMonth, values.endMonth, today))}
              </select>
            )}
          </Field>
        </div>

        <Rollover checked={values.rollover} onChange={(rollover) => patch({ rollover })} />
      </div>
      <Alert text={alertText} />
      <SubmitRow label="Create budget" pending={pending} cancel />
    </form>
  )
}

// -- Edit -----------------------------------------------------------------------------------------------------------------

function EditSections({ nodes, today, budget, pending, save, feedback }: SectionProps & { budget: BudgetSettingsView }) {
  const formId = useId()
  const [values, setValues] = useState<EditBudgetValues>(() => valuesOfBudget(budget, today))
  const amount = feedback("amount", ["amount", "appliesFrom"])
  const settings = feedback("settings", ["endMonth"])
  const startMonth = monthValue(budget.startMonth)
  const endMonth = budget.endMonth === null ? null : monthValue(budget.endMonth)
  const patch = (change: Partial<EditBudgetValues>) => setValues((current) => ({ ...current, ...change }))

  function saveAmount() {
    save({
      section: "amount",
      saving: "save the amount",
      call: () => reviseBudgetAction({ id: budget.id, amount: values.amount, appliesFrom: values.appliesFrom }),
      said: (saved) => {
        const last = saved[saved.length - 1]
        return saved.length === 2
          ? [`Changed the ${last.nodeName} budget to ${money(last.amountPaise)} from ${monthText(last.startMonth)}.`, "Earlier months keep the old amount."]
          : [`Corrected the ${last.nodeName} budget to ${money(last.amountPaise)} for every month of it.`]
      },
    })
  }

  function saveSettings() {
    save({
      section: "settings",
      saving: "save the settings",
      call: () =>
        updateBudgetSettingsAction({ id: budget.id, endMonth: values.endMonth === "" ? null : values.endMonth, rollover: values.rollover }),
      said: ([saved]) => [`Saved the settings for the ${saved.nodeName} budget.`, spanLine(saved)],
    })
  }

  return (
    <div className="p-5 sm:p-6">
      <Field
        idBase={`${formId}-node`}
        label="Ledger"
        hint="A budget stays on its ledger. To budget another one, create a new budget."
        errors={undefined}
      >
        {(props) => (
          <NodePicker {...props} value={budget.nodeId} onChange={() => {}} groups={groupWithSetup(ledgerChoices(nodes, [budget.nodeId]))} placeholder="Choose a ledger" disabled />
        )}
      </Field>

      <form
        onSubmit={(event) => {
          event.preventDefault()
          saveAmount()
        }}
        noValidate
        aria-labelledby={`${formId}-amount-heading`}
        className="mt-6 border-t border-line pt-6"
      >
        <h2 id={`${formId}-amount-heading`} className="font-display text-lg font-semibold tracking-tight">
          Amount
        </h2>
        <div className="mt-4 space-y-4">
          <Field idBase={`${formId}-amount`} label="Monthly amount (₹)" errors={amount.errorsAt("amount")}>
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
          <Field idBase={`${formId}-applies-from`} label="Applies from" errors={amount.errorsAt("appliesFrom")}>
            {(props) => (
              <select {...props} value={values.appliesFrom} onChange={(event) => patch({ appliesFrom: event.target.value })} className={inputClass}>
                {options(appliesFromOptions(startMonth, today))}
              </select>
            )}
          </Field>
          <p aria-live="polite" className="rounded-2xl border border-line bg-canvas/60 p-4 text-sm font-medium">
            {describeRevision(startMonth, values.appliesFrom, endMonth)}
          </p>
        </div>
        <Alert text={amount.alertText} />
        <SubmitRow label="Save amount" pending={pending} />
      </form>

      <form
        onSubmit={(event) => {
          event.preventDefault()
          saveSettings()
        }}
        noValidate
        aria-labelledby={`${formId}-settings-heading`}
        className="mt-6 border-t border-line pt-6"
      >
        <h2 id={`${formId}-settings-heading`} className="font-display text-lg font-semibold tracking-tight">
          Settings
        </h2>
        <div className="mt-4 space-y-4">
          <Field
            idBase={`${formId}-end`}
            label="Last month"
            optional
            hint={`It began in ${monthText(startMonth)}.`}
            errors={settings.errorsAt("endMonth")}
          >
            {(props) => (
              <select {...props} value={values.endMonth} onChange={(event) => patch({ endMonth: event.target.value })} className={inputClass}>
                <option value="">No end</option>
                {options(endMonthOptions(startMonth, values.endMonth, today))}
              </select>
            )}
          </Field>
          <Rollover checked={values.rollover} onChange={(rollover) => patch({ rollover })} />
        </div>
        <Alert text={settings.alertText} />
        <SubmitRow label="Save settings" pending={pending} />
      </form>

      <div className="mt-6 border-t border-line pt-4">
        <Link href="/budgets" className={linkButtonClass}>
          Cancel
        </Link>
      </div>
    </div>
  )
}
