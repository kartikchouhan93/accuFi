import type { LedgerNode } from "@prisma/client"
import { todayIn, type CalendarDate } from "@/domain/calendar-date"
import type { LedgerKind } from "@/domain/ledger-kind"
import type { Paise } from "@/domain/money"
import { validateTransaction } from "@/domain/transaction-rules"
import type { CreateNodeInput } from "@/lib/schemas/node"
import { NotFoundError } from "@/server/repositories/errors"
import {
  countTransactionsForNode,
  createNode,
  deleteNode,
  findNodeById,
  findNodes,
  updateNode,
} from "@/server/repositories/node-repository"
import { insertTransactions, sumBalances } from "@/server/repositories/transaction-repository"
import { findUserTimezone } from "@/server/repositories/user-repository"

// The node lifecycle. The database has no CHECK constraints, so everything it cannot enforce is enforced here: a
// system node is never renamed, archived or deleted; a node that transactions reference is never deleted; the
// hierarchy is one level deep; an opening balance is positive and goes only to a node that holds a balance. A node's
// kind is fixed at creation (EC-34): no function below changes it, and the repository's allow-list would not write it.

export type { CreateNodeInput }

export class SystemNodeError extends Error {
  constructor(message = "This is a system node and cannot be renamed, archived or deleted") {
    super(message)
    this.name = "SystemNodeError"
  }
}

export class NodeHasHistoryError extends Error {
  constructor() {
    super("This node has transactions, so it cannot be deleted. Archive it instead.")
    this.name = "NodeHasHistoryError"
  }
}

export class HierarchyDepthError extends Error {
  constructor() {
    super("Nodes can be grouped one level deep: a node inside a group cannot itself contain others")
    this.name = "HierarchyDepthError"
  }
}

/** The request is well-formed but not allowed. The message is safe to show to the user. */
export class InvalidNodeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "InvalidNodeError"
  }
}

// Only these hold a balance a user can state up front. INCOME_SOURCE -> EXPENSE is a legal flow, so the flow rules
// alone would let an opening balance land on an expense category.
const OPENING_BALANCE_KINDS: ReadonlySet<LedgerKind> = new Set(["ASSET", "LIABILITY"])
// The kinds that can be grouped under a parent of their own kind (spec §8.1).
const GROUPED_KINDS: ReadonlySet<LedgerKind> = new Set(["INCOME_SOURCE", "EXPENSE"])

function cleanName(name: string): string {
  const trimmed = name.trim()
  if (trimmed === "") throw new InvalidNodeError("Enter a name")
  return trimmed
}

async function requireNode(userId: string, nodeId: string): Promise<LedgerNode> {
  const node = await findNodeById(userId, nodeId)
  if (!node) throw new NotFoundError("node")
  return node
}

async function requireMutableNode(userId: string, nodeId: string): Promise<LedgerNode> {
  const node = await requireNode(userId, nodeId)
  if (node.systemRole !== null) throw new SystemNodeError()
  return node
}

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

/** Live nodes only: what a transaction form offers for a new entry (EC-14). */
export function listNodesForPicker(userId: string, kinds?: LedgerKind[]): Promise<LedgerNode[]> {
  return findNodes(userId, { kinds })
}

/** Archived nodes included: historical transactions still reference them. */
export function listAllNodes(userId: string, kinds?: LedgerKind[]): Promise<LedgerNode[]> {
  return findNodes(userId, { kinds, includeArchived: true })
}

/**
 * Live nodes of the same kind that already carry this name, ignoring case and surrounding space. Names are not
 * identifiers (EC-35), so this only feeds a warning; nothing refuses a duplicate. `exceptNodeId` leaves out the node
 * being renamed.
 */
export async function findDuplicateNodes(
  userId: string,
  kind: LedgerKind,
  name: string,
  exceptNodeId?: string,
): Promise<LedgerNode[]> {
  const nodes = await findNodes(userId, { kinds: [kind] })
  return nodes.filter((node) => node.id !== exceptNodeId && sameName(node.name, name))
}

async function validateParent(userId: string, input: CreateNodeInput): Promise<void> {
  if (!("parentId" in input) || input.parentId === undefined) return
  if (!GROUPED_KINDS.has(input.kind)) throw new InvalidNodeError("Only income and expense nodes can be grouped")
  const parent = await requireNode(userId, input.parentId) // someone else's node is simply "not found"
  if (parent.parentId !== null) throw new HierarchyDepthError()
  if (parent.kind !== input.kind) throw new InvalidNodeError("A node can only be grouped under a node of the same kind")
}

/** The opening balance's source node, after checking the movement is one the transaction rules allow. */
async function openingBalanceSource(
  userId: string,
  kind: LedgerKind,
  amount: Paise,
  occurredAt: CalendarDate,
): Promise<LedgerNode> {
  if (!OPENING_BALANCE_KINDS.has(kind)) {
    throw new InvalidNodeError("An opening balance can only be set on an asset or a liability")
  }
  const source = (await findNodes(userId, { kinds: ["INCOME_SOURCE"] })).find((n) => n.systemRole === "OPENING_BALANCE")
  if (!source) throw new SystemNodeError("This account has no Opening Balance node")
  // The new node does not exist yet, so it is described by what the rules read: its kind. Checking before the write
  // means a refused opening balance leaves nothing behind.
  const violations = validateTransaction({
    fromNode: source,
    toNode: { id: "(new node)", kind, archivedAt: null, systemRole: null },
    amount,
    occurredAt,
  })
  if (violations.length > 0) throw new InvalidNodeError(violations.map((v) => v.message).join(" "))
  return source
}

/**
 * Create a node. With `openingBalance` (ASSET and LIABILITY only), also post a transaction for it from the user's
 * Opening Balance system node, dated today in the user's timezone (EC-36). That is an ordinary, editable
 * transaction, not a column: there is no stored balance anywhere.
 *
 * The node and its opening transaction are two repository calls, not one database transaction (the repositories each
 * own their transaction). If the second fails, the node is deleted again, so a failed create does not leave a node the
 * user never saw confirmed; if that cleanup fails too, the original error is still the one thrown.
 */
export async function createLedgerNode(userId: string, input: CreateNodeInput): Promise<LedgerNode> {
  const name = cleanName(input.name)
  await validateParent(userId, input)

  const openingBalance = "openingBalance" in input ? input.openingBalance : undefined
  let opening: { source: LedgerNode; amount: Paise; occurredAt: CalendarDate } | null = null
  if (openingBalance !== undefined) {
    const timezone = await findUserTimezone(userId)
    if (timezone === null) throw new NotFoundError("user")
    const occurredAt = todayIn(timezone)
    opening = { source: await openingBalanceSource(userId, input.kind, openingBalance, occurredAt), amount: openingBalance, occurredAt }
  }

  // `input` also carries `openingBalance`, which is not a column; the repository copies only the fields it allows.
  const node = await createNode(userId, { ...input, name })
  if (opening) {
    try {
      await insertTransactions(userId, [
        {
          fromNodeId: opening.source.id,
          toNodeId: node.id,
          amountPaise: opening.amount,
          occurredAt: opening.occurredAt,
          note: "Opening balance",
        },
      ])
    } catch (error) {
      await deleteNode(userId, node.id).catch(() => undefined)
      throw error
    }
  }
  return node
}

export async function renameLedgerNode(userId: string, nodeId: string, name: string): Promise<LedgerNode> {
  const clean = cleanName(name)
  await requireMutableNode(userId, nodeId)
  return updateNode(userId, nodeId, { name: clean })
}

/**
 * Archive a node and report what it still holds. Archiving is allowed whatever the balance (EC-32): the residue stays
 * in history and in net worth, and it is the caller's job to warn the user. The balance is read before the write
 * because balances are summed over live nodes only, so an archived node would no longer appear.
 */
export async function archiveLedgerNode(
  userId: string,
  nodeId: string,
): Promise<{ node: LedgerNode; residualBalance: Paise }> {
  const current = await requireMutableNode(userId, nodeId)
  if (current.archivedAt !== null) throw new InvalidNodeError("This node is already archived")
  const row = (await sumBalances(userId)).find((b) => b.nodeId === nodeId)
  if (!row) throw new NotFoundError("node") // archived by someone else between the two reads
  const node = await updateNode(userId, nodeId, { archivedAt: new Date() })
  return { node, residualBalance: row.balance }
}

export async function restoreLedgerNode(userId: string, nodeId: string): Promise<LedgerNode> {
  await requireNode(userId, nodeId)
  return updateNode(userId, nodeId, { archivedAt: null })
}

/** Only a node nothing references can be deleted (EC-33). Anything with history is archived instead. */
export async function removeLedgerNode(userId: string, nodeId: string): Promise<void> {
  await requireMutableNode(userId, nodeId)
  if ((await countTransactionsForNode(userId, nodeId)) > 0) throw new NodeHasHistoryError()
  await deleteNode(userId, nodeId)
}
