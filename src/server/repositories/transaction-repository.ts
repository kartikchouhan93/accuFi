import { Prisma, type GroupKind, type Transaction, type TransactionGroup } from "@prisma/client"
import { calendarDate, fromDbDate, toDbDate, type CalendarDate } from "@/domain/calendar-date"
import type { LedgerKind } from "@/domain/ledger-kind"
import type { NodeBalance } from "@/domain/balance"
import type { Paise } from "@/domain/money"
import { prisma } from "@/server/db"
import { DuplicateIdempotencyKeyError, InvalidCursorError, NotFoundError } from "./errors"
import { assertNodesOwned, type Db } from "./node-repository"
import { clientOf, type UnitOfWork } from "./unit-of-work"

// The only code that reads or writes Transaction rows. Every exported function takes `userId` first and puts it in the
// `where` of every query. A transaction row is also only ever written pointing at nodes (and a group) the same user
// owns: the schema cannot enforce that, so the writes below check it.

export interface TransactionFilter {
  /** Transactions that touch any of these nodes, as source or destination. */
  nodeIds?: string[]
  /** Transactions that touch a node of any of these kinds, as source or destination. */
  kinds?: LedgerKind[]
  /** Inclusive bounds on the transaction day. */
  from?: CalendarDate
  to?: CalendarDate
  /** Inclusive bounds on the amount. */
  minAmount?: Paise
  maxAmount?: Paise
  /** Only transactions carrying every one of these tags. */
  tags?: string[]
  /** Case-insensitive substring of the note. */
  search?: string
  /**
   * Soft-deleted transactions are listed too, among the live ones. Off by default: a listing is of what counts. This is
   * how a deleted entry is found again to be restored; it changes no balance (`sumBalances` never counts a deleted row).
   */
  includeDeleted?: boolean
}

export interface Page<T> {
  items: T[]
  nextCursor: string | null
}

export interface InsertDraft {
  fromNodeId: string
  toNodeId: string
  amountPaise: Paise
  occurredAt: CalendarDate
  note?: string | null
  tags?: string[]
  idempotencyKey?: string | null
}

export interface UpdateDraft {
  fromNodeId?: string
  toNodeId?: string
  amountPaise?: Paise
  occurredAt?: CalendarDate
  note?: string | null
  tags?: string[]
}

/** The row changed since the caller read it; `current` is what is stored now, for the caller to re-present. */
export class VersionConflictError extends Error {
  constructor(readonly current: Transaction) {
    super("The transaction was changed by someone else")
    this.name = "VersionConflictError"
  }
}

export const DEFAULT_PAGE_SIZE = 50
export const MAX_PAGE_SIZE = 200

// Listings are newest first on (occurredAt, id). `id` makes the order total, so rows sharing a day never straddle a
// page boundary ambiguously. The cursor is the last row's pair; the next page is everything strictly after it.
// Keyset, not OFFSET: rows inserted meanwhile cannot shift a page. The (userId, occurredAt, id) index supplies the
// ordering only, so a page is read in order without a sort. The cursor condition is written as an OR, and Postgres
// cannot use an OR as a range bound on that index: it is applied as a filter on the way, so a deep page still walks past
// the rows before it. A row comparison, (occurredAt, id) < (a, b), could be bounded; that is the change to make if deep
// pages ever matter.
function encodeCursor(row: Pick<Transaction, "occurredAt" | "id">): string {
  return Buffer.from(JSON.stringify([fromDbDate(row.occurredAt), row.id])).toString("base64url")
}

function decodeCursor(cursor: string): { occurredAt: Date; id: string } {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"))
    if (Array.isArray(parsed) && parsed.length === 2 && typeof parsed[0] === "string" && typeof parsed[1] === "string" && parsed[1] !== "") {
      return { occurredAt: toDbDate(calendarDate(parsed[0])), id: parsed[1] }
    }
  } catch {
    // fall through
  }
  throw new InvalidCursorError()
}

function filterConditions(filter: TransactionFilter): Prisma.TransactionWhereInput[] {
  const conditions: Prisma.TransactionWhereInput[] = []
  if (filter.nodeIds) {
    conditions.push({ OR: [{ fromNodeId: { in: filter.nodeIds } }, { toNodeId: { in: filter.nodeIds } }] })
  }
  if (filter.kinds) {
    conditions.push({ OR: [{ fromNode: { kind: { in: filter.kinds } } }, { toNode: { kind: { in: filter.kinds } } }] })
  }
  if (filter.from) conditions.push({ occurredAt: { gte: toDbDate(filter.from) } })
  if (filter.to) conditions.push({ occurredAt: { lte: toDbDate(filter.to) } })
  if (filter.minAmount !== undefined) conditions.push({ amountPaise: { gte: filter.minAmount } })
  if (filter.maxAmount !== undefined) conditions.push({ amountPaise: { lte: filter.maxAmount } })
  if (filter.tags && filter.tags.length > 0) conditions.push({ tags: { hasEvery: filter.tags } })
  if (filter.search) conditions.push({ note: { contains: filter.search, mode: "insensitive" } })
  return conditions
}

/** Soft-deleted transactions are left out unless `filter.includeDeleted` is set. */
export async function findTransactions(
  userId: string,
  filter: TransactionFilter = {},
  cursor?: string,
  limit: number = DEFAULT_PAGE_SIZE,
): Promise<Page<Transaction>> {
  const pageSize = Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 1), MAX_PAGE_SIZE) : DEFAULT_PAGE_SIZE
  const conditions = filterConditions(filter)
  if (cursor !== undefined) {
    const after = decodeCursor(cursor)
    conditions.push({
      OR: [{ occurredAt: { lt: after.occurredAt } }, { occurredAt: after.occurredAt, id: { lt: after.id } }],
    })
  }
  // One extra row says whether another page exists without a second count query.
  const rows = await prisma.transaction.findMany({
    where: { userId, ...(filter.includeDeleted ? {} : { deletedAt: null }), AND: conditions },
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
    take: pageSize + 1,
  })
  const items = rows.slice(0, pageSize)
  return { items, nextCursor: rows.length > pageSize ? encodeCursor(items[items.length - 1]) : null }
}

/**
 * Every live member of each of these groups (deleted ones too when `includeDeleted`, which is how a deleted split is
 * shown whole), whatever filter found the group: a page of `findTransactions` can end in
 * the middle of a split, and the legs that did not fit are still part of it. Ordered as the legs were written (all of a
 * split's legs are inserted in one database transaction, so they share a creation time and `id` breaks the tie).
 * Groups that are not this user's, or have no live member, contribute nothing.
 */
export function findGroupMembers(userId: string, groupIds: readonly string[], includeDeleted = false): Promise<Transaction[]> {
  if (groupIds.length === 0) return Promise.resolve([])
  return prisma.transaction.findMany({
    where: { userId, ...(includeDeleted ? {} : { deletedAt: null }), groupId: { in: [...groupIds] } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  })
}

/** A soft-deleted transaction is not found. `uow`, when given, reads inside the caller's open transaction. */
export function findTransactionById(userId: string, id: string, uow?: UnitOfWork): Promise<Transaction | null> {
  return (uow ? clientOf(uow) : prisma).transaction.findFirst({ where: { id, userId, deletedAt: null } })
}

/**
 * The rows carrying any of these idempotency keys, in the order the keys are given, soft-deleted ones included (a
 * deleted row keeps its key reserved). Keys no row carries are skipped. This is how a replayed split finds its legs.
 * `uow`, when given, reads inside the caller's open transaction.
 */
export async function findTransactionsByIdempotencyKeys(
  userId: string,
  keys: readonly string[],
  uow?: UnitOfWork,
): Promise<Transaction[]> {
  const rows = await (uow ? clientOf(uow) : prisma).transaction.findMany({ where: { userId, idempotencyKey: { in: [...keys] } } })
  return keys.flatMap((key) => rows.filter((row) => row.idempotencyKey === key))
}

/** The group, or null if it is not this user's. `uow`, when given, reads inside the caller's open transaction. */
export function findGroupById(userId: string, groupId: string, uow?: UnitOfWork): Promise<TransactionGroup | null> {
  return (uow ? clientOf(uow) : prisma).transactionGroup.findFirst({ where: { id: groupId, userId } })
}

/** Open a group for transactions to be inserted into (`insertTransactions(..., groupId, uow)`). It belongs to `userId`. */
export function createTransactionGroup(userId: string, kind: GroupKind, uow: UnitOfWork): Promise<TransactionGroup> {
  return clientOf(uow).transactionGroup.create({ data: { userId, kind } })
}

async function assertGroupOwned(userId: string, groupId: string, db: Db): Promise<void> {
  const owned = await db.transactionGroup.count({ where: { id: groupId, userId } })
  if (owned !== 1) throw new NotFoundError("group")
}

/**
 * Insert all drafts or none. Throws NotFoundError, and writes nothing, if any referenced node (or the group) is not
 * this user's; DuplicateIdempotencyKeyError, carrying the stored row, if a draft repeats a key this user already used.
 * `uow`, when given, is a transaction the caller already opened (see unit-of-work.ts): the rows are written inside
 * it and commit or roll back with it. A duplicate key then still raises DuplicateIdempotencyKeyError,
 * but it has aborted the caller's transaction too, so the caller must let it roll back.
 */
export async function insertTransactions(
  userId: string,
  drafts: InsertDraft[],
  groupId?: string,
  uow?: UnitOfWork,
): Promise<Transaction[]> {
  if (drafts.length === 0) return []
  const keys = drafts.flatMap((d) => (d.idempotencyKey ? [d.idempotencyKey] : []))
  if (new Set(keys).size !== keys.length) throw new Error("A batch cannot repeat an idempotency key")
  try {
    const write = async (db: Prisma.TransactionClient) => {
      await assertNodesOwned(userId, drafts.flatMap((d) => [d.fromNodeId, d.toNodeId]), db)
      if (groupId !== undefined) await assertGroupOwned(userId, groupId, db)
      const created: Transaction[] = []
      for (const draft of drafts) {
        created.push(
          await db.transaction.create({
            data: {
              userId, // always the caller's; the draft has no way to name another
              fromNodeId: draft.fromNodeId,
              toNodeId: draft.toNodeId,
              amountPaise: draft.amountPaise,
              occurredAt: toDbDate(draft.occurredAt),
              note: draft.note ?? null,
              tags: draft.tags ?? [],
              idempotencyKey: draft.idempotencyKey ?? null,
              groupId: groupId ?? null,
            },
          }),
        )
      }
      return created
    }
    return await (uow ? write(clientOf(uow)) : prisma.$transaction(write))
  } catch (error) {
    // The only unique constraint a Transaction insert can hit is (userId, idempotencyKey). The failed statement
    // aborted the database transaction, so the lookup runs outside it, on its own, scoped to the user like every query.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002" && keys.length > 0) {
      const rows = await prisma.transaction.findMany({ where: { userId, idempotencyKey: { in: keys } } })
      const existing = rows.find((row) => row.idempotencyKey !== null && keys.includes(row.idempotencyKey))
      if (existing) throw new DuplicateIdempotencyKeyError(existing)
    }
    throw error
  }
}

/**
 * Optimistic-concurrency update: applies only if the row is this user's, live, and still at `expectedVersion`, and
 * bumps `version`. Otherwise throws NotFoundError (not this user's, or deleted) or VersionConflictError carrying the
 * stored row. The conflict is only ever reported for a row the user owns, so it cannot confirm another user's row.
 * `uow`, when given, is a transaction the caller already opened (see unit-of-work.ts): the update is made inside it and
 * commits or rolls back with it, and a refusal here leaves the caller's transaction to be rolled back.
 */
export async function updateTransaction(
  userId: string,
  id: string,
  data: UpdateDraft,
  expectedVersion: number,
  uow?: UnitOfWork,
): Promise<Transaction> {
  const write = async (tx: Prisma.TransactionClient) => {
    const nodeIds = [data.fromNodeId, data.toNodeId].filter((n): n is string => n !== undefined)
    await assertNodesOwned(userId, nodeIds, tx)
    const { count } = await tx.transaction.updateMany({
      where: { id, userId, version: expectedVersion, deletedAt: null },
      data: {
        fromNodeId: data.fromNodeId,
        toNodeId: data.toNodeId,
        amountPaise: data.amountPaise,
        occurredAt: data.occurredAt === undefined ? undefined : toDbDate(data.occurredAt),
        note: data.note,
        tags: data.tags,
        version: { increment: 1 },
      },
    })
    if (count === 0) {
      const current = await tx.transaction.findFirst({ where: { id, userId, deletedAt: null } })
      if (!current) throw new NotFoundError("transaction")
      throw new VersionConflictError(current)
    }
    return tx.transaction.findFirstOrThrow({ where: { id, userId } })
  }
  return uow ? write(clientOf(uow)) : prisma.$transaction(write)
}

/** Throws NotFoundError if the transaction is not this user's, or is already deleted. `uow` as for updateTransaction. */
export async function softDeleteTransaction(userId: string, id: string, uow?: UnitOfWork): Promise<void> {
  const { count } = await (uow ? clientOf(uow) : prisma).transaction.updateMany({
    where: { id, userId, deletedAt: null },
    data: { deletedAt: new Date(), version: { increment: 1 } },
  })
  if (count === 0) throw new NotFoundError("transaction")
}

/**
 * The rows restoring `id` would bring back (undeleteTransaction and undeleteGroup): the transaction, if it is this
 * user's and deleted, and the other deleted members of its group. Empty otherwise. Read before the restore writes
 * anything, so that a caller can lock what those rows touch first.
 */
export async function findRestorable(userId: string, id: string, uow: UnitOfWork): Promise<Transaction[]> {
  const db = clientOf(uow)
  const row = await db.transaction.findFirst({ where: { id, userId, deletedAt: { not: null } } })
  if (!row) return []
  if (row.groupId === null) return [row]
  const siblings = await db.transaction.findMany({
    where: { userId, groupId: row.groupId, deletedAt: { not: null }, id: { not: row.id } },
    orderBy: { id: "asc" },
  })
  return [row, ...siblings]
}

/**
 * The inverse of softDeleteTransaction: clears `deletedAt`, bumps `version` and returns the row. Throws NotFoundError
 * if the transaction is not this user's, or is not deleted. `uow` as for updateTransaction.
 */
export async function undeleteTransaction(userId: string, id: string, uow?: UnitOfWork): Promise<Transaction> {
  const write = async (db: Prisma.TransactionClient) => {
    const { count } = await db.transaction.updateMany({
      where: { id, userId, deletedAt: { not: null } },
      data: { deletedAt: null, version: { increment: 1 } },
    })
    if (count === 0) throw new NotFoundError("transaction")
    return db.transaction.findFirstOrThrow({ where: { id, userId } })
  }
  return uow ? write(clientOf(uow)) : prisma.$transaction(write)
}

/**
 * Soft-delete every live member of a group together, bumping each version. Throws NotFoundError if the group has none
 * (not this user's, or already deleted). The rows keep their `groupId`, so restoring the group can find them again.
 */
export async function softDeleteGroup(userId: string, groupId: string, uow: UnitOfWork): Promise<void> {
  const { count } = await clientOf(uow).transaction.updateMany({
    where: { userId, groupId, deletedAt: null },
    data: { deletedAt: new Date(), version: { increment: 1 } },
  })
  if (count === 0) throw new NotFoundError("group")
}

/** The inverse of softDeleteGroup: brings back every deleted member of the group and returns those rows. */
export async function undeleteGroup(userId: string, groupId: string, uow: UnitOfWork): Promise<Transaction[]> {
  const db = clientOf(uow)
  const deleted = await db.transaction.findMany({ where: { userId, groupId, deletedAt: { not: null } }, select: { id: true } })
  const ids = deleted.map((row) => row.id)
  await db.transaction.updateMany({ where: { userId, id: { in: ids } }, data: { deletedAt: null, version: { increment: 1 } } })
  return db.transaction.findMany({ where: { userId, id: { in: ids } }, orderBy: { id: "asc" } })
}

/**
 * Take one live transaction out of its group and return it. A group is two or more transactions that are one event; if
 * that leaves a single live member, the group is dissolved with it: the survivor's `groupId` is cleared too and the
 * empty group row is removed, so no group of one (or of none) is ever left behind. A transaction that is in no group
 * is returned as it is. Throws NotFoundError if it is not this user's, or is deleted. `uow` as for updateTransaction.
 */
export async function detachFromGroup(userId: string, id: string, uow: UnitOfWork): Promise<Transaction> {
  const db = clientOf(uow)
  const existing = await db.transaction.findFirst({ where: { id, userId, deletedAt: null } })
  if (!existing) throw new NotFoundError("transaction")
  const { groupId } = existing
  if (groupId === null) return existing

  await db.transaction.updateMany({ where: { id, userId }, data: { groupId: null, version: { increment: 1 } } })
  const remaining = await db.transaction.count({ where: { userId, groupId, deletedAt: null } })
  if (remaining <= 1) {
    // Every row still pointing at the group, deleted or not, or the foreign key would refuse to drop it.
    await db.transaction.updateMany({ where: { userId, groupId }, data: { groupId: null, version: { increment: 1 } } })
    await db.transactionGroup.deleteMany({ where: { id: groupId, userId } })
  }
  return db.transaction.findFirstOrThrow({ where: { id, userId } })
}

interface BalanceRow {
  nodeId: string
  kind: LedgerKind
  balance: string
  archived: boolean
}

/**
 * One row per node of the user, archived ones included (flagged `archived`), however few transactions it has: a node
 * with none reports 0. Archiving hides a node from pickers and lists; it does not remove what the node holds or owes, so
 * net worth must still count it (EC-32), and a caller that wants live nodes only filters on the flag. A balance
 * is inflows minus outflows over live (not soft-deleted) transactions dated on or before `asOf`; `asOf` omitted means
 * no upper bound, which includes future-dated rows (the projected figure, EC-10).
 *
 * Starting from LedgerNode and LEFT JOINing the movements is what makes the empty node appear (a GROUP BY over the
 * Transaction table alone has no group for it) and what carries `kind`. Both halves of the UNION and the node
 * side filter on "userId". The sum is cast to text and parsed with BigInt: Postgres returns numeric, and a JS number
 * would silently lose precision above 2^53. `uow`, when given, reads inside the caller's open transaction, so the
 * figure includes that transaction's own uncommitted writes.
 */
export async function sumBalances(userId: string, asOf?: CalendarDate, uow?: UnitOfWork): Promise<NodeBalance[]> {
  const upTo = asOf === undefined ? Prisma.empty : Prisma.sql`AND "occurredAt" <= ${asOf}::date`
  const db = uow ? clientOf(uow) : prisma
  const rows = await db.$queryRaw<BalanceRow[]>`
    SELECT n."id" AS "nodeId", n."kind"::text AS "kind", COALESCE(SUM(m."delta"), 0)::text AS "balance",
           (n."archivedAt" IS NOT NULL) AS "archived"
    FROM "LedgerNode" n
    LEFT JOIN (
      SELECT "toNodeId" AS "nodeId", "amountPaise" AS "delta" FROM "Transaction"
       WHERE "userId" = ${userId} AND "deletedAt" IS NULL ${upTo}
      UNION ALL
      SELECT "fromNodeId", -"amountPaise" FROM "Transaction"
       WHERE "userId" = ${userId} AND "deletedAt" IS NULL ${upTo}
    ) m ON m."nodeId" = n."id"
    WHERE n."userId" = ${userId}
    GROUP BY n."id", n."kind", n."archivedAt"
    ORDER BY n."id"`
  return rows.map((row) => ({ nodeId: row.nodeId, kind: row.kind, balance: BigInt(row.balance), archived: row.archived }))
}
