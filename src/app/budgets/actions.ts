"use server"

import { budgetIdSchema, budgetSettingsSchema, createBudgetSchema, reviseBudgetSchema } from "@/lib/schemas/budget"
import type { BudgetSettingsView } from "@/lib/budget-view"
import { ok, parseInput, wrote, type ActionResult } from "@/server/action-support"
import { requireUserId } from "@/server/auth"
import { createBudget, deleteBudget, reviseBudget, updateBudgetSettings } from "@/server/services/budget-service"
import { toBudgetFailure } from "./budget-failure"

// Server Actions for budgets, shaped like the recurring actions: each asks requireUserId() who is calling before it reads
// its input, parses the input (`unknown`: an action is a public endpoint) with Zod, then calls the service. Results are
// plain data, views with paise as text and months as "YYYY-MM-01", never a bigint or a Date. Expected refusals come back
// as `{ ok: false }` (see budget-failure.ts); an unexpected error is rethrown, and a missing session redirects to /login.
// Every write ends with `wrote()`, which also renews /budgets.

export async function createBudgetAction(input: unknown): Promise<ActionResult<BudgetSettingsView>> {
  try {
    const userId = await requireUserId()
    const parsed = parseInput(createBudgetSchema, input)
    if ("ok" in parsed) return parsed
    const view = await createBudget(userId, parsed.data)
    wrote()
    return ok(view)
  } catch (error) {
    return toBudgetFailure(error)
  }
}

/** One view when the amount is corrected in place, two (the shortened budget, then the new one) when it splits. */
export async function reviseBudgetAction(input: unknown): Promise<ActionResult<BudgetSettingsView[]>> {
  try {
    const userId = await requireUserId()
    const parsed = parseInput(reviseBudgetSchema, input)
    if ("ok" in parsed) return parsed
    const { id, ...revision } = parsed.data
    const views = await reviseBudget(userId, id, revision)
    wrote()
    return ok(views)
  } catch (error) {
    return toBudgetFailure(error)
  }
}

export async function updateBudgetSettingsAction(input: unknown): Promise<ActionResult<BudgetSettingsView>> {
  try {
    const userId = await requireUserId()
    const parsed = parseInput(budgetSettingsSchema, input)
    if ("ok" in parsed) return parsed
    const { id, ...settings } = parsed.data
    const view = await updateBudgetSettings(userId, id, settings)
    wrote()
    return ok(view)
  } catch (error) {
    return toBudgetFailure(error)
  }
}

export async function deleteBudgetAction(input: unknown): Promise<ActionResult<null>> {
  try {
    const userId = await requireUserId()
    const parsed = parseInput(budgetIdSchema, input)
    if ("ok" in parsed) return parsed
    await deleteBudget(userId, parsed.data.id)
    wrote()
    return ok(null)
  } catch (error) {
    return toBudgetFailure(error)
  }
}
