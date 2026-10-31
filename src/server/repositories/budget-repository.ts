import type { Budget, Prisma } from "@prisma/client"
import { toDbDate, type CalendarDate } from "@/domain/calendar-date"
import type { Paise } from "@/domain/money"
import { prisma } from "@/server/db"
import { NotFoundError } from "./errors"
import { assertNodesOwned } from "./node-repository"
import { clientOf, type UnitOfWork } from "./unit-of-work"

// The only code that reads or writes Budget rows. Every exported function takes `userId` first and puts it in the
// `where` of every query. A budget is also only ever written against a node the same user owns: the schema cannot
// enforce that, so `insertBudget` checks it. Rows are returned as stored (paise as bigint, DATE columns as Date);
// turning them into CalendarDate is the caller's job, except where a signature here takes one.

export interface BudgetData {
  nodeId: string
  amountPaise: Paise
  /** The first day of the first month the budget applies to. */
  startMonth: CalendarDate
  /** The first day of the last month it applies to; null while it has no end. */
  endMonth: CalendarDate | null
  rollover: boolean
}

export type BudgetChanges = Partial<Pick<BudgetData, "amountPaise" | "endMonth" | "rollover">>

const dbOf = (uow?: UnitOfWork) => (uow ? clientOf(uow) : prisma)

/**
 * Store a budget. Throws NotFoundError("node"), and writes nothing, if the node is not this user's. `uow`, when given, is
 * a transaction the caller already opened: the budget then commits or rolls back with the caller's other writes.
 */
export async function insertBudget(userId: string, data: BudgetData, uow?: UnitOfWork): Promise<Budget> {
  const db = dbOf(uow)
  await assertNodesOwned(userId, [data.nodeId], db)
  return db.budget.create({
    data: {
      userId, // always the caller's; the data has no way to name another
      nodeId: data.nodeId,
      amountPaise: data.amountPaise,
      startMonth: toDbDate(data.startMonth),
      endMonth: data.endMonth === null ? null : toDbDate(data.endMonth),
      rollover: data.rollover,
    },
  })
}

/** The user's budget, or null if it does not exist or is not theirs. `uow`, when given, reads inside the caller's transaction. */
export function findBudgetById(userId: string, id: string, uow?: UnitOfWork): Promise<Budget | null> {
  return dbOf(uow).budget.findFirst({ where: { id, userId } })
}

/** Every budget of the user, ordered by node, then start month. */
export function findBudgets(userId: string, uow?: UnitOfWork): Promise<Budget[]> {
  return dbOf(uow).budget.findMany({ where: { userId }, orderBy: [{ nodeId: "asc" }, { startMonth: "asc" }, { id: "asc" }] })
}

/** The user's budgets on one node, earliest start month first. */
export function findBudgetsForNode(userId: string, nodeId: string, uow?: UnitOfWork): Promise<Budget[]> {
  return dbOf(uow).budget.findMany({ where: { userId, nodeId }, orderBy: [{ startMonth: "asc" }, { id: "asc" }] })
}

/**
 * Change a budget's amount, end month or rollover; its node and start month are not the caller's to move, a budget that
 * must start elsewhere is a new one. For `endMonth` `undefined` leaves the column alone and `null` clears it. One
 * `updateMany` scoped by user, so another user's id matches nothing. Throws NotFoundError("budget") if it matched nothing.
 */
export async function updateBudget(userId: string, id: string, changes: BudgetChanges, uow?: UnitOfWork): Promise<Budget> {
  const write = async (db: Prisma.TransactionClient) => {
    const { count } = await db.budget.updateMany({
      where: { id, userId },
      // Field by field, never a spread: an extra key on `changes` (the types are gone at runtime) must not reach a column.
      data: {
        amountPaise: changes.amountPaise,
        endMonth: changes.endMonth === undefined ? undefined : changes.endMonth === null ? null : toDbDate(changes.endMonth),
        rollover: changes.rollover,
      },
    })
    if (count === 0) throw new NotFoundError("budget")
    return db.budget.findFirstOrThrow({ where: { id, userId } })
  }
  return uow ? write(clientOf(uow)) : prisma.$transaction(write)
}

/** Throws NotFoundError("budget") if the budget does not exist or is not this user's. */
export async function deleteBudget(userId: string, id: string, uow?: UnitOfWork): Promise<void> {
  const { count } = await dbOf(uow).budget.deleteMany({ where: { id, userId } })
  if (count === 0) throw new NotFoundError("budget")
}

/** How many budgets of the user's are on the node, in any months. */
export function countBudgetsNaming(userId: string, nodeId: string, uow?: UnitOfWork): Promise<number> {
  return dbOf(uow).budget.count({ where: { userId, nodeId } })
}

/**
 * Hold the user's ledger node until the caller's transaction ends (`SELECT ... FOR UPDATE`), and say whether it is theirs:
 * false, with nothing locked, if it does not exist or belongs to another user. Whatever creates or revises budgets on a
 * ledger takes this first, so two requests cannot both check that the months are free and then both write overlapping
 * budgets. The check is in code, not in the schema, which is why the writers have to be serialised.
 */
export async function lockLedger(userId: string, nodeId: string, uow: UnitOfWork): Promise<boolean> {
  const locked = await clientOf(uow).$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "LedgerNode" WHERE "id" = ${nodeId} AND "userId" = ${userId} FOR UPDATE`
  return locked.length > 0
}
