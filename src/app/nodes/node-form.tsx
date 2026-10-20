"use client"

import { useRouter } from "next/navigation"
import { useEffect, useId, useRef, useState, useTransition } from "react"
import type { LedgerKind } from "@/domain/ledger-kind"
import { KIND_COPY, KIND_ORDER } from "@/lib/node-kinds"
import { describeOpening } from "@/lib/node-money"
import { createNodeAction } from "./actions"
import { defaultDirection, FIELDS_BY_KIND, INITIAL_VALUES, type KindField } from "./node-fields"
import { buildInput, isVisible, validateBeforeSending, type Direction, type FieldErrors } from "./node-form-input"
import { describeFailure, type FailureText } from "./node-failure"
import type { Notice } from "./node-workspace"

// The create form. The kind radios choose which fields exist; the fields of a kind come from the schema the server
// validates with (see node-fields.ts), so this file draws controls and never decides what a kind needs.


interface Props {
  kind: LedgerKind
  onKindChange: (kind: LedgerKind) => void
  announce: (notice: Notice) => void
}

// The last answer to a submit, remembered with the kind it was for so that switching kind does not leave another
// kind's complaints on screen.
interface Outcome {
  kind: LedgerKind
  fieldErrors: FieldErrors
  failure: FailureText
}

const inputClass =
  "w-full rounded-sm border border-line-strong bg-canvas px-3 py-2 text-fg placeholder:text-fg-soft/70 aria-[invalid=true]:border-negative aria-[invalid=true]:border-2"

export function NodeForm({ kind, onKindChange, announce }: Props) {
  const router = useRouter()
  const formId = useId()
  const formRef = useRef<HTMLFormElement>(null)
  const [values, setValues] = useState<Record<string, string>>({ ...INITIAL_VALUES })
  const [directions, setDirections] = useState<Partial<Record<LedgerKind, Direction>>>({})
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const [pending, startTransition] = useTransition()

  const fields = FIELDS_BY_KIND[kind].filter((field) => isVisible(field, values))
  const direction = directions[kind] ?? defaultDirection(kind)
  const shown = outcome?.kind === kind ? outcome : null
  const copy = KIND_COPY[kind]
  // Problems beside a field are shown there. What cannot be placed (a refusal about the whole request, or an issue
  // filed under a field this kind does not show) is said once, above the button.
  const unplaced = shown ? Object.entries(shown.fieldErrors).filter(([key]) => !fields.some((field) => field.name === key)) : []
  const alertText = !shown
    ? null
    : shown.failure.isFieldProblem
      ? unplaced.length > 0
        ? unplaced.flatMap(([, messages]) => messages).join(" ")
        : null
      : shown.failure.message

  // A refusal moves the keyboard to the first field that needs attention, so a screen-reader user hears what is wrong.
  useEffect(() => {
    if (outcome) formRef.current?.querySelector<HTMLElement>("[aria-invalid='true']")?.focus()
  }, [outcome])

  function setValue(name: string, value: string) {
    setValues((current) => ({ ...current, [name]: value }))
  }

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const problems = validateBeforeSending(kind, fields, values)
    if (Object.keys(problems).length > 0) {
      setOutcome({ kind, fieldErrors: problems, failure: { message: "Check the highlighted fields.", isFieldProblem: true } })
      return
    }
    startTransition(async () => {
      const result = await createNodeAction(buildInput(kind, fields, values, direction))
      if (!result.ok) {
        setOutcome({ kind, fieldErrors: result.error.fieldErrors ?? {}, failure: describeFailure(result) })
        return
      }
      const { node, duplicateName } = result.data
      setOutcome(null)
      setValues({ ...INITIAL_VALUES })
      announce({
        tone: duplicateName ? "warning" : "success",
        text: `Added ${node.name}.${duplicateName ? ` You already have ${copy.indefinite} called ${node.name}. Both are kept.` : ""}`,
      })
      router.refresh()
      formRef.current?.querySelector<HTMLElement>("[data-first-field]")?.focus()
    })
  }

  return (
    <form
      ref={formRef}
      onSubmit={submit}
      noValidate
      aria-labelledby={`${formId}-title`}
      className="border border-line border-t-4 border-t-ink bg-panel p-5"
    >
      <h2 id={`${formId}-title`} className="font-display text-xl font-semibold">
        Add to your ledger
      </h2>

      <fieldset className="mt-4" aria-describedby={`${formId}-kind-hint`}>
        <legend className="mb-2 text-sm font-medium">What are you adding?</legend>
        <div className="flex flex-wrap gap-2">
          {KIND_ORDER.map((option) => (
            <label key={option} className="relative">
              <input
                type="radio"
                name="kind"
                value={option}
                checked={kind === option}
                onChange={() => onKindChange(option)}
                className="peer absolute inset-0 size-full cursor-pointer opacity-0"
              />
              <span className="block cursor-pointer rounded-sm border border-line-strong px-3 py-1.5 text-sm peer-checked:border-fg peer-checked:bg-fg peer-checked:text-panel peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent">
                {KIND_COPY[option].singular}
              </span>
            </label>
          ))}
        </div>
        <p id={`${formId}-kind-hint`} className="mt-2 text-sm text-fg-soft">
          {copy.hint}
        </p>
      </fieldset>

      <div className="mt-5 space-y-4">
        {fields.map((field, index) => (
          <Field
            key={field.name}
            field={field}
            idBase={`${formId}-${field.name}`}
            kind={kind}
            value={values[field.name] ?? ""}
            onChange={(value) => setValue(field.name, value)}
            errors={shown?.fieldErrors[field.name]}
            isFirst={index === 0}
            direction={direction}
            onDirectionChange={(next) => setDirections((current) => ({ ...current, [kind]: next }))}
          />
        ))}
      </div>

      {alertText && (
        <p role="alert" className="mt-4 bg-negative-wash px-3 py-2 text-sm text-negative">
          {alertText}
        </p>
      )}

      <button
        type="submit"
        disabled={pending}
        className="mt-6 w-full rounded-sm bg-accent px-4 py-2.5 font-medium text-accent-fg disabled:opacity-60"
      >
        {copy.addLabel}
      </button>
    </form>
  )
}

interface FieldProps {
  field: KindField
  idBase: string
  kind: LedgerKind
  value: string
  onChange: (value: string) => void
  errors: string[] | undefined
  isFirst: boolean
  direction: Direction
  onDirectionChange: (direction: Direction) => void
}

function Field({ field, idBase, kind, value, onChange, errors, isFirst, direction, onDirectionChange }: FieldProps) {
  const { control } = field
  const hintId = `${idBase}-hint`
  const errorId = `${idBase}-error`
  const invalid = errors !== undefined && errors.length > 0
  const describedBy = [control.hint ? hintId : null, invalid ? errorId : null].filter(Boolean).join(" ") || undefined
  const marker = field.optional ? (
    <span className="text-xs text-fg-soft">optional</span>
  ) : null
  const messages = (
    <>
      {control.hint && (
        <p id={hintId} className="mt-1 text-xs text-fg-soft">
          {control.hint}
        </p>
      )}
      {invalid && (
        <p id={errorId} className="mt-1 text-sm font-medium text-negative">
          {errors.join(" ")}
        </p>
      )}
    </>
  )

  if (control.type === "opening") {
    // Only an account or a liability reaches here (the schema gives openingBalance to no other kind).
    const subject = kind === "LIABILITY" ? "LIABILITY" : "ASSET"
    const preview = describeOpening(subject, direction, value)
    const choices: { value: Direction; label: string; meaning: string }[] =
      subject === "ASSET"
        ? [
            { value: "positive", label: "In credit", meaning: "The account holds this much" },
            { value: "negative", label: "Overdrawn", meaning: "You owe the bank this much" },
          ]
        : [
            { value: "negative", label: "Owed", meaning: "You owe this much" },
            { value: "positive", label: "In credit", meaning: "The lender owes you this much" },
          ]
    return (
      <fieldset>
        <legend className="flex w-full items-baseline justify-between text-sm font-medium">
          {control.label}
          {marker}
        </legend>
        <div className="mt-2 grid grid-cols-2 gap-2">
          {choices.map((choice) => (
            <label
              key={choice.value}
              className="flex cursor-pointer items-start gap-2 rounded-sm border border-line-strong px-3 py-2 text-sm has-[:checked]:border-fg has-[:checked]:bg-canvas has-[:checked]:font-medium has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent"
            >
              <input
                type="radio"
                name={`${idBase}-direction`}
                value={choice.value}
                checked={direction === choice.value}
                onChange={() => onDirectionChange(choice.value)}
                aria-describedby={`${idBase}-${choice.value}-meaning`}
                className="mt-1 accent-pen"
              />
              <span>
                {choice.label}
                <span id={`${idBase}-${choice.value}-meaning`} className="block text-xs font-normal text-fg-soft">
                  {choice.meaning}
                </span>
              </span>
            </label>
          ))}
        </div>
        <div className="mt-3">
          <label htmlFor={idBase} className="text-sm">
            Amount (₹)
          </label>
          <input
            id={idBase}
            type="text"
            inputMode="decimal"
            autoComplete="off"
            placeholder="0.00"
            value={value}
            onChange={(event) => onChange(event.target.value)}
            aria-invalid={invalid || undefined}
            aria-describedby={[`${idBase}-preview`, invalid ? errorId : null].filter(Boolean).join(" ")}
            className={`${inputClass} figures mt-1`}
          />
          <p id={`${idBase}-preview`} className="mt-1 text-sm text-fg-soft">
            {preview ?? "Leave this empty to start at zero. You can change it later, it is an ordinary transaction."}
          </p>
          {invalid && (
            <p id={errorId} className="mt-1 text-sm font-medium text-negative">
              {errors.join(" ")}
            </p>
          )}
        </div>
      </fieldset>
    )
  }

  const common = {
    id: idBase,
    "aria-invalid": invalid || undefined,
    "aria-describedby": describedBy,
    ...(isFirst ? { "data-first-field": "" } : {}),
  }
  let input: React.ReactNode
  switch (control.type) {
    case "choice":
      input = (
        <select {...common} value={value} onChange={(event) => onChange(event.target.value)} className={inputClass}>
          {field.optional && <option value="">{control.emptyLabel ?? "Not set"}</option>}
          {control.choices.map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choice.label}
            </option>
          ))}
        </select>
      )
      break
    case "day":
      input = (
        <input
          {...common}
          type="text"
          inputMode="numeric"
          maxLength={2}
          autoComplete="off"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className={`${inputClass} figures`}
        />
      )
      break
    case "rupees":
      input = (
        <input
          {...common}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          placeholder="0.00"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className={`${inputClass} figures`}
        />
      )
      break
    case "text":
      input = (
        <input
          {...common}
          type="text"
          maxLength={control.maxLength}
          inputMode={control.inputMode}
          placeholder={control.placeholder}
          autoComplete="off"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className={inputClass}
        />
      )
      break
    case "checkbox":
      // Its own label wraps the box, so the words are the click target; no "optional" marker, an unticked box is no answer.
      return (
        <div>
          <label className="flex cursor-pointer items-start gap-2 text-sm font-medium">
            <input
              {...common}
              type="checkbox"
              checked={value === "true"}
              onChange={(event) => onChange(event.target.checked ? "true" : "")}
              className="mt-0.5 size-4 shrink-0 accent-pen"
            />
            <span>{control.label}</span>
          </label>
          {messages}
        </div>
      )
    case "none":
      return null
  }
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <label htmlFor={idBase} className="text-sm font-medium">
          {control.label}
        </label>
        {marker}
      </div>
      <div className="mt-1">{input}</div>
      {messages}
    </div>
  )
}
