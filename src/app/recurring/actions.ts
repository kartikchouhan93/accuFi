"use server"

import {
  createRuleSchema,
  editRuleSchema,
  postOccurrenceSchema,
  ruleIdSchema,
} from "@/lib/schemas/recurring"
import type { OccurrenceView, RuleView } from "@/lib/recurring-view"
import { ok, parseInput, wrote, type ActionResult } from "@/server/action-support"
import { requireUserId } from "@/server/auth"
import { dismissOccurrence, postOccurrence, restoreOccurrence } from "@/server/services/occurrence-service"
import { createRule, deleteRule, editRule, setPaused } from "@/server/services/recurring-service"
import { toRecurringFailure } from "./recurring-failure"

// Server Actions for recurring rules and their entries, shaped like the transaction actions: each asks requireUserId()
// who is calling before it reads its input, parses the input (`unknown`: an action is a public endpoint) with Zod, then
// calls the service. Results are plain data, views with paise as text and days as "YYYY-MM-DD", never a bigint or a
// Date. Expected refusals come back as `{ ok: false }` (see recurring-failure.ts); an unexpected error is rethrown, and a
// missing session redirects to /login. Every write ends with `wrote()`, since a post moves money and a rule moves the
// badge and the inbox.

export async function createRuleAction(input: unknown): Promise<ActionResult<RuleView>> {
  try {
    const userId = await requireUserId()
    const parsed = parseInput(createRuleSchema, input)
    if ("ok" in parsed) return parsed
    const view = await createRule(userId, parsed.data)
    wrote()
    return ok(view)
  } catch (error) {
    return toRecurringFailure(error)
  }
}

export async function editRuleAction(input: unknown): Promise<ActionResult<RuleView>> {
  try {
    const userId = await requireUserId()
    const parsed = parseInput(editRuleSchema, input)
    if ("ok" in parsed) return parsed
    const { id, expectedVersion, rule } = parsed.data
    const view = await editRule(userId, id, expectedVersion, rule)
    wrote()
    return ok(view)
  } catch (error) {
    return toRecurringFailure(error)
  }
}

export async function pauseRuleAction(input: unknown): Promise<ActionResult<RuleView>> {
  return setPausedAction(input, true)
}

export async function resumeRuleAction(input: unknown): Promise<ActionResult<RuleView>> {
  return setPausedAction(input, false)
}

async function setPausedAction(input: unknown, paused: boolean): Promise<ActionResult<RuleView>> {
  try {
    const userId = await requireUserId()
    const parsed = parseInput(ruleIdSchema, input)
    if ("ok" in parsed) return parsed
    const view = await setPaused(userId, parsed.data.id, paused)
    wrote()
    return ok(view)
  } catch (error) {
    return toRecurringFailure(error)
  }
}

/** Soft: the rule and its pending entries go, what was posted or skipped stays as history. */
export async function deleteRuleAction(input: unknown): Promise<ActionResult<null>> {
  try {
    const userId = await requireUserId()
    const parsed = parseInput(ruleIdSchema, input)
    if ("ok" in parsed) return parsed
    await deleteRule(userId, parsed.data.id)
    wrote()
    return ok(null)
  } catch (error) {
    return toRecurringFailure(error)
  }
}

/**
 * Post an entry as proposed (the id alone) or with what the user changed. Exactly once: posting an entry that is already
 * posted answers with it again, so a double click or a second tab is not an error.
 */
export async function postOccurrenceAction(input: unknown): Promise<ActionResult<OccurrenceView>> {
  try {
    const userId = await requireUserId()
    const parsed = parseInput(postOccurrenceSchema, input)
    if ("ok" in parsed) return parsed
    const { id, ...overrides } = parsed.data
    const view = await postOccurrence(userId, id, overrides)
    wrote()
    return ok(view)
  } catch (error) {
    return toRecurringFailure(error)
  }
}

export async function dismissOccurrenceAction(input: unknown): Promise<ActionResult<OccurrenceView>> {
  try {
    const userId = await requireUserId()
    const parsed = parseInput(ruleIdSchema, input)
    if ("ok" in parsed) return parsed
    const view = await dismissOccurrence(userId, parsed.data.id)
    wrote()
    return ok(view)
  } catch (error) {
    return toRecurringFailure(error)
  }
}

export async function restoreOccurrenceAction(input: unknown): Promise<ActionResult<OccurrenceView>> {
  try {
    const userId = await requireUserId()
    const parsed = parseInput(ruleIdSchema, input)
    if ("ok" in parsed) return parsed
    const view = await restoreOccurrence(userId, parsed.data.id)
    wrote()
    return ok(view)
  } catch (error) {
    return toRecurringFailure(error)
  }
}
