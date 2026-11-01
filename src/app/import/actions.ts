"use server"

import type { ReviewRowView } from "@/lib/import-view"
import { batchIdSchema, rowIdSchema, saveProfileSchema, stageBatchSchema, updateRowSchema } from "@/lib/schemas/import"
import { ok, parseInput, wrote, type ActionResult } from "@/server/action-support"
import { requireUserId } from "@/server/auth"
import {
  applyCounterpartToSimilar,
  backToMapping,
  commitBatch,
  confirmSuggestions,
  discardBatch,
  reverseBatch,
  saveProfile,
  stageBatch,
  updateRow,
  type CommitSummary,
} from "@/server/services/import-service"
import { toImportFailure } from "./import-failure"

// Server Actions for the import screens, shaped like the budgets actions: each asks requireUserId() who is calling
// before it reads its input, parses the input (`unknown`: an action is a public endpoint) with Zod, then calls the
// service. Results are plain data (paise as text, dates as the view types already establish, never a bigint or a
// Date). Expected refusals come back as `{ ok: false }` (see import-failure.ts); an unexpected error is rethrown, and
// a missing session redirects to /login. Every write ends with `wrote()`, which also renews /import. The upload
// itself is not here: a route handler carries the file (src/app/api/import/upload/route.ts).

export async function stageBatchAction(
  input: unknown,
): Promise<ActionResult<{ rows: number; errored: number; duplicates: number; linked: number; suggested: number }>> {
  try {
    const userId = await requireUserId()
    const parsed = parseInput(stageBatchSchema, input)
    if ("ok" in parsed) return parsed
    const { id, mapping, confirmedRepeat } = parsed.data
    const result = await stageBatch(userId, id, mapping, { confirmedRepeat })
    wrote()
    return ok(result)
  } catch (error) {
    return toImportFailure(error)
  }
}

export async function saveProfileAction(input: unknown): Promise<ActionResult<{ id: string; name: string }>> {
  try {
    const userId = await requireUserId()
    const parsed = parseInput(saveProfileSchema, input)
    if ("ok" in parsed) return parsed
    const profile = await saveProfile(userId, parsed.data)
    wrote()
    return ok(profile)
  } catch (error) {
    return toImportFailure(error)
  }
}

export async function discardBatchAction(input: unknown): Promise<ActionResult<null>> {
  try {
    const userId = await requireUserId()
    const parsed = parseInput(batchIdSchema, input)
    if ("ok" in parsed) return parsed
    await discardBatch(userId, parsed.data.id)
    wrote()
    return ok(null)
  } catch (error) {
    return toImportFailure(error)
  }
}

export async function backToMappingAction(input: unknown): Promise<ActionResult<null>> {
  try {
    const userId = await requireUserId()
    const parsed = parseInput(batchIdSchema, input)
    if ("ok" in parsed) return parsed
    await backToMapping(userId, parsed.data.id)
    wrote()
    return ok(null)
  } catch (error) {
    return toImportFailure(error)
  }
}

export async function updateRowAction(input: unknown): Promise<ActionResult<ReviewRowView>> {
  try {
    const userId = await requireUserId()
    const parsed = parseInput(updateRowSchema, input)
    if ("ok" in parsed) return parsed
    const view = await updateRow(userId, parsed.data.rowId, parsed.data.change)
    wrote()
    return ok(view)
  } catch (error) {
    return toImportFailure(error)
  }
}

export async function applyToSimilarAction(input: unknown): Promise<ActionResult<number>> {
  try {
    const userId = await requireUserId()
    const parsed = parseInput(rowIdSchema, input)
    if ("ok" in parsed) return parsed
    const count = await applyCounterpartToSimilar(userId, parsed.data.rowId)
    wrote()
    return ok(count)
  } catch (error) {
    return toImportFailure(error)
  }
}

export async function confirmSuggestionsAction(input: unknown): Promise<ActionResult<number>> {
  try {
    const userId = await requireUserId()
    const parsed = parseInput(batchIdSchema, input)
    if ("ok" in parsed) return parsed
    const count = await confirmSuggestions(userId, parsed.data.id)
    wrote()
    return ok(count)
  } catch (error) {
    return toImportFailure(error)
  }
}

export async function commitBatchAction(input: unknown): Promise<ActionResult<CommitSummary>> {
  try {
    const userId = await requireUserId()
    const parsed = parseInput(batchIdSchema, input)
    if ("ok" in parsed) return parsed
    const summary = await commitBatch(userId, parsed.data.id)
    wrote()
    return ok(summary)
  } catch (error) {
    return toImportFailure(error)
  }
}

export async function reverseBatchAction(input: unknown): Promise<ActionResult<{ reversed: number; reopened: number }>> {
  try {
    const userId = await requireUserId()
    const parsed = parseInput(batchIdSchema, input)
    if ("ok" in parsed) return parsed
    const result = await reverseBatch(userId, parsed.data.id)
    wrote()
    return ok(result)
  } catch (error) {
    return toImportFailure(error)
  }
}
