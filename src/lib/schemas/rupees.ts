import { z } from "zod"
import { MoneyParseError, parseRupees } from "../../domain/money"

// How money text becomes paise in a schema. Shared by every schema that takes an amount. Relative (not "@/") imports
// for the same reason as node.ts: Vitest does not resolve the tsconfig alias for value imports in src/lib.

// Rupee text ("1,23,456.78") to paise, as a validation issue rather than a thrown MoneyParseError. Money never
// arrives as a number: a float cannot hold paise exactly (EC-1).
export const rupees = z.string().transform((text, ctx) => {
  try {
    return parseRupees(text)
  } catch (error) {
    if (!(error instanceof MoneyParseError)) throw error
    ctx.addIssue({ code: "custom", message: "Enter an amount in rupees, with at most two decimal places" })
    return z.NEVER
  }
})
export const positiveRupees = rupees.refine((paise) => paise > 0n, "The amount must be greater than zero")
