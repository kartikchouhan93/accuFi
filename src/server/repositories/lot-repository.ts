import { Prisma } from "@prisma/client"
import { fromDbDate, toDbDate, type CalendarDate } from "@/domain/calendar-date"
import type { Paise } from "@/domain/money"
import type { Quantity } from "@/domain/quantity"
import type { HoldingLot } from "@/domain/valuation"
import { prisma } from "@/server/db"
import { NotFoundError } from "./errors"
import { assertNodesOwned, type Db } from "./node-repository"
import { clientOf, type UnitOfWork } from "./unit-of-work"

// The only code that reads or writes InvestmentLot and LotConsumption rows. Every exported function takes `userId` first
// and puts it in the `where` of every query. Nothing in the schema ties a lot's or a consumption's userId to the owner
// of the node or transaction it points at, so the writes below check that each one is the caller's.
//
// There is no remaining-quantity column (spec §7.2, §9.4). A lot is live while its buying transaction is not deleted; a
// consumption is live while its disposal transaction is not deleted. Remaining quantity and remaining cost basis are
// derived from the live rows by the domain (`openLots`), so deleting or restoring either transaction unwinds by itself.
//
// Quantities are Decimal(18,6) in Postgres and scaled bigint micro-units everywhere else (EC-27). The conversion happens
// here and only here, through decimal strings: never through a JS number, which loses digits above 2^53.

const MICRO_UNITS_PER_UNIT = 1_000_000

const toQuantity = (value: Prisma.Decimal): Quantity => BigInt(value.mul(MICRO_UNITS_PER_UNIT).toFixed(0))
const toDecimal = (quantity: Quantity): Prisma.Decimal => new Prisma.Decimal(quantity.toString()).div(MICRO_UNITS_PER_UNIT)

const dbOf = (uow?: UnitOfWork): Db => (uow ? clientOf(uow) : prisma)

export interface LotDraft {
  nodeId: string
  /** The acquiring transaction: one lot per transaction. */
  transactionId: string
  quantity: Quantity
  /** The acquiring transaction's amount. */
  costBasisPaise: Paise
  /** The acquiring transaction's day. */
  acquiredAt: CalendarDate
}

export interface ConsumptionDraft {
  lotId: string
  /** The disposal's cost-basis leg. */
  transactionId: string
  quantity: Quantity
  costBasisPaise: Paise
}

async function assertTransactionsOwned(userId: string, transactionIds: readonly string[], db: Db): Promise<void> {
  const unique = [...new Set(transactionIds)]
  const owned = await db.transaction.count({ where: { userId, id: { in: unique } } })
  if (owned !== unique.length) throw new NotFoundError("transaction")
}

async function assertLotsOwned(userId: string, lotIds: readonly string[], db: Db): Promise<void> {
  const unique = [...new Set(lotIds)]
  const owned = await db.investmentLot.count({ where: { userId, id: { in: unique } } })
  if (owned !== unique.length) throw new NotFoundError("lot")
}

// A lot with the live consumptions of the caller, each carrying its disposal's day.
const lotInclude = (userId: string) =>
  ({
    transaction: { select: { deletedAt: true } },
    consumptions: {
      where: { userId, transaction: { userId, deletedAt: null } },
      include: { transaction: { select: { occurredAt: true } } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    },
  }) satisfies Prisma.InvestmentLotInclude

type LotRow = Prisma.InvestmentLotGetPayload<{ include: ReturnType<typeof lotInclude> }>

function toHoldingLot(row: LotRow, seq: number): HoldingLot {
  return {
    id: row.id,
    acquiredAt: fromDbDate(row.acquiredAt),
    seq,
    quantity: toQuantity(row.quantity),
    costBasisPaise: row.costBasisPaise,
    consumptions: row.consumptions.map((c) => ({
      quantity: toQuantity(c.quantity),
      costBasisPaise: c.costBasisPaise,
      disposedAt: fromDbDate(c.transaction.occurredAt),
    })),
  }
}

/**
 * Write the lot a purchase acquired, inside the caller's transaction. Throws NotFoundError, writing nothing, if the node
 * or the transaction is not this user's. A second lot for one transaction is refused by the database (one per purchase).
 */
export async function insertLot(userId: string, data: LotDraft, uow: UnitOfWork): Promise<void> {
  const db = clientOf(uow)
  await assertNodesOwned(userId, [data.nodeId], db)
  await assertTransactionsOwned(userId, [data.transactionId], db)
  await db.investmentLot.create({
    data: {
      userId, // always the caller's; the draft has no way to name another
      nodeId: data.nodeId,
      transactionId: data.transactionId,
      quantity: toDecimal(data.quantity),
      costBasisPaise: data.costBasisPaise,
      acquiredAt: toDbDate(data.acquiredAt),
    },
  })
}

/**
 * Change the lot `transactionId` acquired; fields left out are kept. Throws NotFoundError if this user has no such lot,
 * or if `nodeId` is not this user's node.
 */
export async function updateLot(
  userId: string,
  transactionId: string,
  data: Partial<Omit<LotDraft, "transactionId">>,
  uow: UnitOfWork,
): Promise<void> {
  const db = clientOf(uow)
  if (data.nodeId !== undefined) await assertNodesOwned(userId, [data.nodeId], db)
  const { count } = await db.investmentLot.updateMany({
    where: { userId, transactionId },
    data: {
      nodeId: data.nodeId,
      quantity: data.quantity === undefined ? undefined : toDecimal(data.quantity),
      costBasisPaise: data.costBasisPaise,
      acquiredAt: data.acquiredAt === undefined ? undefined : toDbDate(data.acquiredAt),
    },
  })
  if (count === 0) throw new NotFoundError("lot")
}

/**
 * Delete the lot `transactionId` acquired. Throws NotFoundError if this user has no such lot. A lot that any consumption
 * row references (a live sale's or a deleted one's) is refused by the database: check `countConsumptionsOfLot` first.
 */
export async function deleteLotOf(userId: string, transactionId: string, uow: UnitOfWork): Promise<void> {
  const { count } = await clientOf(uow).investmentLot.deleteMany({ where: { userId, transactionId } })
  if (count === 0) throw new NotFoundError("lot")
}

/**
 * The node's live lots (buying transaction not deleted), oldest entry first, each with its live consumptions. `seq` is
 * the lot's place in the order the node's lots were entered (deleted ones included, so it never shifts when a purchase
 * is deleted or restored): the tie-break between lots acquired on the same day. Empty for another user's node.
 */
export async function findLiveLots(userId: string, nodeId: string, uow?: UnitOfWork): Promise<HoldingLot[]> {
  const rows = await dbOf(uow).investmentLot.findMany({
    where: { userId, nodeId, transaction: { userId } },
    include: lotInclude(userId),
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  })
  return rows.flatMap((row, seq) => (row.transaction.deletedAt === null ? [toHoldingLot(row, seq)] : []))
}

/**
 * The lot `transactionId` acquired, live or not (`live` says which), with its live consumptions; null if the transaction
 * acquired none or is not this user's. `seq` is as in findLiveLots.
 */
export async function findLotByTransaction(
  userId: string,
  transactionId: string,
  uow?: UnitOfWork,
): Promise<(HoldingLot & { live: boolean }) | null> {
  const db = dbOf(uow)
  const row = await db.investmentLot.findFirst({
    where: { userId, transactionId, transaction: { userId } },
    include: lotInclude(userId),
  })
  if (!row) return null
  const seq = await db.investmentLot.count({
    where: {
      userId,
      nodeId: row.nodeId,
      transaction: { userId },
      OR: [{ createdAt: { lt: row.createdAt } }, { createdAt: row.createdAt, id: { lt: row.id } }],
    },
  })
  return { ...toHoldingLot(row, seq), live: row.transaction.deletedAt === null }
}

/**
 * The quantity each of `transactionIds` bought, by transaction id, for those of the caller's that acquired a lot (live
 * or not: the row says whether it is deleted). A transaction that bought none, or is not this user's, is not in the map.
 * What a screen shows beside a purchase, so an edit starts from the quantity it holds.
 */
export async function findLotQuantities(userId: string, transactionIds: readonly string[], uow?: UnitOfWork): Promise<Map<string, Quantity>> {
  if (transactionIds.length === 0) return new Map()
  const rows = await dbOf(uow).investmentLot.findMany({
    where: { userId, transactionId: { in: [...new Set(transactionIds)] }, transaction: { userId } },
    select: { transactionId: true, quantity: true },
  })
  return new Map(rows.map((row) => [row.transactionId, toQuantity(row.quantity)]))
}

/**
 * Which of `transactionIds` are legs of a sale (call 4: a sale is deleted and entered again, never edited): any leg of a
 * DISPOSAL group, or a row that consumed lots, whether or not its sale is deleted (a deleted sale's consumption rows
 * stay). Only the caller's rows, groups and consumptions count. What a screen needs so it never offers an edit the server
 * refuses; `assertNotASale` (lot-rules) is the same test, one row at a time.
 */
export async function findSaleTransactionIds(userId: string, transactionIds: readonly string[], uow?: UnitOfWork): Promise<Set<string>> {
  if (transactionIds.length === 0) return new Set()
  const rows = await dbOf(uow).transaction.findMany({
    where: {
      userId,
      id: { in: [...new Set(transactionIds)] },
      OR: [{ group: { is: { userId, kind: "DISPOSAL" } } }, { consumptions: { some: { userId } } }],
    },
    select: { id: true },
  })
  return new Set(rows.map((row) => row.id))
}

/**
 * Every consumption row of the lot `transactionId` acquired, live or not: a deleted sale's rows still point at the lot
 * (they are what restoring the sale brings back), and the database will not delete a lot they reference.
 */
export function countConsumptionsOfLot(userId: string, transactionId: string, uow?: UnitOfWork): Promise<number> {
  return dbOf(uow).lotConsumption.count({ where: { userId, lot: { userId, transactionId } } })
}

/**
 * Record what a disposal took from each lot, inside the caller's transaction: all rows or none. Throws NotFoundError,
 * writing nothing, if any lot or disposal transaction is not this user's.
 */
export async function insertConsumptions(userId: string, rows: readonly ConsumptionDraft[], uow: UnitOfWork): Promise<void> {
  if (rows.length === 0) return
  const db = clientOf(uow)
  await assertLotsOwned(userId, rows.map((row) => row.lotId), db)
  await assertTransactionsOwned(userId, rows.map((row) => row.transactionId), db)
  await db.lotConsumption.createMany({
    data: rows.map((row) => ({
      userId,
      lotId: row.lotId,
      transactionId: row.transactionId,
      quantity: toDecimal(row.quantity),
      costBasisPaise: row.costBasisPaise,
    })),
  })
}

/**
 * What the disposal `transactionId` took from each lot, whether or not it is deleted, in the order it was written, with
 * the day each lot was acquired (as it is now: an edit of the purchase moves it).
 */
export async function findConsumptionsByTransaction(
  userId: string,
  transactionId: string,
  uow?: UnitOfWork,
): Promise<{ lotId: string; quantity: Quantity; costBasisPaise: Paise; acquiredAt: CalendarDate }[]> {
  const rows = await dbOf(uow).lotConsumption.findMany({
    where: { userId, transactionId, lot: { userId } },
    include: { lot: { select: { acquiredAt: true } } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  })
  return rows.map((row) => ({
    lotId: row.lotId,
    quantity: toQuantity(row.quantity),
    costBasisPaise: row.costBasisPaise,
    acquiredAt: fromDbDate(row.lot.acquiredAt),
  }))
}

/**
 * Hold the lots of investment `nodeId` still until the caller's transaction ends: every write that decides from what a
 * lot still holds (a sale, the restore of one, the edit or delete of a purchase) takes this first and reads the lots
 * after it, so two of them cannot both take the same units, nor one cut or delete a lot the other is taking from. A row lock on the caller's node (FOR NO KEY UPDATE, which does not block a transaction merely
 * referring to the node). Throws NotFoundError if the node is not this user's.
 */
export async function lockHoldings(userId: string, nodeId: string, uow: UnitOfWork): Promise<void> {
  const rows = await clientOf(uow).$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "LedgerNode" WHERE "id" = ${nodeId} AND "userId" = ${userId} FOR NO KEY UPDATE`
  if (rows.length === 0) throw new NotFoundError("node")
}

/**
 * Live movements of a lot-mode node that its lots do not account for (call 7: such a node is not valued): transactions
 * into it with no lot, and transactions out of it with no consumption. The second leg of a disposal (proceeds or a
 * realised loss beside the cost-basis leg) carries no consumption by design, so a leg in a DISPOSAL group is not a gap.
 */
export async function findLotGaps(
  userId: string,
  nodeId: string,
  uow?: UnitOfWork,
): Promise<{ inflowsWithoutLot: number; outflowsWithoutConsumption: number }> {
  const db = dbOf(uow)
  // One after the other: inside a unit of work the two would queue on one connection anyway.
  const inflowsWithoutLot = await db.transaction.count({ where: { userId, toNodeId: nodeId, deletedAt: null, lot: { is: null } } })
  const outflowsWithoutConsumption = await db.transaction.count({
    where: {
      userId,
      fromNodeId: nodeId,
      deletedAt: null,
      consumptions: { none: { userId } },
      OR: [{ groupId: null }, { group: { is: { kind: { not: "DISPOSAL" } } } }],
    },
  })
  return { inflowsWithoutLot, outflowsWithoutConsumption }
}
