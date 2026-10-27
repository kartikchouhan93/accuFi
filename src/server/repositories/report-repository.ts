import { Prisma } from "@prisma/client"
import { calendarDate, fromDbDate, toDbDate, type CalendarDate } from "@/domain/calendar-date"
import type { LedgerKind } from "@/domain/ledger-kind"
import type { Paise } from "@/domain/money"
import { prisma } from "@/server/db"

// The SQL the reports read from. Like every repository, each function takes `userId` first and puts it on every table
// it touches: both the transaction side and the node side of each join, as `sumBalances` does, because nothing in the
// schema ties a transaction's userId to the userId of the nodes it points at. Sums are cast to text and parsed with
// BigInt: Postgres returns numeric, and a JS number would lose precision above 2^53. Soft-deleted transactions never
// count; archived nodes always do (archiving hides a node, it does not remove what happened through it).

export interface MoveRow {
  nodeId: string
  /** `YYYY-MM` or `YYYY-MM-DD`, as asked for. */
  bucket: string
  /** Everything that moved into the node in the bucket. */
  inPaise: Paise
  /** Everything that moved out of it. */
  outPaise: Paise
}

export interface MoveQuery {
  from: CalendarDate
  to: CalendarDate
  bucket: "day" | "month"
  /** Only nodes of these kinds. Left out, every kind; an empty list matches nothing. */
  kinds?: LedgerKind[]
  /** Only these nodes. Left out, every node; an empty list matches nothing. Ids that are not the user's match nothing. */
  nodeIds?: string[]
}

// Two fixed formats, written into the statement as raw SQL (never a parameter: a parameter in the SELECT and another in
// the GROUP BY are different expressions to Postgres). The values are this closed set, never caller text.
const BUCKET_FORMAT = { month: Prisma.raw(`'YYYY-MM'`), day: Prisma.raw(`'YYYY-MM-DD'`) } as const

interface MoveSqlRow {
  nodeId: string
  bucket: string
  inPaise: string
  outPaise: string
}

/**
 * For each node of the user that moved money on live transactions dated in [from, to] (both ends included), what came
 * in and what went out, per bucket. A node with no move in the range has no row. Ordered by bucket, then node id.
 */
export async function findMoves(userId: string, query: MoveQuery): Promise<MoveRow[]> {
  if (query.kinds?.length === 0 || query.nodeIds?.length === 0) return []
  const kinds = query.kinds ? Prisma.sql`AND n."kind"::text IN (${Prisma.join(query.kinds)})` : Prisma.empty
  const nodes = query.nodeIds ? Prisma.sql`AND n."id" IN (${Prisma.join(query.nodeIds)})` : Prisma.empty
  const format = BUCKET_FORMAT[query.bucket]
  const rows = await prisma.$queryRaw<MoveSqlRow[]>`
    SELECT m."nodeId" AS "nodeId", to_char(m."occurredAt", ${format}) AS "bucket",
           SUM(m."inPaise")::text AS "inPaise", SUM(m."outPaise")::text AS "outPaise"
    FROM (
      SELECT "toNodeId" AS "nodeId", "occurredAt", "amountPaise" AS "inPaise", 0::bigint AS "outPaise" FROM "Transaction"
       WHERE "userId" = ${userId} AND "deletedAt" IS NULL
         AND "occurredAt" >= ${query.from}::date AND "occurredAt" <= ${query.to}::date
      UNION ALL
      SELECT "fromNodeId", "occurredAt", 0::bigint, "amountPaise" FROM "Transaction"
       WHERE "userId" = ${userId} AND "deletedAt" IS NULL
         AND "occurredAt" >= ${query.from}::date AND "occurredAt" <= ${query.to}::date
    ) m
    JOIN "LedgerNode" n ON n."id" = m."nodeId" AND n."userId" = ${userId}
    WHERE TRUE ${kinds} ${nodes}
    GROUP BY m."nodeId", to_char(m."occurredAt", ${format})
    ORDER BY "bucket", m."nodeId"`
  return rows.map((row) => ({ nodeId: row.nodeId, bucket: row.bucket, inPaise: BigInt(row.inPaise), outPaise: BigInt(row.outPaise) }))
}

export interface RealisedRow {
  /** The INVESTMENT node that was sold. */
  nodeId: string
  /** `YYYY-MM`. */
  bucket: string
  gainPaise: Paise
  lossPaise: Paise
}

interface RealisedSqlRow {
  nodeId: string
  bucket: string
  gainPaise: string
  lossPaise: string
}

/**
 * What the user's sales realised, per investment and month, over live transactions dated in [from, to]. A sale that
 * realised anything is a DISPOSAL group (spec section 7.5): its gain leg runs REALISED_GAIN -> account and its loss leg
 * INVESTMENT -> REALISED_LOSS, and it is attributed to the INVESTMENT that is the source of one of the group's legs (the
 * cost-basis leg, or the loss leg, both from the node sold; `MIN` picks the one, there is only ever one). A break-even
 * sale posts a single ungrouped transaction and so has no row. Ordered by bucket, then node id.
 */
export async function findRealisedByMonth(userId: string, range: { from: CalendarDate; to: CalendarDate }): Promise<RealisedRow[]> {
  const rows = await prisma.$queryRaw<RealisedSqlRow[]>`
    WITH legs AS (
      SELECT t."groupId", t."occurredAt", t."amountPaise", t."fromNodeId", t."toNodeId"
      FROM "Transaction" t
      JOIN "TransactionGroup" g ON g."id" = t."groupId" AND g."userId" = ${userId} AND g."kind" = 'DISPOSAL'
      WHERE t."userId" = ${userId} AND t."deletedAt" IS NULL
    ),
    sold AS (
      SELECT l."groupId", MIN(l."fromNodeId") AS "nodeId"
      FROM legs l
      JOIN "LedgerNode" n ON n."id" = l."fromNodeId" AND n."userId" = ${userId} AND n."kind" = 'INVESTMENT'
      GROUP BY l."groupId"
    )
    SELECT s."nodeId" AS "nodeId", to_char(l."occurredAt", 'YYYY-MM') AS "bucket",
           COALESCE(SUM(CASE WHEN fn."systemRole" = 'REALISED_GAIN' THEN l."amountPaise" END), 0)::text AS "gainPaise",
           COALESCE(SUM(CASE WHEN tn."systemRole" = 'REALISED_LOSS' THEN l."amountPaise" END), 0)::text AS "lossPaise"
    FROM legs l
    JOIN sold s ON s."groupId" = l."groupId"
    JOIN "LedgerNode" fn ON fn."id" = l."fromNodeId" AND fn."userId" = ${userId}
    JOIN "LedgerNode" tn ON tn."id" = l."toNodeId" AND tn."userId" = ${userId}
    WHERE l."occurredAt" >= ${range.from}::date AND l."occurredAt" <= ${range.to}::date
      AND (fn."systemRole" = 'REALISED_GAIN' OR tn."systemRole" = 'REALISED_LOSS')
    GROUP BY s."nodeId", to_char(l."occurredAt", 'YYYY-MM')
    ORDER BY "bucket", s."nodeId"`
  return rows.map((row) => ({ nodeId: row.nodeId, bucket: row.bucket, gainPaise: BigInt(row.gainPaise), lossPaise: BigInt(row.lossPaise) }))
}

/** The day of the user's earliest live transaction, or null if they have none (a deleted one does not count). */
export async function findFirstTransactionDate(userId: string): Promise<CalendarDate | null> {
  const { _min } = await prisma.transaction.aggregate({ where: { userId, deletedAt: null }, _min: { occurredAt: true } })
  return _min.occurredAt === null ? null : fromDbDate(_min.occurredAt)
}

/** How many live transactions are dated strictly after `after`: the entries a report ending then leaves out. */
export function countLiveTransactionsAfter(userId: string, after: CalendarDate): Promise<number> {
  return prisma.transaction.count({ where: { userId, deletedAt: null, occurredAt: { gt: toDbDate(calendarDate(after)) } } })
}
