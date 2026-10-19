import type { LedgerNode, Prisma, PrismaClient } from "@prisma/client"
import type { LedgerKind } from "@/domain/ledger-kind"
import { prisma } from "@/server/db"
import { NotFoundError } from "./errors"

// The only code that reads or writes LedgerNode rows. Every exported function takes `userId` first and puts it in the
// `where` of every query, so a row belonging to another user is indistinguishable from a row that does not exist.

// Anything that can run a query: the global client or the client handed to a $transaction callback.
export type Db = PrismaClient | Prisma.TransactionClient

// Fields a caller may set. Deliberately absent: id, userId, createdAt (never the caller's to choose) and systemRole
// (system nodes are created only by account seeding). `kind` is settable at creation only: changing it under
// existing transactions would make them break the flow rules.
const OPTIONAL_FIELDS = [
  "parentId",
  "institution",
  "lastFour",
  "assetSubtype",
  "liabilitySubtype",
  "creditLimitPaise",
  "statementDay",
  "dueDay",
  "valuationMode",
  "unitLabel",
  "lotMethod",
  "stalePriceDays",
  "blockNegative",
] as const
type OptionalField = (typeof OPTIONAL_FIELDS)[number]

export type CreateNodeData = Pick<LedgerNode, "kind" | "name"> & Partial<Pick<LedgerNode, OptionalField>>
export type UpdateNodeData = Partial<Pick<LedgerNode, OptionalField | "name" | "archivedAt">>

// Copy only the listed keys. A spread of the caller's object would let an extra `userId` or `systemRole` key (the
// type system is gone at runtime) be written; this makes the allow-list the only way a field reaches the database.
function pick<T extends object, K extends keyof T>(source: T, keys: readonly K[]): Partial<Pick<T, K>> {
  const out: Partial<Pick<T, K>> = {}
  for (const key of keys) if (source[key] !== undefined) out[key] = source[key]
  return out
}

/**
 * Throws NotFoundError unless every id is a node owned by `userId`. This is what stops a transaction (or a parent
 * link) from pointing at another user's node: the schema has no constraint tying a row's userId to the userId of
 * the nodes it references, so each write that takes a node id must come through here.
 */
export async function assertNodesOwned(userId: string, nodeIds: readonly string[], db: Db = prisma): Promise<void> {
  const unique = [...new Set(nodeIds)]
  if (unique.length === 0) return
  const owned = await db.ledgerNode.count({ where: { userId, id: { in: unique } } })
  if (owned !== unique.length) throw new NotFoundError("node")
}

export function findNodes(
  userId: string,
  filter: { kinds?: LedgerKind[]; includeArchived?: boolean } = {},
): Promise<LedgerNode[]> {
  return prisma.ledgerNode.findMany({
    where: {
      userId,
      ...(filter.kinds ? { kind: { in: filter.kinds } } : {}),
      ...(filter.includeArchived ? {} : { archivedAt: null }),
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  })
}

/** Includes archived nodes: historical transactions still reference them. */
export function findNodeById(userId: string, nodeId: string): Promise<LedgerNode | null> {
  return prisma.ledgerNode.findFirst({ where: { id: nodeId, userId } })
}

export async function createNode(userId: string, data: CreateNodeData): Promise<LedgerNode> {
  const fields = pick(data, OPTIONAL_FIELDS)
  return prisma.$transaction(async (tx) => {
    if (fields.parentId) await assertNodesOwned(userId, [fields.parentId], tx)
    return tx.ledgerNode.create({
      data: { ...fields, kind: data.kind, name: data.name, userId }, // userId last: nothing above can override it
    })
  })
}

/** Throws NotFoundError if the node is not this user's (or does not exist). */
export async function updateNode(userId: string, nodeId: string, data: UpdateNodeData): Promise<LedgerNode> {
  const fields = pick(data, ["name", "archivedAt", ...OPTIONAL_FIELDS] as const)
  return prisma.$transaction(async (tx) => {
    if (fields.parentId) await assertNodesOwned(userId, [fields.parentId], tx)
    const { count } = await tx.ledgerNode.updateMany({ where: { id: nodeId, userId }, data: fields })
    if (count === 0) throw new NotFoundError("node")
    return tx.ledgerNode.findFirstOrThrow({ where: { id: nodeId, userId } })
  })
}

/** Throws NotFoundError if the node is not this user's. A node that transactions reference is refused by the database. */
export async function deleteNode(userId: string, nodeId: string): Promise<void> {
  const { count } = await prisma.ledgerNode.deleteMany({ where: { id: nodeId, userId } })
  if (count === 0) throw new NotFoundError("node")
}

/**
 * Every transaction that touches the node on either side, soft-deleted ones included: the database refuses to delete
 * a node while any row references it, deleted or not, so this is the number that decides delete versus archive.
 */
export function countTransactionsForNode(userId: string, nodeId: string): Promise<number> {
  return prisma.transaction.count({
    where: { userId, OR: [{ fromNodeId: nodeId }, { toNodeId: nodeId }] },
  })
}
