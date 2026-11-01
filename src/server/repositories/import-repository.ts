import {
  Prisma,
  type CounterpartRule,
  type ImportBatch,
  type ImportBatchStatus,
  type ImportDirection,
  type ImportProfile,
  type ImportRow,
  type ImportRowStatus,
} from "@prisma/client"
import { prisma } from "@/server/db"
import { NotFoundError } from "./errors"
import { assertNodesOwned } from "./node-repository"
import { clientOf, type UnitOfWork } from "./unit-of-work"

// The only code that reads or writes ImportBatch, ImportRow, ImportProfile and CounterpartRule rows. Every exported
// function takes `userId` first and puts it in the `where` of every query. Nothing here can be pointed at another
// user's ledger, batch or profile: the schema cannot enforce that, so the writes check it. Rows are returned as stored
// (paise as bigint, DATE columns as Date); turning them into CalendarDate is the caller's job.
//
// `ImportBatch.fileBytes` is the whole uploaded statement, up to 5 MiB. Only `readBatchBytes` selects it: every other
// read goes through `NO_BYTES`, and a write returns its row the same way, so a listing never drags files out of the
// database. The status of a batch moves only through `transitionBatch`, one conditional UPDATE on the expected status.

/** An `ImportBatch` as every read here returns it: without `fileBytes`, which only `readBatchBytes` loads. */
export type BatchView = Omit<ImportBatch, "fileBytes">

/** The columns of an `ImportRow` a caller may write when it stages rows; the user and batch are the function's. */
export interface RowData {
  line: number
  raw: string[]
  status: ImportRowStatus
  errorReason: string | null
  occurredOn: Date | null
  amountPaise: bigint | null
  direction: ImportDirection | null
  description: string | null
  descriptionKey: string | null
  counterpartNodeId: string | null
  duplicateOfTransactionId: string | null
  occurrenceId: string | null
}

export interface RowQuery {
  status?: ImportRowStatus[]
  /** Only rows flagged as a probable duplicate of an existing transaction. */
  duplicatesOnly?: boolean
  offset: number
  limit: number
}

export interface RowCounts {
  byStatus: Record<ImportRowStatus, number>
  /** Rows flagged as a probable duplicate. */
  duplicates: number
  /** Rows linked to a pending recurring occurrence. */
  linked: number
}

export interface BatchTransition {
  from: ImportBatchStatus[]
  to: ImportBatchStatus
  mapping?: unknown
  rowCount?: number
  /** Null the stored file: the batch has ended and nothing will re-map it. */
  dropBytes?: boolean
  committedAt?: Date
  reversedAt?: Date
}

const NO_BYTES = { fileBytes: true } as const

const ROW_STATUSES: ImportRowStatus[] = ["PENDING", "READY", "SKIPPED", "ERRORED", "COMMITTED"]

// A row in one of these states is final: a decision cannot be put on it.
const FINAL_ROW_STATUSES: ImportRowStatus[] = ["ERRORED", "COMMITTED"]

const dbOf = (uow?: UnitOfWork) => (uow ? clientOf(uow) : prisma)

const json = (value: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull =>
  value === null ? Prisma.DbNull : (value as Prisma.InputJsonValue)

async function assertBatchOwned(userId: string, batchId: string, db: Prisma.TransactionClient | typeof prisma): Promise<void> {
  if ((await db.importBatch.count({ where: { id: batchId, userId } })) !== 1) throw new NotFoundError("import")
}

/**
 * Store a batch in status UPLOADED with no rows. Throws NotFoundError("node"), and writes nothing, if the account is not
 * this user's; NotFoundError("import") if `profileId` is not one of their profiles. The returned row has no `fileBytes`.
 */
export async function insertBatch(
  userId: string,
  data: { nodeId: string; fileName: string; fileSize: number; fileHash: string; fileBytes: Uint8Array; profileId?: string | null },
  uow?: UnitOfWork,
): Promise<BatchView> {
  const db = dbOf(uow)
  await assertNodesOwned(userId, [data.nodeId], db)
  const profileId = data.profileId ?? null
  if (profileId !== null && (await db.importProfile.count({ where: { id: profileId, userId } })) !== 1) {
    throw new NotFoundError("import")
  }
  return db.importBatch.create({
    data: {
      userId, // always the caller's; the data has no way to name another
      nodeId: data.nodeId,
      fileName: data.fileName,
      fileSize: data.fileSize,
      fileHash: data.fileHash,
      fileBytes: new Uint8Array(data.fileBytes),
      profileId,
      rowCount: 0,
    },
    omit: NO_BYTES,
  })
}

/** The user's batch without its file, or null if it does not exist or is not theirs. */
export function findBatchById(userId: string, id: string, uow?: UnitOfWork): Promise<BatchView | null> {
  return dbOf(uow).importBatch.findFirst({ where: { id, userId }, omit: NO_BYTES })
}

/** Every batch of the user, newest first, without the files. */
export function findBatches(userId: string): Promise<BatchView[]> {
  return prisma.importBatch.findMany({ where: { userId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], omit: NO_BYTES })
}

/** The stored file, or null if the batch is not this user's or its bytes were dropped. The one read that loads them. */
export async function readBatchBytes(userId: string, id: string, uow?: UnitOfWork): Promise<Uint8Array | null> {
  const row = await dbOf(uow).importBatch.findFirst({ where: { id, userId }, select: { fileBytes: true } })
  return row?.fileBytes ?? null
}

/**
 * The most recent batch of the user's with this file hash that has not been discarded, or null. `excludeBatchId` leaves
 * one batch out of the search (the one being uploaded now).
 */
export function findEarlierUpload(userId: string, fileHash: string, excludeBatchId?: string): Promise<BatchView | null> {
  return prisma.importBatch.findFirst({
    where: {
      userId,
      fileHash,
      status: { not: "DISCARDED" },
      ...(excludeBatchId === undefined ? {} : { id: { not: excludeBatchId } }),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    omit: NO_BYTES,
  })
}

/**
 * Hold the user's batch until the caller's transaction ends (`SELECT ... FOR UPDATE`) and return it as it is then, or
 * null if it is not theirs. Whatever commits, reverses or discards a batch takes this first, so two requests cannot both
 * see it STAGED. The row is read again through Prisma after the lock is taken, without its file.
 */
export async function lockBatch(userId: string, id: string, uow: UnitOfWork): Promise<BatchView | null> {
  const db = clientOf(uow)
  const locked = await db.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "ImportBatch" WHERE "id" = ${id} AND "userId" = ${userId} FOR UPDATE`
  if (locked.length === 0) return null
  return db.importBatch.findFirst({ where: { id, userId }, omit: NO_BYTES })
}

/**
 * Move a batch to a new status, one UPDATE that applies only while its status is one of `change.from`. Returns the batch
 * as it is now, or null if it matched nothing (not this user's, or in another status): the caller reads that as "someone
 * else got there first". `mapping` of `undefined` leaves the column alone and `null` clears it.
 */
export async function transitionBatch(
  userId: string,
  id: string,
  change: BatchTransition,
  uow?: UnitOfWork,
): Promise<BatchView | null> {
  const db = dbOf(uow)
  const { count } = await db.importBatch.updateMany({
    where: { id, userId, status: { in: change.from } },
    // Field by field, never a spread: an extra key on `change` (the types are gone at runtime) must not reach a column.
    data: {
      status: change.to,
      mapping: change.mapping === undefined ? undefined : json(change.mapping),
      rowCount: change.rowCount,
      fileBytes: change.dropBytes ? null : undefined,
      committedAt: change.committedAt,
      reversedAt: change.reversedAt,
    },
  })
  return count === 0 ? null : db.importBatch.findFirst({ where: { id, userId }, omit: NO_BYTES })
}

/**
 * Write staged rows into the user's batch and return how many. Throws NotFoundError("import") if the batch is not
 * theirs and NotFoundError("node"), writing nothing, if a counterpart is not their ledger.
 */
export async function insertRows(userId: string, batchId: string, rows: RowData[], uow: UnitOfWork): Promise<number> {
  const db = clientOf(uow)
  await assertBatchOwned(userId, batchId, db)
  if (rows.length === 0) return 0
  await assertNodesOwned(
    userId,
    rows.flatMap((row) => (row.counterpartNodeId === null ? [] : [row.counterpartNodeId])),
    db,
  )
  const { count } = await db.importRow.createMany({
    data: rows.map((row) => ({
      userId, // always the caller's; the row has no way to name another
      batchId,
      line: row.line,
      raw: row.raw,
      status: row.status,
      errorReason: row.errorReason,
      occurredOn: row.occurredOn,
      amountPaise: row.amountPaise,
      direction: row.direction,
      description: row.description,
      descriptionKey: row.descriptionKey,
      counterpartNodeId: row.counterpartNodeId,
      duplicateOfTransactionId: row.duplicateOfTransactionId,
      occurrenceId: row.occurrenceId,
    })),
  })
  return count
}

/** Remove every row of the user's batch (a re-stage, or a discard) and return how many went. */
export async function deleteRows(userId: string, batchId: string, uow: UnitOfWork): Promise<number> {
  const { count } = await clientOf(uow).importRow.deleteMany({ where: { userId, batchId } })
  return count
}

/** One page of the batch's rows, in file order. Rows of another user are never returned, even if placed in the batch. */
export function findRows(userId: string, batchId: string, query: RowQuery, uow?: UnitOfWork): Promise<ImportRow[]> {
  return dbOf(uow).importRow.findMany({
    where: {
      userId,
      batchId,
      ...(query.status === undefined ? {} : { status: { in: query.status } }),
      ...(query.duplicatesOnly ? { duplicateOfTransactionId: { not: null } } : {}),
    },
    orderBy: { line: "asc" },
    skip: query.offset,
    take: query.limit,
  })
}

export function findRowById(userId: string, id: string, uow?: UnitOfWork): Promise<ImportRow | null> {
  return dbOf(uow).importRow.findFirst({ where: { id, userId } })
}

/** Every row of the batch, in file order. */
export function findRowsForBatch(userId: string, batchId: string, uow?: UnitOfWork): Promise<ImportRow[]> {
  return dbOf(uow).importRow.findMany({ where: { userId, batchId }, orderBy: { line: "asc" } })
}

/** How many rows the batch has in each status (every status is present, 0 if none), flagged duplicates and linked rows. */
export async function countRows(userId: string, batchId: string, uow?: UnitOfWork): Promise<RowCounts> {
  const db = dbOf(uow)
  const [grouped, duplicates, linked] = await Promise.all([
    db.importRow.groupBy({ by: ["status"], where: { userId, batchId }, _count: { _all: true } }),
    db.importRow.count({ where: { userId, batchId, duplicateOfTransactionId: { not: null } } }),
    db.importRow.count({ where: { userId, batchId, occurrenceId: { not: null } } }),
  ])
  const byStatus = Object.fromEntries(ROW_STATUSES.map((status) => [status, 0])) as Record<ImportRowStatus, number>
  for (const group of grouped) byStatus[group.status] = group._count._all
  return { byStatus, duplicates, linked }
}

type Db = Prisma.TransactionClient

/**
 * Run `work` holding a share lock (`FOR SHARE`) on the batch `lock` names, inside the caller's transaction or, without
 * one, a short transaction of its own. A row decision written under it serializes against `lockBatch`'s `FOR UPDATE`:
 * a decision made while a commit (or a discard, a re-stage) holds the batch waits for it to finish and then sees the
 * batch as that left it — no longer STAGED, so the conditional UPDATE matches nothing — rather than slipping a row
 * into READY after the commit has already read which rows are READY. Two decisions on the same batch share the lock
 * and never wait on each other. The batch is always locked before any row, the same order `lockBatch`'s callers take,
 * so the two cannot deadlock.
 */
async function underBatchShareLock<T>(
  uow: UnitOfWork | undefined,
  lock: (db: Db) => Promise<unknown>,
  work: (db: Db) => Promise<T>,
): Promise<T> {
  const run = async (db: Db) => {
    await lock(db)
    return work(db)
  }
  return uow ? run(clientOf(uow)) : prisma.$transaction(run)
}

/** Share-lock the batch that holds the user's row `rowId`; locks nothing if the row is not theirs. */
const shareLockBatchOfRow = (userId: string, rowId: string) => (db: Db) =>
  db.$queryRaw`
    SELECT b."id" FROM "ImportBatch" b JOIN "ImportRow" r ON r."batchId" = b."id"
     WHERE r."id" = ${rowId} AND r."userId" = ${userId} AND b."userId" = ${userId}
       FOR SHARE OF b`

/** Share-lock the user's batch `batchId`; locks nothing if it is not theirs. */
const shareLockBatch = (userId: string, batchId: string) => (db: Db) =>
  db.$queryRaw`SELECT "id" FROM "ImportBatch" WHERE "id" = ${batchId} AND "userId" = ${userId} FOR SHARE`

/**
 * Change one row's decision: its status, counterpart or linked occurrence (`null` clears the last two, `undefined`
 * leaves a column alone). One UPDATE that applies only while the row is the user's, is not ERRORED or COMMITTED, and its
 * batch is STAGED; returns the row as it is now, or null if it matched nothing. A counterpart that is not the user's
 * ledger throws NotFoundError("node"). The write is made under a share lock on the row's batch (`underBatchShareLock`),
 * so it can never interleave with a commit of the same batch.
 */
export async function updateRow(
  userId: string,
  id: string,
  changes: Partial<{ status: ImportRowStatus; counterpartNodeId: string | null; occurrenceId: string | null }>,
  uow?: UnitOfWork,
): Promise<ImportRow | null> {
  return underBatchShareLock(uow, shareLockBatchOfRow(userId, id), async (db) => {
    if (changes.counterpartNodeId) await assertNodesOwned(userId, [changes.counterpartNodeId], db)
    const where: Prisma.ImportRowWhereInput = {
      id,
      userId,
      status: { notIn: FINAL_ROW_STATUSES },
      batch: { is: { userId, status: "STAGED" } },
    }
    const data = { status: changes.status, counterpartNodeId: changes.counterpartNodeId, occurrenceId: changes.occurrenceId }
    // An UPDATE with nothing to set reports nothing matched, which would read as a refusal: it is the plain lookup instead.
    if (Object.values(data).every((value) => value === undefined)) return db.importRow.findFirst({ where })
    const { count } = await db.importRow.updateMany({ where, data })
    return count === 0 ? null : db.importRow.findFirst({ where: { id, userId } })
  })
}

/**
 * Apply one choice to every row of the batch that reads the same: same direction and description key, and currently in
 * `match.status`. Only a STAGED batch's rows that are not ERRORED or COMMITTED are touched. Returns how many changed.
 * Written under a share lock on the batch, for the same reason as `updateRow`.
 */
export async function updateRowsWhereSame(
  userId: string,
  batchId: string,
  match: { direction: ImportDirection; descriptionKey: string; status: ImportRowStatus },
  changes: { status?: ImportRowStatus; counterpartNodeId?: string },
  uow?: UnitOfWork,
): Promise<number> {
  return underBatchShareLock(uow, shareLockBatch(userId, batchId), async (db) => {
    if (changes.counterpartNodeId) await assertNodesOwned(userId, [changes.counterpartNodeId], db)
    if (FINAL_ROW_STATUSES.includes(match.status)) return 0
    const { count } = await db.importRow.updateMany({
      where: {
        userId,
        batchId,
        direction: match.direction,
        descriptionKey: match.descriptionKey,
        status: match.status,
        batch: { is: { userId, status: "STAGED" } },
      },
      data: { status: changes.status, counterpartNodeId: changes.counterpartNodeId },
    })
    return count
  })
}

/** Throws NotFoundError("transaction") unless every one of `transactionIds` is this user's. */
async function assertTransactionsOwned(userId: string, transactionIds: string[], db: Db): Promise<void> {
  const distinct = [...new Set(transactionIds)]
  if ((await db.transaction.count({ where: { userId, id: { in: distinct } } })) !== distinct.length) {
    throw new NotFoundError("transaction")
  }
}

/**
 * Record what each READY row became: its status to COMMITTED and its `transactionId`. Throws NotFoundError("transaction")
 * if a transaction is not this user's and NotFoundError("import") if a row is not theirs or not READY (or is named
 * twice), so the caller's transaction rolls back rather than a commit being half recorded. One set-based UPDATE over
 * every pair, not one per row: a commit of `IMPORT_MAX_ROWS` rows is one statement here, not twenty thousand.
 */
export async function markRowsCommitted(
  userId: string,
  pairs: { rowId: string; transactionId: string }[],
  uow: UnitOfWork,
): Promise<void> {
  if (pairs.length === 0) return
  const db = clientOf(uow)
  await assertTransactionsOwned(userId, pairs.map((pair) => pair.transactionId), db)
  const rowIds = pairs.map((pair) => pair.rowId)
  const transactionIds = pairs.map((pair) => pair.transactionId)
  const updated = await db.$executeRaw`
    UPDATE "ImportRow" AS r SET "status" = 'COMMITTED', "transactionId" = v."transactionId"
      FROM unnest(${rowIds}::text[], ${transactionIds}::text[]) AS v("rowId", "transactionId")
     WHERE r."id" = v."rowId" AND r."userId" = ${userId} AND r."status" = 'READY'`
  if (updated !== pairs.length) throw new NotFoundError("import")
}

/**
 * Send READY rows of the user's batch back to PENDING, each flagged as a probable duplicate of the transaction paired
 * with it: what a commit does when it finds, at the last moment, a matching transaction recorded since staging. One
 * set-based UPDATE. Throws NotFoundError("transaction") if a transaction is not this user's and NotFoundError("import")
 * if a row is not theirs, not in this batch, or not READY, so the caller's transaction rolls back rather than flagging
 * only some of them.
 */
export async function flagRowsAsDuplicates(
  userId: string,
  batchId: string,
  pairs: { rowId: string; transactionId: string }[],
  uow: UnitOfWork,
): Promise<void> {
  if (pairs.length === 0) return
  const db = clientOf(uow)
  await assertTransactionsOwned(userId, pairs.map((pair) => pair.transactionId), db)
  const rowIds = pairs.map((pair) => pair.rowId)
  const transactionIds = pairs.map((pair) => pair.transactionId)
  const updated = await db.$executeRaw`
    UPDATE "ImportRow" AS r SET "status" = 'PENDING', "duplicateOfTransactionId" = v."transactionId"
      FROM unnest(${rowIds}::text[], ${transactionIds}::text[]) AS v("rowId", "transactionId")
     WHERE r."id" = v."rowId" AND r."userId" = ${userId} AND r."batchId" = ${batchId} AND r."status" = 'READY'`
  if (updated !== pairs.length) throw new NotFoundError("import")
}

/** Save a mapping under `name`, or replace the one the user already has under it. `nodeId`, if given, must be their ledger. */
export async function upsertProfile(
  userId: string,
  data: { name: string; nodeId: string | null; settings: unknown },
): Promise<ImportProfile> {
  if (data.nodeId !== null) await assertNodesOwned(userId, [data.nodeId])
  const settings = data.settings as Prisma.InputJsonValue
  return prisma.importProfile.upsert({
    where: { userId_name: { userId, name: data.name } },
    create: { userId, name: data.name, nodeId: data.nodeId, settings },
    update: { nodeId: data.nodeId, settings },
  })
}

/** The user's saved mappings, by name. */
export function findProfiles(userId: string): Promise<ImportProfile[]> {
  return prisma.importProfile.findMany({ where: { userId }, orderBy: [{ name: "asc" }, { id: "asc" }] })
}

export function findProfileById(userId: string, id: string): Promise<ImportProfile | null> {
  return prisma.importProfile.findFirst({ where: { id, userId } })
}

/**
 * The user's learned suggestions. Named for what they are because `findRules` already means recurring rules in the
 * repositories (the isolation test requires every export to be unique across modules).
 */
export function findCounterpartRules(userId: string, uow?: UnitOfWork): Promise<CounterpartRule[]> {
  return dbOf(uow).counterpartRule.findMany({ where: { userId }, orderBy: [{ direction: "asc" }, { descriptionKey: "asc" }] })
}

/**
 * Learn that `hits` rows (one, unless given) of this direction and description key went to `nodeId`: a new rule starts
 * at that many hits, an existing one moves to the new ledger (the latest choice wins) and counts them. A commit calls
 * this once per distinct key with the count of its rows, rather than once per row. Throws NotFoundError("node") if the
 * ledger is not the user's.
 */
export async function upsertRule(
  userId: string,
  data: { direction: ImportDirection; descriptionKey: string; nodeId: string; hits?: number },
  uow: UnitOfWork,
): Promise<void> {
  const db = clientOf(uow)
  await assertNodesOwned(userId, [data.nodeId], db)
  const hits = data.hits ?? 1
  await db.counterpartRule.upsert({
    where: { userId_direction_descriptionKey: { userId, direction: data.direction, descriptionKey: data.descriptionKey } },
    create: { userId, direction: data.direction, descriptionKey: data.descriptionKey, nodeId: data.nodeId, hits },
    update: { nodeId: data.nodeId, hits: { increment: hits } },
  })
}

/**
 * How many things of the user's import history name the ledger: batches for it as the account, in any status but
 * DISCARDED, and rows that chose it as the counterpart. Both foreign keys are RESTRICT, so this is what a delete must be
 * refused over. A DISCARDED batch is left out: it holds no rows and no file, there is nothing left of it for the user to
 * act on, and `deleteImportConfigFor` removes it along with the ledger rather than letting it block the delete forever.
 */
export async function countImportsNaming(userId: string, nodeId: string, uow?: UnitOfWork): Promise<number> {
  const db = dbOf(uow)
  const [batches, rows] = await Promise.all([
    db.importBatch.count({ where: { userId, nodeId, status: { not: "DISCARDED" } } }),
    db.importRow.count({ where: { userId, counterpartNodeId: nodeId } }),
  ])
  return batches + rows
}

/**
 * Delete what of the user's import configuration and history goes with the ledger: the saved mappings and learned
 * suggestions that name it (they hold nothing the user made by hand beyond a suggestion), and the DISCARDED batches for
 * it as the account (already emptied of rows and file by the discard; any stray row is removed first all the same, so
 * the batch's RESTRICT foreign key can never stop it).
 */
export async function deleteImportConfigFor(userId: string, nodeId: string, uow: UnitOfWork): Promise<void> {
  const db = clientOf(uow)
  await db.importProfile.deleteMany({ where: { userId, nodeId } })
  await db.counterpartRule.deleteMany({ where: { userId, nodeId } })
  await db.importRow.deleteMany({ where: { userId, batch: { is: { userId, nodeId, status: "DISCARDED" } } } })
  await db.importBatch.deleteMany({ where: { userId, nodeId, status: "DISCARDED" } })
}
