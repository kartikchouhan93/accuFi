import type { LedgerKind } from "@/domain/ledger-kind"
import type { KindField } from "./node-fields"

// What the create form checks before it asks the server, and what it sends. Kept out of the component so it can be
// tested without a browser.

export type Direction = "positive" | "negative"
export type FieldErrors = Record<string, string[]>

export const isVisible = (field: KindField, values: Readonly<Record<string, string>>) =>
  field.control.showWhen === undefined || field.control.showWhen(values)

const AMOUNT_SIGN_PATTERN = /^\s*[-+]/

export function validateBeforeSending(
  kind: LedgerKind,
  fields: KindField[],
  values: Record<string, string>,
): FieldErrors {
  const errors: FieldErrors = {}
  for (const field of fields) {
    const text = (values[field.name] ?? "").trim()
    if (field.control.type === "day" && text !== "") {
      const day = Number(text)
      if (!/^\d{1,2}$/.test(text) || day < 1 || day > 31) errors[field.name] = ["Enter a day between 1 and 31"]
    }
    if (field.control.type === "count" && text !== "") {
      const { min, max, unit } = field.control
      const count = Number(text) // digits only, at most 9 of them, so the Number is exact
      if (!/^\d{1,9}$/.test(text) || count < min || count > max) errors[field.name] = [`Enter a whole number of ${unit} from ${min} to ${max}`]
    }
    if (field.control.type === "opening" && AMOUNT_SIGN_PATTERN.test(text)) {
      const choices = kind === "LIABILITY" ? "Owed or In credit" : "In credit or Overdrawn"
      errors[field.name] = [`Enter the amount without a sign. Choose ${choices} above.`]
    }
  }
  return errors
}

/** What is sent: only the fields on screen, the unsigned amount joined to the chosen direction, and no empty optionals. */
export function buildInput(kind: LedgerKind, fields: KindField[], values: Record<string, string>, direction: Direction) {
  const input: Record<string, unknown> = { kind }
  for (const field of fields.filter((candidate) => isVisible(candidate, values))) {
    const text = (values[field.name] ?? "").trim()
    if (field.name === "name") input.name = text // required: an empty one is refused by the server with its own message
    else if (text === "") continue
    else if (field.control.type === "day" || field.control.type === "count") input[field.name] = Number(text)
    else if (field.control.type === "checkbox") input[field.name] = true // unticked is `""`, skipped above
    else if (field.control.type === "opening") input[field.name] = direction === "negative" ? `-${text}` : text
    else input[field.name] = text
  }
  return input
}

