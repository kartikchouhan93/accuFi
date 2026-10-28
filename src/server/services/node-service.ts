import type { LedgerNode } from "@prisma/client"
import { type CalendarDate } from "@/domain/calendar-date"
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
import { deletePricesOfNode } from "@/server/repositories/price-repository"
import { countRulesNaming } from "@/server/repositories/recurring-repository"
import { insertTransactions, sumBalances } from "@/server/repositories/transaction-repository"
import { todayFor } from "@/server/services/clock"
import { inTransaction } from "@/server/repositories/unit-of-work"

// The node lifecycle. The database has no CHECK constraints, so everything it cannot enforce is enforced here: a
// system node is never renamed, archived or deleted; a node that transactions reference is never deleted; the
// hierarchy is one level deep; an opening balance is non-zero and goes only to a node that holds a balance. A node's
// kind is fixed at creation (EC-34): updateLedgerNode refuses a change outright, and the repository's allow-list
// would not write one anyway.

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

/** A recurring rule (live or deleted) still names the node, and the database keeps the node while a rule does. */
export class NodeInRecurringRuleError extends Error {
  constructor() {
    super("A recurring rule uses this account. Archive it instead.")
    this.name = "NodeInRecurringRuleError"
  }
}

export class HierarchyDepthError extends Error {
  constructor() {
    super("Nodes can be grouped one level deep: a node inside a group cannot itself contain others")
    this.name = "HierarchyDepthError"
  }
}

export class NodeKindChangeError extends Error {
  constructor() {
    super("A node's kind cannot be changed: create a new node and move its history instead")
    this.name = "NodeKindChangeError"
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
  // The schema takes any parent id and no screen offers a picker yet, so a crafted payload is the only way here: it must
  // not file an expense under "Realised Loss", nor under a node the user has put away.
  if (parent.systemRole !== null) throw new InvalidNodeError("A system node cannot contain others")
  if (parent.archivedAt !== null) throw new InvalidNodeError("An archived node cannot contain others. Restore it first.")
  if (parent.parentId !== null) throw new HierarchyDepthError()
  if (parent.kind !== input.kind) throw new InvalidNodeError("A node can only be grouped under a node of the same kind")
}

interface OpeningBalancePlan {
  /** The system node on the other side of the movement. */
  counterpart: LedgerNode
  /** Money flows new node -> counterpart (a negative position) rather than counterpart -> new node. */
  outOfNewNode: boolean
  amount: Paise
  occurredAt: CalendarDate
}

/**
 * Where an opening balance comes from, chosen by its sign and checked against the transaction rules. A positive
 * position posts OPENING_BALANCE -> node; a negative one (a card already owed on, an overdrawn account) posts
 * node -> OPENING_BALANCE_CONTRA, because INCOME_SOURCE can never be a target (spec §5) and so no legal edge into the
 * Opening Balance node exists. Decided by sign, not by kind: both kinds can start on either side of zero.
 */
async function planOpeningBalance(
  userId: string,
  kind: LedgerKind,
  openingBalance: Paise,
  occurredAt: CalendarDate,
): Promise<OpeningBalancePlan> {
  if (!OPENING_BALANCE_KINDS.has(kind)) {
    throw new InvalidNodeError("An opening balance can only be set on an asset or a liability")
  }
  if (openingBalance === 0n) throw new InvalidNodeError("An opening balance cannot be zero")
  const outOfNewNode = openingBalance < 0n
  const amount = outOfNewNode ? -openingBalance : openingBalance
  const [role, systemKind] = outOfNewNode ? (["OPENING_BALANCE_CONTRA", "EXPENSE"] as const) : (["OPENING_BALANCE", "INCOME_SOURCE"] as const)
  const counterpart = (await findNodes(userId, { kinds: [systemKind] })).find((n) => n.systemRole === role)
  if (!counterpart) throw new SystemNodeError(`This account has no ${role} node`)
  // The new node does not exist yet, so it is described by what the rules read: its kind. Checking before the write
  // means a refused opening balance leaves nothing behind.
  const newNode = { id: "(new node)", kind, archivedAt: null, systemRole: null }
  const violations = validateTransaction({
    fromNode: outOfNewNode ? newNode : counterpart,
    toNode: outOfNewNode ? counterpart : newNode,
    amount,
    occurredAt,
  })
  if (violations.length > 0) throw new InvalidNodeError(violations.map((v) => v.message).join(" "))
  return { counterpart, outOfNewNode, amount, occurredAt }
}

/**
 * Create a node. With `openingBalance` (ASSET and LIABILITY only; signed, never zero), also post a transaction for
 * it against the user's Opening Balance or Opening Balance Contra system node, dated today in the user's timezone
 * (EC-36). That is an ordinary, editable transaction, not a column: there is no stored balance anywhere.
 *
 * The node and its opening transaction are written in one database transaction, so a failure (or a crash) between
 * them leaves neither.
 */
export async function createLedgerNode(userId: string, input: CreateNodeInput): Promise<LedgerNode> {
  const name = cleanName(input.name)
  await validateParent(userId, input)

  // Read for every node, not only one with an opening balance: it is also what stops a session whose user row is gone
  // from reaching the insert, where the missing user would surface as a foreign-key violation instead of UserNotFoundError.
  const today = await todayFor(userId)
  const openingBalance = "openingBalance" in input ? input.openingBalance : undefined
  let plan: OpeningBalancePlan | null = null
  if (openingBalance !== undefined) {
    plan = await planOpeningBalance(userId, input.kind, openingBalance, today)
  }

  // `input` also carries `openingBalance`, which is not a column; the repository copies only the fields it allows.
  const data = { ...input, name }
  if (!plan) return createNode(userId, data)
  const opening = plan
  return inTransaction(async (uow) => {
    const node = await createNode(userId, data, uow)
    await insertTransactions(
      userId,
      [
        {
          fromNodeId: opening.outOfNewNode ? node.id : opening.counterpart.id,
          toNodeId: opening.outOfNewNode ? opening.counterpart.id : node.id,
          amountPaise: opening.amount,
          occurredAt: opening.occurredAt,
          note: "Opening balance",
        },
      ],
      undefined,
      uow,
    )
    return node
  })
}

/** What an edit may carry. Widen this, and EDITABLE_FIELDS, when another field becomes editable. */
export interface NodeChanges {
  name?: string
}
const EDITABLE_FIELDS: readonly string[] = ["name"]

/**
 * Edit a node. A node's kind is fixed at creation (EC-34): every transaction pointing at it derives its meaning from
 * the kind, so a change is refused here whatever the caller's types say. (The strict schemas turn a stray `kind` away
 * at the boundary first; this is the guard for a caller that bypasses them.) Naming the node's own, unchanged kind is
 * tolerated and ignored. Any other field the edit does not cover is refused, and nothing is written.
 */
export async function updateLedgerNode(userId: string, nodeId: string, changes: NodeChanges): Promise<LedgerNode> {
  const node = await requireMutableNode(userId, nodeId)
  const submitted: Record<string, unknown> = { ...changes }
  if (submitted.kind !== undefined && submitted.kind !== node.kind) throw new NodeKindChangeError()
  const rejected = Object.keys(submitted).filter(
    (field) => field !== "kind" && submitted[field] !== undefined && !EDITABLE_FIELDS.includes(field),
  )
  if (rejected.length > 0) throw new InvalidNodeError(`These fields cannot be changed: ${rejected.join(", ")}`)
  return updateNode(userId, nodeId, { name: changes.name === undefined ? undefined : cleanName(changes.name) })
}

export function renameLedgerNode(userId: string, nodeId: string, name: string): Promise<LedgerNode> {
  return updateLedgerNode(userId, nodeId, { name })
}

/**
 * What archiving this node would leave in it: its balance as of today in the user's own timezone, the basis of every
 * balance on screen (a transaction dated after today is projected and in none of them, EC-10). A deposit dated next
 * week is therefore not "still held": warning about it would name a figure that appears nowhere else and is not true
 * today. Reads only; throws what archiving would throw for a system node or one that is not the user's.
 */
export async function archiveResidual(userId: string, nodeId: string): Promise<Paise> {
  await requireMutableNode(userId, nodeId)
  return residualOf(userId, nodeId)
}

async function residualOf(userId: string, nodeId: string): Promise<Paise> {
  const row = (await sumBalances(userId, await todayFor(userId))).find((b) => b.nodeId === nodeId)
  if (!row) throw new NotFoundError("node") // deleted between the two reads
  return row.balance
}

/**
 * Archive a node and report what it still holds (`archiveResidual`: as of today). Archiving is allowed whatever the
 * balance (EC-32): the residue stays in history and in net worth (balances are summed over archived nodes too), and it
 * is the caller's job to warn the user. Archiving an archived node changes nothing and reports the same residual, so a
 * retried request succeeds.
 */
export async function archiveLedgerNode(
  userId: string,
  nodeId: string,
): Promise<{ node: LedgerNode; residualBalance: Paise }> {
  const current = await requireMutableNode(userId, nodeId)
  const residualBalance = await residualOf(userId, nodeId)
  const node = current.archivedAt !== null ? current : await updateNode(userId, nodeId, { archivedAt: new Date() })
  return { node, residualBalance }
}

export async function restoreLedgerNode(userId: string, nodeId: string): Promise<LedgerNode> {
  await requireNode(userId, nodeId)
  return updateNode(userId, nodeId, { archivedAt: null })
}

/**
 * Only a node with no transactions and no recurring rule can be deleted (EC-29, EC-33). Anything with history is archived
 * instead, and so is a node a rule names: a deleted rule stays in the table and its foreign keys to the node are RESTRICT,
 * so it counts as much as a live one. Its price
 * snapshots are not history in that sense (they move no money), but their foreign key to the node is RESTRICT, so they
 * are deleted with it, in one transaction: a failure leaves both.
 */
export async function removeLedgerNode(userId: string, nodeId: string): Promise<void> {
  await requireMutableNode(userId, nodeId)
  if ((await countTransactionsForNode(userId, nodeId)) > 0) throw new NodeHasHistoryError()
  if ((await countRulesNaming(userId, nodeId)) > 0) throw new NodeInRecurringRuleError()
  await inTransaction(async (uow) => {
    await deletePricesOfNode(userId, nodeId, uow)
    await deleteNode(userId, nodeId, uow)
  })
}
