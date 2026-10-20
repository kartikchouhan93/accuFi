import { Prisma, type Transaction } from "@prisma/client"
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
// Keyset, not OFFSET: rows inserted meanwhile cannot shift a page, and the (userId, occurredAt, id) index serves the
// order and the cursor condition directly, so deep pages do not scan the pages before them.
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
  if (filter.from) conditions.push({ occurredAt: { gte: toDbDate(filter.from) } })
  if (filter.to) conditions.push({ occurredAt: { lte: toDbDate(filter.to) } })
  if (filter.minAmount !== undefined) conditions.push({ amountPaise: { gte: filter.minAmount } })
  if (filter.maxAmount !== undefined) conditions.push({ amountPaise: { lte: filter.maxAmount } })
  if (filter.tags && filter.tags.length > 0) conditions.push({ tags: { hasEvery: filter.tags } })
  if (filter.search) conditions.push({ note: { contains: filter.search, mode: "insensitive" } })
  return conditions
}

/** Soft-deleted transactions are never listed. */
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
    where: { userId, deletedAt: null, AND: conditions },
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
    take: pageSize + 1,
  })
  const items = rows.slice(0, pageSize)
  return { items, nextCursor: rows.length > pageSize ? encodeCursor(items[items.length - 1]) : null }
}

/** A soft-deleted transaction is not found. */
export function findTransactionById(userId: string, id: string): Promise<Transaction | null> {
  return prisma.transaction.findFirst({ where: { id, userId, deletedAt: null } })
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

/** Throws NotFoundError if the transaction is not this user's, or is already deleted. */
export async function softDeleteTransaction(userId: string, id: string): Promise<void> {
  const { count } = await prisma.transaction.updateMany({
    where: { id, userId, deletedAt: null },
    data: { deletedAt: new Date(), version: { increment: 1 } },
  })
  if (count === 0) throw new NotFoundError("transaction")
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
