import { z } from "zod"
import { MoneyParseError, parseRupees } from "../../domain/money"

// What a client may send to create or rename a node. Two things the service cannot know are decided here: which
// fields each kind requires (a discriminated union on `kind`), and how rupee text becomes paise.
//
// Every object is strict. A key that does not belong (`userId`, `systemRole`, `archivedAt`, another kind's field)
// is an error, not silently dropped: the form a user filled in and the row that is written must agree. This file has
// no server imports so a client form can reuse it. Relative (not "@/") imports for the same reason as serialise.ts:
// Vitest does not resolve the tsconfig alias for value imports in src/lib.

// Same members as the Prisma enums of the same names; listed here so a client bundle never imports @prisma/client.
export const ASSET_SUBTYPES = ["SAVINGS", "CURRENT", "CASH", "WALLET"] as const
export const LIABILITY_SUBTYPES = ["CREDIT_CARD", "LOAN"] as const
export const VALUATION_MODES = ["QUANTITY", "LUMP", "CONTRIBUTION_ONLY"] as const
export const LOT_METHODS = ["FIFO", "LIFO", "HIGHEST_COST_FIRST"] as const

export const NODE_NAME_MAX_LENGTH = 100

const name = z.string().trim().min(1, "Enter a name").max(NODE_NAME_MAX_LENGTH, `At most ${NODE_NAME_MAX_LENGTH} characters`)
const nodeId = z.string().min(1)
const institution = z.string().trim().min(1).max(100)
const lastFour = z.string().regex(/^\d{4}$/, "Enter the last four digits")
const dayOfMonth = z.number().int().min(1).max(31)

// Rupee text ("1,23,456.78") to paise, as a validation issue rather than a thrown MoneyParseError. Money never
// arrives as a number: a float cannot hold paise exactly (EC-1).
const rupees = z.string().transform((text, ctx) => {
  try {
    return parseRupees(text)
  } catch (error) {
    if (!(error instanceof MoneyParseError)) throw error
    ctx.addIssue({ code: "custom", message: "Enter an amount in rupees, with at most two decimal places" })
    return z.NEVER
  }
})
const positiveRupees = rupees.refine((paise) => paise > 0n, "The amount must be greater than zero")
// An opening position is signed: positive for money you hold, negative for money you owe or an overdrawn balance
// (spec "Opening position"). Zero is not a position, so it is refused rather than posting a pointless transaction.
const signedRupees = rupees.refine((paise) => paise !== 0n, "Enter an amount other than zero")

const ledgerFields = { name, parentId: nodeId.optional() }

const incomeSource = z.strictObject({ kind: z.literal("INCOME_SOURCE"), ...ledgerFields })
const expense = z.strictObject({ kind: z.literal("EXPENSE"), ...ledgerFields })

const asset = z.strictObject({
  kind: z.literal("ASSET"),
  name,
  assetSubtype: z.enum(ASSET_SUBTYPES),
  institution: institution.optional(),
  lastFour: lastFour.optional(),
  openingBalance: signedRupees.optional(),
})

const liability = z.strictObject({
  kind: z.literal("LIABILITY"),
  name,
  liabilitySubtype: z.enum(LIABILITY_SUBTYPES),
  institution: institution.optional(),
  lastFour: lastFour.optional(),
  creditLimit: positiveRupees.optional(),
  statementDay: dayOfMonth.optional(),
  dueDay: dayOfMonth.optional(),
  openingBalance: signedRupees.optional(),
})

const investment = z.strictObject({
  kind: z.literal("INVESTMENT"),
  name,
  valuationMode: z.enum(VALUATION_MODES),
  unitLabel: z.string().trim().min(1, "Enter a unit, for example gram").max(20),
  lotMethod: z.enum(LOT_METHODS).optional(),
  institution: institution.optional(),
})

export const createNodeSchema = z
  .discriminatedUnion("kind", [incomeSource, expense, asset, liability, investment])
  // The form says "credit limit" in rupees; the column and the service say paise. Rename at the boundary.
  .transform((input) => {
    if (input.kind !== "LIABILITY") return input
    const { creditLimit, ...rest } = input
    return creditLimit === undefined ? rest : { ...rest, creditLimitPaise: creditLimit }
  })

/** What the service takes: money already in paise. */
export type CreateNodeInput = z.output<typeof createNodeSchema>

export const renameNodeSchema = z.strictObject({ nodeId, name })
export const nodeIdSchema = z.strictObject({ nodeId })
