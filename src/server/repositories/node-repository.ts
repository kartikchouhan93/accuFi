import type { LedgerNode, Prisma, PrismaClient } from "@prisma/client"
import type { LedgerKind } from "@/domain/ledger-kind"
import { prisma } from "@/server/db"
import { NotFoundError } from "./errors"
import { clientOf, type UnitOfWork } from "./unit-of-work"

// The only code that reads or writes LedgerNode rows, with one sanctioned exception: seedAccountNodes
// (src/server/services/account-seed.ts) creates a new account's system nodes and starter ledgers inside the signup
// transaction, because the user does not exist as far as this layer is concerned until that transaction commits.
// Every exported function here takes `userId` first and puts it in the `where` of every query, so a row belonging to
// another user is indistinguishable from a row that does not exist.

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

/** Includes archived nodes: historical transactions still reference them. `uow`, when given, reads inside it. */
export function findNodeById(userId: string, nodeId: string, uow?: UnitOfWork): Promise<LedgerNode | null> {
  return (uow ? clientOf(uow) : prisma).ledgerNode.findFirst({ where: { id: nodeId, userId } })
}

/**
 * `uow`, when given, is a transaction the caller already opened (see unit-of-work.ts): the node is written inside
 * it, so it commits or rolls back with the caller's other writes. Ownership is checked either way.
 */
export async function createNode(userId: string, data: CreateNodeData, uow?: UnitOfWork): Promise<LedgerNode> {
  const fields = pick(data, OPTIONAL_FIELDS)
  const write = async (db: Prisma.TransactionClient) => {
    if (fields.parentId) await assertNodesOwned(userId, [fields.parentId], db)
    return db.ledgerNode.create({
      data: { ...fields, kind: data.kind, name: data.name, userId }, // userId last: nothing above can override it
    })
  }
  return uow ? write(clientOf(uow)) : prisma.$transaction(write)
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

/**
 * Throws NotFoundError if the node is not this user's. A node that any row references (a transaction, a lot, a price) is
 * refused by the database. `uow`, when given, deletes inside the caller's transaction.
 */
export async function deleteNode(userId: string, nodeId: string, uow?: UnitOfWork): Promise<void> {
  const { count } = await (uow ? clientOf(uow) : prisma).ledgerNode.deleteMany({ where: { id: nodeId, userId } })
  if (count === 0) throw new NotFoundError("node")
}

/**
 * Every transaction of this user that touches the node on either side, soft-deleted ones included. It is a good guide
 * to whether the node can be deleted: the database refuses to delete a node any row references, deleted or not. It is
 * not a guarantee, because it counts only this user's rows while the foreign keys see every user's, so it reads 0 for
 * a node another user's row references (which the repositories never create, but the schema cannot forbid); the
 * delete then fails at the database rather than here.
 */
export function countTransactionsForNode(userId: string, nodeId: string): Promise<number> {
  return prisma.transaction.count({
    where: { userId, OR: [{ fromNodeId: nodeId }, { toNodeId: nodeId }] },
  })
}
