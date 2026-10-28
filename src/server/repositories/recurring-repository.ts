import { Prisma, type RecurrenceFrequency, type RecurringOccurrence, type RecurringRule } from "@prisma/client"
import { toDbDate, type CalendarDate } from "@/domain/calendar-date"
import type { Paise } from "@/domain/money"
import { prisma } from "@/server/db"
import { NotFoundError } from "./errors"
import { assertNodesOwned } from "./node-repository"
import { clientOf, type UnitOfWork } from "./unit-of-work"

// The only code that reads or writes RecurringRule and RecurringOccurrence rows. Every exported function takes `userId`
// first and puts it in the `where` of every query, with one deliberate exception, `findUsersWithRulesDueBy`, which
// names the users the hourly sweep has work for. A rule is also only ever written pointing at nodes the same user owns:
// the schema cannot enforce that, so the writes below check it. Rows are returned as stored (paise as bigint, DATE
// columns as Date); turning them into CalendarDate is the caller's job, except where a signature here takes one.

export interface RuleData {
  name: string
  fromNodeId: string
  toNodeId: string
  amountPaise: Paise
  note: string | null
  tags: string[]
  frequency: RecurrenceFrequency
  interval: number
  dayOfMonth: number | null
  dayOfWeek: number | null
  startDate: CalendarDate
  endDate: CalendarDate | null
  occurrenceLimit: number | null
  autoPost: boolean
}

export type OccurrenceWithRule = RecurringOccurrence & { rule: RecurringRule }

/** The rule changed since the caller read it; `current` is what is stored now, for the caller to re-present. */
export class RuleVersionConflictError extends Error {
  constructor(readonly current: RecurringRule) {
    super("The recurring rule was changed by someone else")
    this.name = "RuleVersionConflictError"
  }
}

/** An insert repeated an idempotency key this user already used; `existing` is the stored rule (it may be deleted). */
export class DuplicateRuleKeyError extends Error {
  constructor(readonly existing: RecurringRule) {
    super("A recurring rule with this idempotency key already exists")
    this.name = "DuplicateRuleKeyError"
  }
}

const dbOf = (uow?: UnitOfWork) => (uow ? clientOf(uow) : prisma)

const optionalDate = (value: CalendarDate | null | undefined) =>
  value === undefined ? undefined : value === null ? null : toDbDate(value)

/** Throws NotFoundError unless `ruleId` is a live rule of `userId`. */
async function assertRuleLive(userId: string, ruleId: string, db: Prisma.TransactionClient | typeof prisma): Promise<void> {
  const found = await db.recurringRule.count({ where: { id: ruleId, userId, deletedAt: null } })
  if (found !== 1) throw new NotFoundError("rule")
}

/**
 * Store a rule. Throws NotFoundError, and writes nothing, if either node is not this user's; DuplicateRuleKeyError,
 * carrying the stored row, if `idempotencyKey` is one this user already used. `uow`, when given, is a transaction the
 * caller already opened: a duplicate key then still raises DuplicateRuleKeyError, but it has aborted the caller's
 * transaction too, so the caller must let it roll back.
 */
export async function insertRule(
  userId: string,
  data: RuleData & { nextDueOn: CalendarDate | null; idempotencyKey?: string | null },
  uow?: UnitOfWork,
): Promise<RecurringRule> {
  const db = dbOf(uow)
  await assertNodesOwned(userId, [data.fromNodeId, data.toNodeId], db)
  const key = data.idempotencyKey ?? null
  try {
    return await db.recurringRule.create({
      data: {
        userId, // always the caller's; the data has no way to name another
        name: data.name,
        fromNodeId: data.fromNodeId,
        toNodeId: data.toNodeId,
        amountPaise: data.amountPaise,
        note: data.note,
        tags: data.tags,
        frequency: data.frequency,
        interval: data.interval,
        dayOfMonth: data.dayOfMonth,
        dayOfWeek: data.dayOfWeek,
        startDate: toDbDate(data.startDate),
        endDate: optionalDate(data.endDate),
        occurrenceLimit: data.occurrenceLimit,
        autoPost: data.autoPost,
        nextDueOn: optionalDate(data.nextDueOn),
        idempotencyKey: key,
      },
    })
  } catch (error) {
    // The only unique constraint a rule insert can hit is (userId, idempotencyKey). The failed statement aborted a
    // database transaction if there is one, so the lookup runs outside it, scoped to the user like every query.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002" && key !== null) {
      const existing = await findRuleByKey(userId, key)
      if (existing) throw new DuplicateRuleKeyError(existing)
    }
    throw error
  }
}

/**
 * The user's rule made under `idempotencyKey`, or null. Unlike every other read of a rule this one returns a soft-deleted
 * rule too: a replayed request must be able to tell "made, then deleted" from "never made". Only the user's own rules are
 * searched, so another user's key finds nothing. `uow`, when given, reads inside the caller's open transaction.
 */
export function findRuleByKey(userId: string, idempotencyKey: string, uow?: UnitOfWork): Promise<RecurringRule | null> {
  return dbOf(uow).recurringRule.findFirst({ where: { userId, idempotencyKey } })
}

/** A soft-deleted rule is not found. `uow`, when given, reads inside the caller's open transaction. */
export function findRuleById(userId: string, id: string, uow?: UnitOfWork): Promise<RecurringRule | null> {
  return dbOf(uow).recurringRule.findFirst({ where: { id, userId, deletedAt: null } })
}

/**
 * How many rules name the node at either end, the user's own, soft-deleted ones included: a deleted rule stays in the
 * table and its foreign keys to the node are RESTRICT, so it blocks a hard delete of the node as much as a live one.
 */
export function countRulesNaming(userId: string, nodeId: string): Promise<number> {
  return prisma.recurringRule.count({ where: { userId, OR: [{ fromNodeId: nodeId }, { toNodeId: nodeId }] } })
}

/** Live rules: the soonest next due first, finished ones (no next due day) last, then by name. */
export function findRules(userId: string): Promise<RecurringRule[]> {
  return prisma.recurringRule.findMany({
    where: { userId, deletedAt: null },
    orderBy: [{ nextDueOn: { sort: "asc", nulls: "last" } }, { name: "asc" }, { id: "asc" }],
  })
}

/**
 * Optimistic-concurrency update: applies only if the rule is this user's, live, and still at `expectedVersion`, and
 * bumps `version`. Otherwise throws NotFoundError (not this user's, or deleted) or RuleVersionConflictError carrying the
 * stored row; the conflict is only ever reported for a rule the user owns. A changed node must be the user's too.
 * `nextDueOn` and `pausedAt` are the sweep's and the pause control's, not part of the rule's definition. For these
 * `undefined` leaves a column alone and `null` clears it. `uow` as for `insertRule`.
 */
export async function updateRule(
  userId: string,
  id: string,
  expectedVersion: number,
  changes: Partial<RuleData> & { nextDueOn?: CalendarDate | null; pausedAt?: Date | null },
  uow?: UnitOfWork,
): Promise<RecurringRule> {
  const write = async (tx: Prisma.TransactionClient) => {
    const nodeIds = [changes.fromNodeId, changes.toNodeId].filter((n): n is string => n !== undefined)
    await assertNodesOwned(userId, nodeIds, tx)
    const { count } = await tx.recurringRule.updateMany({
      where: { id, userId, version: expectedVersion, deletedAt: null },
      // Field by field, never a spread: an extra key on `changes` (the types are gone at runtime) must not reach a column.
      data: {
        name: changes.name,
        fromNodeId: changes.fromNodeId,
        toNodeId: changes.toNodeId,
        amountPaise: changes.amountPaise,
        note: changes.note,
        tags: changes.tags,
        frequency: changes.frequency,
        interval: changes.interval,
        dayOfMonth: changes.dayOfMonth,
        dayOfWeek: changes.dayOfWeek,
        startDate: changes.startDate === undefined ? undefined : toDbDate(changes.startDate),
        endDate: optionalDate(changes.endDate),
        occurrenceLimit: changes.occurrenceLimit,
        autoPost: changes.autoPost,
        nextDueOn: optionalDate(changes.nextDueOn),
        pausedAt: changes.pausedAt,
        version: { increment: 1 },
      },
    })
    if (count === 0) {
      const current = await tx.recurringRule.findFirst({ where: { id, userId, deletedAt: null } })
      if (!current) throw new NotFoundError("rule")
      throw new RuleVersionConflictError(current)
    }
    return tx.recurringRule.findFirstOrThrow({ where: { id, userId } })
  }
  return uow ? write(clientOf(uow)) : prisma.$transaction(write)
}

/**
 * Soft-delete a rule and delete its PENDING occurrences, together: what was already posted or dismissed stays as the
 * record of what happened. Throws NotFoundError if the rule is not this user's, or is already deleted.
 */
export async function softDeleteRule(userId: string, id: string, uow: UnitOfWork): Promise<void> {
  const db = clientOf(uow)
  const { count } = await db.recurringRule.updateMany({
    where: { id, userId, deletedAt: null },
    data: { deletedAt: new Date(), version: { increment: 1 } },
  })
  if (count === 0) throw new NotFoundError("rule")
  await db.recurringOccurrence.deleteMany({ where: { userId, ruleId: id, status: "PENDING" } })
}

/**
 * Hold a live rule until the caller's transaction ends (`SELECT ... FOR UPDATE`) and return it as it is then, or null
 * if it is not this user's or is deleted. Whatever generates a rule's occurrences takes this first, so the hourly sweep
 * and a login cannot both advance the same rule from the same state. The row is read again through Prisma after the
 * lock is taken, which spares a raw row's types (enums, bigint, dates) being mapped by hand.
 */
export async function lockRule(userId: string, id: string, uow: UnitOfWork): Promise<RecurringRule | null> {
  const db = clientOf(uow)
  const locked = await db.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "RecurringRule" WHERE "id" = ${id} AND "userId" = ${userId} AND "deletedAt" IS NULL FOR UPDATE`
  if (locked.length === 0) return null
  return db.recurringRule.findFirst({ where: { id, userId, deletedAt: null } })
}

/** Live, unpaused rules whose next due day is on or before `through`, soonest first. */
export function findDueRules(userId: string, through: CalendarDate, uow?: UnitOfWork): Promise<RecurringRule[]> {
  return dbOf(uow).recurringRule.findMany({
    where: { userId, deletedAt: null, pausedAt: null, nextDueOn: { lte: toDbDate(through) } },
    orderBy: [{ nextDueOn: "asc" }, { id: "asc" }],
  })
}

/**
 * The ids of the users that have a live, unpaused rule due on or before `through`. This is the one query in this file
 * that is deliberately NOT scoped to a user: the hourly sweep has to learn whom to run for, and it returns user ids only,
 * never a row. Every other read the sweep then makes is per user, through the functions above. Rules are few, so the
 * (userId, nextDueOn) index, which leads with the user, is adequate for this scan.
 */
export async function findUsersWithRulesDueBy(through: CalendarDate): Promise<string[]> {
  const rows = await prisma.recurringRule.findMany({
    where: { deletedAt: null, pausedAt: null, nextDueOn: { lte: toDbDate(through) } },
    distinct: ["userId"],
    select: { userId: true },
    orderBy: { userId: "asc" },
  })
  return rows.map((row) => row.userId)
}

/**
 * Write one PENDING occurrence per due day that the rule does not already have, and return exactly the rows this call
 * inserted. Two overlapping calls (the sweep and a login) each get back only their own inserts, so every day is handed
 * to exactly one of them: it is one `INSERT ... ON CONFLICT ("ruleId", "dueOn") DO NOTHING RETURNING`, and a conflicting
 * row inserted by a transaction still open makes this one wait for its outcome rather than guess. Ids are generated by
 * the database (`gen_random_uuid()`), since Prisma's cuid default only exists in its client. Throws NotFoundError if the
 * rule is not this user's live rule. Rows come back oldest due day first.
 */
export async function insertOccurrences(
  userId: string,
  ruleId: string,
  dueOns: CalendarDate[],
  uow: UnitOfWork,
): Promise<RecurringOccurrence[]> {
  const db = clientOf(uow)
  await assertRuleLive(userId, ruleId, db)
  // Sorted and distinct: concurrent callers then take their row locks in the same order and cannot deadlock.
  const days = [...new Set(dueOns)].sort()
  if (days.length === 0) return []
  const rows = await db.$queryRaw<RecurringOccurrence[]>`
    INSERT INTO "RecurringOccurrence" ("id", "userId", "ruleId", "dueOn")
    SELECT gen_random_uuid()::text, ${userId}::text, ${ruleId}::text, due
      FROM unnest(${days}::date[]) WITH ORDINALITY AS d(due, position)
     ORDER BY position
    ON CONFLICT ("ruleId", "dueOn") DO NOTHING
    RETURNING "id", "userId", "ruleId", "dueOn", "status"::text AS "status", "transactionId", "postFailure", "resolvedAt", "createdAt"`
  return rows.sort((x, y) => x.dueOn.getTime() - y.dueOn.getTime())
}

/** How many occurrences, in any state, the rule has. `uow`, when given, reads inside the caller's transaction. */
export function countOccurrences(userId: string, ruleId: string, uow?: UnitOfWork): Promise<number> {
  return dbOf(uow).recurringOccurrence.count({ where: { userId, ruleId } })
}

/** The occurrence with its rule, in any state, or null if it is not this user's. */
export function findOccurrenceById(userId: string, id: string, uow?: UnitOfWork): Promise<OccurrenceWithRule | null> {
  return dbOf(uow).recurringOccurrence.findFirst({ where: { id, userId }, include: { rule: true } })
}

/** The inbox: pending occurrences of live rules, oldest due first. */
export function findPending(userId: string): Promise<OccurrenceWithRule[]> {
  return prisma.recurringOccurrence.findMany({
    where: { userId, status: "PENDING", rule: { is: { userId, deletedAt: null } } },
    include: { rule: true },
    orderBy: [{ dueOn: "asc" }, { id: "asc" }],
  })
}

export function countPending(userId: string): Promise<number> {
  return prisma.recurringOccurrence.count({ where: { userId, status: "PENDING", rule: { is: { userId, deletedAt: null } } } })
}

/**
 * Posted and dismissed occurrences, the most recently resolved first. Those of a deleted rule are history and are
 * included, unless `liveRulesOnly` (the screen lists only what can still be acted on).
 */
export function findRecentlyHandled(userId: string, limit: number, liveRulesOnly = false): Promise<OccurrenceWithRule[]> {
  const take = Number.isFinite(limit) ? Math.max(Math.trunc(limit), 1) : 1
  return prisma.recurringOccurrence.findMany({
    where: { userId, status: { in: ["POSTED", "DISMISSED"] }, ...(liveRulesOnly ? { rule: { is: { userId, deletedAt: null } } } : {}) },
    include: { rule: true },
    orderBy: [{ resolvedAt: { sort: "desc", nulls: "last" } }, { id: "desc" }],
    take,
  })
}

// The three state changes are each one conditional UPDATE ... WHERE status = <expected>, so two callers racing on the
// same occurrence cannot both succeed: the second finds the status changed and gets null. `uow`, when given, makes the
// change inside the caller's transaction, which is how a post is recorded with the transaction it created.

/**
 * PENDING -> POSTED, linked to `transactionId`, which must be this user's (NotFoundError otherwise). Clears
 * `postFailure` and stamps `resolvedAt`. Null if the occurrence is not this user's or is not pending.
 */
export async function markPosted(
  userId: string,
  id: string,
  transactionId: string,
  uow?: UnitOfWork,
): Promise<RecurringOccurrence | null> {
  const db = dbOf(uow)
  if ((await db.transaction.count({ where: { id: transactionId, userId } })) !== 1) throw new NotFoundError("transaction")
  const { count } = await db.recurringOccurrence.updateMany({
    where: { id, userId, status: "PENDING" },
    data: { status: "POSTED", transactionId, postFailure: null, resolvedAt: new Date() },
  })
  return count === 0 ? null : db.recurringOccurrence.findFirst({ where: { id, userId } })
}

/** PENDING -> DISMISSED, stamping `resolvedAt`. Null if the occurrence is not this user's or is not pending. */
export async function markDismissed(userId: string, id: string, uow?: UnitOfWork): Promise<RecurringOccurrence | null> {
  const db = dbOf(uow)
  const { count } = await db.recurringOccurrence.updateMany({
    where: { id, userId, status: "PENDING" },
    data: { status: "DISMISSED", resolvedAt: new Date() },
  })
  return count === 0 ? null : db.recurringOccurrence.findFirst({ where: { id, userId } })
}

/** DISMISSED -> PENDING, put back in the inbox. Null if the occurrence is not this user's or is not dismissed. */
export async function markPending(userId: string, id: string, uow?: UnitOfWork): Promise<RecurringOccurrence | null> {
  const db = dbOf(uow)
  const { count } = await db.recurringOccurrence.updateMany({
    where: { id, userId, status: "DISMISSED" },
    data: { status: "PENDING", resolvedAt: null, postFailure: null },
  })
  return count === 0 ? null : db.recurringOccurrence.findFirst({ where: { id, userId } })
}

/** Why an auto-post did not happen (or null to clear it). Only a PENDING occurrence has one; others are left alone. */
export async function setPostFailure(userId: string, id: string, text: string | null, uow?: UnitOfWork): Promise<void> {
  await dbOf(uow).recurringOccurrence.updateMany({ where: { id, userId, status: "PENDING" }, data: { postFailure: text } })
}
