"use client"

import { CircleAlert, LoaderCircle } from "lucide-react"
import { useEffect, useId, useRef, useState, useTransition } from "react"
import { Field } from "@/app/transactions/transaction-form"
import { groupByKind, nodeLabel } from "@/app/transactions/pickers"
import { buttonClass, inputClass } from "@/components/ui/styles"
import type { CalendarDate } from "@/domain/calendar-date"
import { formatQuantity, parseQuantity, QuantityParseError } from "@/domain/quantity"
import type { HoldingView, SalePreviewView } from "@/lib/investment-view"
import { describeSaleFigures, quantityText } from "@/lib/investment-text"
import { formatPaiseText } from "@/lib/node-money"
import { newRequestKey } from "@/lib/request-key"
import type { PickerNode } from "@/lib/transaction-list-view"
import type { ActionFailure } from "@/server/action-support"
import { previewSaleAction, sellAction } from "./actions"

// Selling (or redeeming) part of an investment held by lots: how much, what it brought in, which account the money went
// into, and the day. As the fields change the form asks the server what the sale would post, and says it ("Cost basis
// ₹56,000.00 · gain ₹12,000.00") in a polite live region before anything is sent: the cost basis is the lots' business,
// and only the server knows them. A lump investment is sold whole, so it has no quantity to choose.
//
// The request key is chosen when the form opens and kept across every attempt to submit it, so a double click or a retry
// is one sale (EC-17); it is replaced after a success, as on the transaction form. Previews are debounced, and a reply that
// arrives after a newer request was sent is dropped, so a slow answer about what was typed earlier never overwrites the
// answer about what is typed now.

const PREVIEW_DELAY_MS = 300

interface Props {
  holding: HoldingView
  /** Where the money may go: the user's accounts and liabilities still in use. */
  destinations: PickerNode[]
  today: CalendarDate
  /** The sale was recorded: the lines of the message to show. */
  onSold: (lines: string[]) => void
  onCancel: () => void
}

interface Draft {
  quantity: string
  proceeds: string
  to: string
  date: string
  note: string
}

interface Outcome {
  fieldErrors: Record<string, string[]>
  /** Said once, above the button: a refusal that belongs to no field on the form. */
  message: string | null
}

/** What the server said about one set of field values: the figures, or why there would be none. */
interface Preview {
  key: string
  figures: SalePreviewView | null
  /** A refusal about the quantity (more than is held, too small to sell), shown beside it. */
  problem: string | null
  /** The preview could not be asked for at all. */
  unavailable: boolean
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

export function SellForm({ holding, destinations, today, onSold, onCancel }: Props) {
  const formId = useId()
  const formRef = useRef<HTMLFormElement>(null)
  const inFlight = useRef(false)
  const latestPreview = useRef(0)
  const lump = holding.valuationMode === "LUMP"
  const unit = holding.unitLabel || null
  const [values, setValues] = useState<Draft>({ quantity: lump ? "1" : "", proceeds: "", to: "", date: today, note: "" })
  const [requestKey, setRequestKey] = useState(newRequestKey)
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [pending, startTransition] = useTransition()

  const groups = groupByKind(destinations)
  const nameOf = (id: string) => destinations.find((node) => node.id === id)?.name ?? "the account"

  // The figures do not depend on where the money goes, so before a destination is chosen the preview asks with the first
  // one on offer: every one of them is a place a sale may pay into.
  const request = {
    nodeId: holding.nodeId,
    toNodeId: values.to || destinations[0]?.id || "",
    quantity: values.quantity.trim(),
    proceeds: values.proceeds.trim(),
    occurredAt: values.date,
  }
  const ready = request.toNodeId !== "" && request.quantity !== "" && request.proceeds !== "" && request.occurredAt !== ""
  const previewKey = ready ? JSON.stringify(request) : ""
  const shown = preview !== null && preview.key === previewKey ? preview : null

  useEffect(() => {
    if (previewKey === "") return
    const sent = ++latestPreview.current
    const input = JSON.parse(previewKey) as typeof request
    const timer = setTimeout(async () => {
      let result: Awaited<ReturnType<typeof previewSaleAction>>
      try {
        result = await previewSaleAction(input)
      } catch {
        // The request itself failed (the network, the server). Submitting still works, and says what it posted.
        if (sent === latestPreview.current) setPreview({ key: previewKey, figures: null, problem: null, unavailable: true })
        return
      }
      if (sent !== latestPreview.current) return // a newer request has been sent since: this answer is out of date
      if (result.ok) return setPreview({ key: previewKey, figures: result.data, problem: null, unavailable: false })
      // A quantity the lots cannot cover, or one too small to sell, is worth saying while typing. A field that does not
      // parse yet is not: it is usually half typed, and submitting says what is wrong with it.
      const aboutQuantity = result.error.code !== "invalid_input" ? result.error.fieldErrors?.quantity : undefined
      setPreview({ key: previewKey, figures: null, problem: aboutQuantity ? unique(aboutQuantity).join(" ") : null, unavailable: false })
    }, PREVIEW_DELAY_MS)
    return () => clearTimeout(timer)
  }, [previewKey]) // the request is read back from its key, so the key is all the effect depends on

  // A refusal moves the keyboard to the first field that needs attention, so a screen-reader user hears what is wrong.
  useEffect(() => {
    if (outcome) formRef.current?.querySelector<HTMLElement>("[aria-invalid='true']")?.focus()
  }, [outcome])

  function patch(change: Partial<Draft>) {
    setValues((current) => ({ ...current, ...change }))
    setOutcome(null) // what was refused is no longer what is typed; the preview speaks for the new values
  }

  // Every problem is shown beside the field it belongs to; one about the investment itself (archived, not sold by lot)
  // has no control on this form, so it is said once, above the button, as is a refusal that names no field at all.
  const placed = new Set(["toNodeId", "proceeds", "occurredAt", "note", ...(lump ? [] : ["quantity"])])
  const errorsAt = (key: string) => outcome?.fieldErrors[key]
  const unplaced = outcome ? Object.entries(outcome.fieldErrors).filter(([key]) => !placed.has(key)) : []
  const alertText = outcome
    ? unplaced.length > 0
      ? unique(unplaced.flatMap(([, messages]) => messages)).join(" ")
      : Object.keys(outcome.fieldErrors).length === 0
        ? outcome.message
        : null
    : null
  // The quantity's refusal from the server replaces the preview's: the same words are never said twice.
  const quantityProblem = errorsAt("quantity") ? null : shown?.problem ?? null

  function reportFailure(failure: ActionFailure) {
    setOutcome({ fieldErrors: failure.error.fieldErrors ?? {}, message: failure.error.message })
  }

  function send() {
    if (values.to === "") {
      setOutcome({ fieldErrors: { toNodeId: ["Choose where the money goes"] }, message: null })
      return
    }
    // The button is disabled while a request is out, but a second submit can still arrive (Enter held down, a double
    // click before the disabled state paints): this makes it a no-op. The request key is the backstop.
    if (inFlight.current) return
    inFlight.current = true
    const note = values.note.trim()
    startTransition(async () => {
      try {
        const result = await sellAction({
          nodeId: holding.nodeId,
          toNodeId: values.to,
          quantity: values.quantity.trim(),
          proceeds: values.proceeds.trim(),
          occurredAt: values.date,
          ...(note === "" ? {} : { note }),
          idempotencyKey: requestKey,
        })
        if (!result.ok) return reportFailure(result)
        const sold = result.data.preview
        const what = lump ? holding.name : `${quantityText(normalisedQuantity(values.quantity), unit)} of ${holding.name}`
        setRequestKey(newRequestKey()) // the next sale is a new request
        setOutcome(null)
        onSold([`Sold ${what} for ${formatPaiseText(sold.proceedsPaise)} into ${nameOf(values.to)}.`, `${describeSaleFigures(sold)}.`])
      } finally {
        inFlight.current = false
      }
    })
  }

  const secondary = buttonClass({ variant: "secondary" })
  const previewId = `${formId}-preview-problem`

  return (
    <form
      ref={formRef}
      aria-label={`Sell ${holding.name}`}
      noValidate
      onSubmit={(event) => {
        event.preventDefault()
        send()
      }}
      className="rounded-2xl border border-line bg-canvas/60 p-4 sm:p-5"
    >
      <h3 className="font-display text-base font-semibold tracking-tight">Sell or redeem {holding.name}</h3>
      {lump ? (
        <p className="mt-1 text-sm text-fg-soft">Sells the whole of {holding.name}: a lump sum is sold in one piece.</p>
      ) : (
        <p className="mt-1 text-sm text-fg-soft">
          Taken from the oldest purchases first. You hold <span className="figures font-medium text-fg">{quantityText(holding.quantityHeld, unit)}</span>.
        </p>
      )}

      {destinations.length === 0 ? (
        <p className="mt-4 text-sm">There is no account for the money to go into. Add one on the Ledger screen first.</p>
      ) : (
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          {!lump && (
            <div>
              <Field idBase={`${formId}-quantity`} label={unit ? `Quantity (${unit})` : "Quantity"} errors={errorsAt("quantity")}>
                {(props) => (
                  <input
                    {...props}
                    aria-describedby={[props["aria-describedby"], quantityProblem ? previewId : null].filter(Boolean).join(" ") || undefined}
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
              <p id={previewId} aria-live="polite" className="mt-1 text-sm font-medium text-negative empty:hidden">
                {quantityProblem}
              </p>
            </div>
          )}

          <Field idBase={`${formId}-proceeds`} label="Proceeds (₹)" errors={errorsAt("proceeds")}>
            {(props) => (
              <input
                {...props}
                type="text"
                inputMode="decimal"
                autoComplete="off"
                placeholder="0.00"
                value={values.proceeds}
                onChange={(event) => patch({ proceeds: event.target.value })}
                className={`${inputClass} figures`}
              />
            )}
          </Field>

          <Field idBase={`${formId}-to`} label="Paid into" errors={errorsAt("toNodeId")}>
            {(props) => (
              <select {...props} value={values.to} onChange={(event) => patch({ to: event.target.value })} className={inputClass}>
                <option value="">Choose an account</option>
                {groups.map((group) => (
                  <optgroup key={group.kind} label={group.label}>
                    {group.nodes.map((node) => (
                      <option key={node.id} value={node.id}>
                        {nodeLabel(node)}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            )}
          </Field>

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

          <div className="sm:col-span-2">
            <Field idBase={`${formId}-note`} label="Note" optional errors={errorsAt("note")}>
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
          </div>
        </div>
      )}

      {/* What the sale would post, from the server, for exactly what is typed now. */}
      <p aria-live="polite" className="figures mt-4 min-h-6 text-sm font-medium empty:hidden">
        {shown?.figures ? (
          describeSaleFigures(shown.figures)
        ) : shown?.unavailable ? (
          <span className="font-normal text-fg-soft">Could not check the figures just now.</span>
        ) : null}
      </p>

      {alertText && (
        <p role="alert" className="mt-4 flex items-start gap-2.5 rounded-xl bg-negative-wash px-3.5 py-2.5 text-sm font-medium text-negative">
          <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span>{alertText}</span>
        </p>
      )}

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <button type="submit" disabled={pending || destinations.length === 0} className={buttonClass()}>
          {pending && <LoaderCircle aria-hidden className="size-4 animate-spin" />}
          Sell
        </button>
        {/* Not while a sale is out: closing the form then would drop its answer, a refusal included, unseen. */}
        <button type="button" className={secondary} disabled={pending} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  )
}
