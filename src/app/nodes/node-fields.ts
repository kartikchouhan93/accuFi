import type { LedgerKind } from "@/domain/ledger-kind"
import {
  ASSET_SUBTYPES,
  createNodeFields,
  LIABILITY_SUBTYPES,
  LOT_METHODS,
  NODE_NAME_MAX_LENGTH,
  VALUATION_MODES,
} from "@/lib/schemas/node"

// Which fields the create form shows for each kind, and how each one is drawn. Which fields a kind HAS is read from the
// schema the server validates with (createNodeFields), not listed again here, so the form and the server cannot drift:
// a field added to the schema appears here as a compile error until it has a control, and a kind added to the schema
// appears in FIELDS_BY_KIND with no further change.

type Shapes = (typeof createNodeFields.options)[number]["shape"]
type KeysOf<S> = S extends unknown ? keyof S : never
/** Every field name any kind can have, except the discriminator, which the radios choose. */
export type FieldName = Exclude<KeysOf<Shapes>, "kind">

interface Choice {
  value: string
  label: string
}

interface Common {
  label: string
  /** A line under the control that helps, shown whether or not the field is optional. */
  hint?: string
  /** Only when this returns true (given the values typed so far). A field that is hidden is never sent. */
  showWhen?: (values: Readonly<Record<string, string>>) => boolean
}

export type Control = Common &
  (
    | { type: "text"; maxLength: number; placeholder?: string; inputMode?: "numeric" }
    | { type: "choice"; choices: Choice[]; emptyLabel?: string }
    | { type: "day" }
    | { type: "rupees"; placeholder?: string }
    // An on/off switch. Its value is "true" when ticked and empty otherwise, like every other value on the form.
    | { type: "checkbox" }
    // The signed one: an unsigned amount plus a direction, so the sign is a choice with words rather than a minus a
    // user might or might not type.
    | { type: "opening" }
    // A field the schema has but this screen does not offer (grouping nodes under a parent has no UI yet).
    | { type: "none" }
  )

const VALUATION_LABEL: Record<(typeof VALUATION_MODES)[number], string> = {
  QUANTITY: "By quantity and unit price",
  LUMP: "As one lump sum",
  CONTRIBUTION_ONLY: "By what you put in",
}
const LOT_LABEL: Record<(typeof LOT_METHODS)[number], string> = {
  FIFO: "First in, first out",
  LIFO: "Last in, first out",
  HIGHEST_COST_FIRST: "Highest cost first",
}
const ASSET_LABEL: Record<(typeof ASSET_SUBTYPES)[number], string> = {
  SAVINGS: "Savings",
  CURRENT: "Current",
  CASH: "Cash",
  WALLET: "Wallet",
}
const LIABILITY_LABEL: Record<(typeof LIABILITY_SUBTYPES)[number], string> = {
  CREDIT_CARD: "Credit card",
  LOAN: "Loan",
}
const choices = <T extends string>(values: readonly T[], labels: Record<T, string>): Choice[] =>
  values.map((value) => ({ value, label: labels[value] }))

export const CONTROLS: Record<FieldName, Control> = {
  name: { type: "text", label: "Name", maxLength: NODE_NAME_MAX_LENGTH },
  parentId: { type: "none", label: "Group" },
  assetSubtype: { type: "choice", label: "Account type", choices: choices(ASSET_SUBTYPES, ASSET_LABEL) },
  liabilitySubtype: { type: "choice", label: "Liability type", choices: choices(LIABILITY_SUBTYPES, LIABILITY_LABEL) },
  institution: { type: "text", label: "Institution", maxLength: 100, placeholder: "HDFC Bank" },
  lastFour: {
    type: "text",
    label: "Last four digits",
    maxLength: 4,
    inputMode: "numeric",
    hint: "Of the account or card number, to tell similar ones apart",
  },
  creditLimit: { type: "rupees", label: "Credit limit (₹)" },
  statementDay: { type: "day", label: "Statement day", hint: "Day of the month" },
  dueDay: { type: "day", label: "Due day", hint: "Day of the month" },
  openingBalance: { type: "opening", label: "Opening balance" },
  // Worded for what the guard does, which is to look at one day: see the header of transaction-service.ts, which says
  // the same thing in the same words (a test holds the two together).
  blockNegative: {
    type: "checkbox",
    label: "Block entries that would leave this account overdrawn as of today",
    hint: "Judged on the day of the entry, today or a later date, not across the past: a backdated spend that held it below zero earlier is still allowed.",
  },
  valuationMode: { type: "choice", label: "Valuation", choices: choices(VALUATION_MODES, VALUATION_LABEL) },
  unitLabel: { type: "text", label: "Unit", maxLength: 20, placeholder: "gram, unit, share", hint: "What one of it is called" },
  lotMethod: {
    type: "choice",
    label: "When you sell, use",
    choices: choices(LOT_METHODS, LOT_LABEL),
    emptyLabel: "First in, first out (default)",
    // Lots exist only when an investment is tracked by quantity.
    showWhen: (values) => values.valuationMode === "QUANTITY",
  },
}

export interface KindField {
  name: FieldName
  control: Control
  /** From the schema: an optional field is marked as such on screen, a required one is not. */
  optional: boolean
}

function fieldsOf(option: (typeof createNodeFields.options)[number]): KindField[] {
  const shape: Record<string, { isOptional(): boolean }> = option.shape
  return Object.keys(shape)
    .filter((name): name is FieldName => name !== "kind")
    .map((name) => ({ name, control: CONTROLS[name], optional: shape[name].isOptional() }))
    .filter((field) => field.control.type !== "none")
}

/** The fields of each kind, in the schema's order, which reads as a sensible form order. */
export const FIELDS_BY_KIND = Object.fromEntries(
  createNodeFields.options.map((option) => [option.shape.kind.value, fieldsOf(option)]),
) as Record<LedgerKind, KindField[]>

/**
 * What each field starts as. A required choice has no "none of these", so it starts on its first option; everything
 * else starts empty. One map for every field of every kind, so a name or institution typed under one kind is still
 * there after switching to another that has the same field.
 */
export const INITIAL_VALUES: Readonly<Record<string, string>> = Object.fromEntries(
  Object.values(FIELDS_BY_KIND)
    .flat()
    .map(({ name, control, optional }) => [name, control.type === "choice" && !optional ? (control.choices[0]?.value ?? "") : ""]),
)

/** The label of one option of a choice field, for showing what is stored ("SAVINGS" -> "Savings"). */
export function choiceLabel(field: FieldName, value: string | null): string | null {
  const control = CONTROLS[field]
  if (value === null || control.type !== "choice") return null
  return control.choices.find((choice) => choice.value === value)?.label ?? null
}

/** The opening balance's direction before the user touches it: a card is usually opened with a balance owed. */
export function defaultDirection(kind: LedgerKind): "positive" | "negative" {
  return kind === "LIABILITY" ? "negative" : "positive"
}
