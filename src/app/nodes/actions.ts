"use server"

import type { z } from "zod"
import { serialisePaise } from "@/lib/serialise"
import { toNodeView, type NodeView } from "@/lib/node-view"
import { createNodeSchema, nodeIdSchema, renameNodeSchema } from "@/lib/schemas/node"
import { failed, fieldErrorsOf, ok, redirectIfUnauthenticated, wrote, type ActionFailure, type ActionResult } from "@/server/action-support"
import { requireUserId } from "@/server/auth"
import { NotFoundError } from "@/server/repositories/errors"
import {
  archiveLedgerNode,
  archiveResidual,
  createLedgerNode,
  findDuplicateNodes,
  HierarchyDepthError,
  InvalidNodeError,
  NodeHasHistoryError,
  NodeKindChangeError,
  removeLedgerNode,
  renameLedgerNode,
  restoreLedgerNode,
  SystemNodeError,
} from "@/server/services/node-service"

// Server Actions for the node lifecycle. Each one asks requireUserId() who is calling before it reads its input, then
// parses the input with Zod, then calls the service. The input is `unknown` because a Server Action is a public
// endpoint: the TypeScript signature promises nothing about what a client posts. Results are plain data (money as
// paise strings, dates as ISO strings) because they are serialised to the browser and a bigint would throw there.
//
// Expected refusals come back as `{ ok: false }` so a form can show them; an unexpected error is rethrown for Next to
// log (and mask in production). A missing session redirects to /login.
//
// Every write that succeeds ends with `wrote()` (action-support.ts), as the transaction actions do: a node write moves
// figures on other screens (an opening balance is a transaction), and router.refresh() renews only the current page.

type Failure = ActionFailure

// `userId` is deliberately not accepted anywhere in the input: the schemas are strict, so a forged one is rejected.
function parseInput<S extends z.ZodType>(schema: S, input: unknown): { data: z.output<S> } | Failure {
  const parsed = schema.safeParse(input)
  if (parsed.success) return { data: parsed.data }
  return failed("invalid_input", "Check the highlighted fields", fieldErrorsOf(parsed.error))
}

function toFailure(error: unknown): Failure {
  redirectIfUnauthenticated(error) // throws a redirect, so nothing below runs for a lapsed session
  if (error instanceof SystemNodeError) return failed("system_node", error.message)
  if (error instanceof NodeHasHistoryError) return failed("has_history", error.message)
  if (error instanceof HierarchyDepthError) return failed("hierarchy_depth", error.message)
  if (error instanceof NodeKindChangeError) return failed("kind_immutable", error.message)
  if (error instanceof InvalidNodeError) return failed("invalid", error.message)
  if (error instanceof NotFoundError) return failed("not_found", "That node was not found")
  throw error
}

export async function createNodeAction(
  input: unknown,
): Promise<ActionResult<{ node: NodeView; duplicateName: boolean }>> {
  try {
    const userId = await requireUserId()
    const parsed = parseInput(createNodeSchema, input)
    if ("ok" in parsed) return parsed
    // Looked up before the create so the new node cannot match itself. A duplicate is a warning, never a refusal (EC-35).
    const duplicates = await findDuplicateNodes(userId, parsed.data.kind, parsed.data.name)
    const node = await createLedgerNode(userId, parsed.data)
    wrote()
    return ok({ node: toNodeView(node), duplicateName: duplicates.length > 0 })
  } catch (error) {
    return toFailure(error)
  }
}

export async function renameNodeAction(
  input: unknown,
): Promise<ActionResult<{ node: NodeView; duplicateName: boolean }>> {
  try {
    const userId = await requireUserId()
    const parsed = parseInput(renameNodeSchema, input)
    if ("ok" in parsed) return parsed
    const node = await renameLedgerNode(userId, parsed.data.nodeId, parsed.data.name)
    wrote()
    const duplicates = await findDuplicateNodes(userId, node.kind, node.name, node.id)
    return ok({ node: toNodeView(node), duplicateName: duplicates.length > 0 })
  } catch (error) {
    return toFailure(error)
  }
}

export async function archiveNodeAction(
  input: unknown,
): Promise<ActionResult<{ node: NodeView; residualBalance: string }>> {
  try {
    const userId = await requireUserId()
    const parsed = parseInput(nodeIdSchema, input)
    if ("ok" in parsed) return parsed
    const { node, residualBalance } = await archiveLedgerNode(userId, parsed.data.nodeId)
    wrote()
    return ok({ node: toNodeView(node), residualBalance: serialisePaise(residualBalance) })
  } catch (error) {
    return toFailure(error)
  }
}

/**
 * What archiving this node would leave in it, as of today, from the server: the figure the confirm step shows, so it is
 * the one archiving then reports and not whatever the page was holding when it loaded. Writes nothing.
 */
export async function archiveResidualAction(input: unknown): Promise<ActionResult<{ residualBalance: string }>> {
  try {
    const userId = await requireUserId()
    const parsed = parseInput(nodeIdSchema, input)
    if ("ok" in parsed) return parsed
    return ok({ residualBalance: serialisePaise(await archiveResidual(userId, parsed.data.nodeId)) })
  } catch (error) {
    return toFailure(error)
  }
}

export async function restoreNodeAction(input: unknown): Promise<ActionResult<{ node: NodeView }>> {
  try {
    const userId = await requireUserId()
    const parsed = parseInput(nodeIdSchema, input)
    if ("ok" in parsed) return parsed
    const node = await restoreLedgerNode(userId, parsed.data.nodeId)
    wrote()
    return ok({ node: toNodeView(node) })
  } catch (error) {
    return toFailure(error)
  }
}

export async function removeNodeAction(input: unknown): Promise<ActionResult<null>> {
  try {
    const userId = await requireUserId()
    const parsed = parseInput(nodeIdSchema, input)
    if ("ok" in parsed) return parsed
    await removeLedgerNode(userId, parsed.data.nodeId)
    wrote()
    return ok(null)
  } catch (error) {
    return toFailure(error)
  }
}
