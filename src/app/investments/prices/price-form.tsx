"use client"

import { CircleAlert, LoaderCircle } from "lucide-react"
import Link from "next/link"
import { useEffect, useId, useRef, useState, useTransition } from "react"
import { TONE_CLASS } from "@/app/amount"
import { Field } from "@/app/transactions/transaction-form"
import { buttonClass, inputClass } from "@/components/ui/styles"
import { compareDates, type CalendarDate } from "@/domain/calendar-date"
import { describeRevaluation, priceText, quantityText } from "@/lib/investment-text"
import type { RevaluationPreviewView } from "@/lib/investment-view"
import { priceSchema } from "@/lib/schemas/investment"
import { serialisePaise } from "@/lib/serialise"
import { formatDay } from "@/lib/transaction-text"
import { cn } from "@/lib/utils"
import { previewPriceAction, recordPriceAction } from "../actions"

// Entering the price of one unit of an investment on a day (for a lump, the price of the whole of it). As the fields change
// the form asks the server what the price would make the investment worth today, and says it ("Value now ₹1,17,000.00 →
// ₹1,20,000.00 (+₹3,000.00)") in a polite live region before anything is saved: only the server knows the holding.
//
// Previews are debounced, and each answer is kept with the key of the request it answers: it is shown only while that key
// is still what the fields say, and an answer that arrives after a newer request was sent is dropped, so a slow reply
// about what was typed earlier never overwrites the reply about what is typed now. Fields that do not parse yet ask
// nothing, and the preview goes. Saving needs no request key: a price for a day replaces that day's (EC-26), so sending
// the same price twice leaves one.

const PREVIEW_DELAY_MS = 300

/** An investment a price can be entered for: revalued by quantity or as a lump, and not archived. */
export interface PriceTarget {
  nodeId: string
  name: string
  unit: string | null
  lump: boolean
  /** Units held today, as decimal text. */
  quantityHeld: string
  /** Some purchases have no quantity, so no price can value it until they do (plan call 7). */
  needsQuantity: boolean
}

/** A price the investment already has. */
export interface KnownPrice {
  asOf: CalendarDate
  pricePerUnitPaise: string
}

interface Props {
  targets: PriceTarget[]
  selected: string
  onSelect: (nodeId: string) => void
  today: CalendarDate
  /** The chosen investment's prices, newest first, once read; null until then. Used to say what a save replaced. */
  known: KnownPrice[] | null
  /** Bumped by the screen after every write, so a preview is asked again of prices that have changed. */
  revision: number
  /** The price was saved: the message to show. */
  onSaved: (lines: string[]) => void
}

interface Outcome {
  fieldErrors: Record<string, string[]>
  /** Said once, above the button: a refusal that belongs to no field on the form. */
  message: string | null
}

/** What the server said about one set of field values: the figures, or why there would be none. */
interface Preview {
  key: string
  figures: RevaluationPreviewView | null
  /** A refusal about the day (after today), shown beside the Date field. */
  dayProblem: string | null
  /** The preview could not be asked for at all. */
  unavailable: boolean
}

const unique = (messages: string[]) => [...new Set(messages)]

/** The price field's label: per the investment's unit, or the whole of a lump. */
export function priceLabel(target: PriceTarget | undefined): string {
  if (target?.lump) return "Price of the whole (₹)"
  return `Price per ${target?.unit ?? "unit"} (₹)`
}

const linkClass = "rounded-md font-medium text-link underline underline-offset-4"

export function PriceForm({ targets, selected, onSelect, today, known, revision, onSaved }: Props) {
  const formId = useId()
  const formRef = useRef<HTMLFormElement>(null)
  const inFlight = useRef(false)
  const latestPreview = useRef(0)
  const [date, setDate] = useState<string>(today)
  const [price, setPrice] = useState("")
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [pending, startTransition] = useTransition()

  const target = targets.find((candidate) => candidate.nodeId === selected)
  const request = { nodeId: selected, asOf: date, price: price.trim() }
  // Asked only of fields that parse (an investment, a real day, a price above zero): a half-typed price asks nothing.
  const ready = target !== undefined && priceSchema.safeParse(request).success
  const previewKey = ready ? JSON.stringify({ ...request, revision }) : ""
  const shown = preview !== null && preview.key === previewKey ? preview : null

  useEffect(() => {
    if (previewKey === "") return
    const sent = ++latestPreview.current
    const { nodeId, asOf, price: text } = JSON.parse(previewKey) as typeof request
    const timer = setTimeout(async () => {
      let result: Awaited<ReturnType<typeof previewPriceAction>>
      try {
        result = await previewPriceAction({ nodeId, asOf, price: text })
      } catch {
        // The request itself failed (the network, the server). Saving still works, and says what it saved.
        if (sent === latestPreview.current) setPreview({ key: previewKey, figures: null, dayProblem: null, unavailable: true })
        return
      }
      if (sent !== latestPreview.current) return // a newer request has been sent since: this answer is out of date
      if (result.ok) return setPreview({ key: previewKey, figures: result.data, dayProblem: null, unavailable: false })
      const aboutDay = result.error.fieldErrors?.asOf
      setPreview({ key: previewKey, figures: null, dayProblem: aboutDay ? unique(aboutDay).join(" ") : null, unavailable: false })
    }, PREVIEW_DELAY_MS)
    return () => clearTimeout(timer)
  }, [previewKey]) // the request is read back from its key, so the key is all the effect depends on

  // A refusal moves the keyboard to the first field that needs attention, so a screen-reader user hears what is wrong.
  useEffect(() => {
    if (outcome) formRef.current?.querySelector<HTMLElement>("[aria-invalid='true']")?.focus()
  }, [outcome])

  // What is refused is no longer what is typed once a field changes; the preview speaks for the new values.
  function change(apply: () => void) {
    apply()
    setOutcome(null)
  }

  // A price is the price of one investment: typed for gold, it must not be saved for silver without being typed again.
  // The day stays, since prices are often entered for several investments on one day.
  function choose(nodeId: string) {
    onSelect(nodeId)
    setPrice("")
    setPreview(null)
  }

  // A refusal about the day or the price is shown beside that field. One about the investment itself (not revalued, not
  // found) has no control of its own here, since the select only offers what can take a price: it is said once, above
  // the button, as is a refusal that names no field. "Choose an investment" is the form's own, beside the select.
  const placed = new Set(["investment", "asOf", "price"])
  const errorsAt = (key: string) => outcome?.fieldErrors[key]
  const unplaced = outcome ? Object.entries(outcome.fieldErrors).filter(([key]) => !placed.has(key)) : []
  const alertText = outcome
    ? unplaced.length > 0
      ? unique(unplaced.flatMap(([, messages]) => messages)).join(" ")
      : Object.keys(outcome.fieldErrors).length === 0
        ? outcome.message
        : null
    : null
  // The day's refusal on saving replaces the preview's: the same words are never said twice.
  const dayProblem = errorsAt("asOf") ? null : (shown?.dayProblem ?? null)

  function send() {
    if (target === undefined) {
      setOutcome({ fieldErrors: { investment: ["Choose an investment"] }, message: null })
      return
    }
    // The button is disabled while a request is out, but a second submit can still arrive (Enter held down): a no-op.
    if (inFlight.current) return
    inFlight.current = true
    const sent = { nodeId: target.nodeId, asOf: date, price: price.trim() }
    startTransition(async () => {
      try {
        const result = await recordPriceAction(sent)
        if (!result.ok) {
          setOutcome({ fieldErrors: result.error.fieldErrors ?? {}, message: result.error.message })
          return
        }
        // It was accepted, so it parses: the price as the server read it, for the message.
        const parsed = priceSchema.parse(sent)
        const saved = priceText(serialisePaise(parsed.price), target.unit, target.lump)
        const replaced = known?.find((point) => point.asOf === parsed.asOf)
        const day = formatDay(parsed.asOf)
        setPrice("")
        setOutcome(null)
        onSaved([
          replaced
            ? `Saved ${saved} for ${day}: it replaced the price for that day (${priceText(replaced.pricePerUnitPaise, target.unit, target.lump)}).`
            : `Saved ${saved} for ${day}.`,
        ])
      } catch {
        setOutcome({ fieldErrors: {}, message: "Could not save the price just now. Check your connection and try again." })
      } finally {
        inFlight.current = false
      }
    })
  }

  const dayProblemId = `${formId}-day-problem`
  const figures = shown?.figures ? describeRevaluation(shown.figures) : null
  // No price can value it: said in words from the moment it is chosen, and whenever the server says the same.
  const cannotValue = target?.needsQuantity === true || (shown?.figures != null && figures === null)
  // A price older than the latest changes nothing today: the latest still values it, and the preview says which.
  const later = figures?.change?.amount === "no change" ? known?.find((point) => compareDates(point.asOf, date as CalendarDate) > 0) : undefined

  return (
    <form
      ref={formRef}
      aria-label="Record a price"
      noValidate
      onSubmit={(event) => {
        event.preventDefault()
        send()
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <Field
            idBase={`${formId}-investment`}
            label="Investment"
            errors={errorsAt("investment")}
            hint={target && !target.needsQuantity ? holdingHint(target) : undefined}
          >
            {(props) => (
              <select
                {...props}
                value={selected}
                onChange={(event) => change(() => choose(event.target.value))}
                className={inputClass}
              >
                <option value="">Choose an investment</option>
                {targets.map((candidate) => (
                  <option key={candidate.nodeId} value={candidate.nodeId}>
                    {candidate.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
        </div>

        <div>
          <Field idBase={`${formId}-date`} label="Date" errors={errorsAt("asOf")}>
            {(props) => (
              <input
                {...props}
                aria-describedby={[props["aria-describedby"], dayProblem ? dayProblemId : null].filter(Boolean).join(" ") || undefined}
                type="date"
                max={today}
                value={date}
                onChange={(event) => change(() => setDate(event.target.value))}
                className={`${inputClass} figures`}
              />
            )}
          </Field>
          <p id={dayProblemId} aria-live="polite" className="mt-1 text-sm font-medium text-negative empty:hidden">
            {dayProblem}
          </p>
        </div>

        <Field
          idBase={`${formId}-price`}
          label={priceLabel(target)}
          errors={errorsAt("price")}
          hint={target?.lump ? "What the whole of it is worth." : undefined}
        >
          {(props) => (
            <input
              {...props}
              type="text"
              inputMode="decimal"
              autoComplete="off"
              placeholder="0.00"
              value={price}
              onChange={(event) => change(() => setPrice(event.target.value))}
              className={`${inputClass} figures`}
            />
          )}
        </Field>
      </div>

      {/* What the price would make it worth today, from the server, for exactly what is typed now. */}
      <div aria-live="polite" className="mt-5 min-h-[3.25rem] rounded-2xl border border-dashed border-line px-4 py-3 text-sm">
        {cannotValue ? (
          <p className="text-fg-soft">
            Some purchases of this investment have no quantity, so a price cannot value it yet. Add the quantity to{" "}
            {/* Every month, not only this one: the purchases without a quantity are usually older. */}
            <Link href="/transactions?from=&to=" className={linkClass}>
              those transactions
            </Link>
            .
          </p>
        ) : figures ? (
          <>
            <p className="figures font-medium">
              {figures.lead}
              {figures.change && (
                <>
                  {" "}
                  <span className={cn("whitespace-nowrap", TONE_CLASS[figures.change.tone])}>({figures.change.amount})</span>
                </>
              )}
            </p>
            {later ? (
              <p className="mt-1 text-fg-soft">A later price, from {formatDay(later.asOf)}, values it today.</p>
            ) : target && target.quantityHeld === "0" ? (
              <p className="mt-1 text-fg-soft">Nothing of it is held now, so a price does not change its value.</p>
            ) : null}
          </>
        ) : shown?.unavailable ? (
          <p className="text-fg-soft">Could not check the value just now.</p>
        ) : shown ? (
          <p className="text-fg-soft">
            {shown.dayProblem ? "Choose a day up to today to see the value." : "No value to show for these fields."}
          </p>
        ) : ready ? (
          <p className="text-fg-soft">Checking the value…</p>
        ) : (
          <p className="text-fg-soft">
            {target ? "Enter a price to see what it does to the value today." : "Choose an investment, a day and a price."}
          </p>
        )}
      </div>

      {alertText && (
        <p role="alert" className="mt-4 flex items-start gap-2.5 rounded-xl bg-negative-wash px-3.5 py-2.5 text-sm font-medium text-negative">
          <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span>{alertText}</span>
        </p>
      )}

      <div className="mt-5">
        <button type="submit" disabled={pending} className={buttonClass()}>
          {pending && <LoaderCircle aria-hidden className="size-4 animate-spin" />}
          Save price
        </button>
      </div>
    </form>
  )
}

function holdingHint(target: PriceTarget): string {
  if (target.quantityHeld === "0") return "Nothing of it is held now."
  return target.lump ? "You hold the whole of it." : `You hold ${quantityText(target.quantityHeld, target.unit)}.`
}
