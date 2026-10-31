import type { Budget } from "@prisma/client"
import { spansOverlap } from "@/domain/budgets"
import { addMonths, compareDates, fromDbDate, monthOf, type CalendarDate } from "@/domain/calendar-date"
import type { Paise } from "@/domain/money"
import { toBudgetSettingsView, spanLabel, type BudgetSettingsView } from "@/lib/budget-view"
import {
  deleteBudget as deleteBudgetRow,
  findBudgetById,
  findBudgetsForNode,
  insertBudget,
  lockLedger,
  updateBudget,
} from "@/server/repositories/budget-repository"
import { NotFoundError } from "@/server/repositories/errors"
import { inTransaction, type UnitOfWork } from "@/server/repositories/unit-of-work"
import { todayFor } from "@/server/services/clock"
import { requireNode } from "@/server/services/transaction-service"

// The life of a budget (design §6): create, revise, set the end month or rollover, delete. A budget is a monthly cap for
// a run of months on one expense ledger, and a ledger's spans never share a month. The schema cannot say that (it is a
// rule about several rows), so it is held here: every write takes the ledger's lock FIRST (`lockLedger`), re-reads the
// ledger's spans under it and decides from those, so two requests for one ledger run one after the other and the
// second sees the first. That also makes the overlap rule the double-submit guard for a create: the repeat overlaps
// the span the first made and is refused, so there is no request key. Violations are collected into one error and
// nothing is written when there are any. Months are normalised to the first of the month here as well as in the schema.

export interface BudgetViolation {
  field: "nodeId" | "amount" | "startMonth" | "endMonth" | "appliesFrom"
  message: string
}

/** The budget as submitted is not allowed; each violation names the form field to fix. Nothing was written. */
export class InvalidBudgetError extends Error {
  constructor(readonly violations: BudgetViolation[]) {
    super(violations.map((violation) => violation.message).join(" "))
    this.name = "InvalidBudgetError"
  }
}

export interface BudgetInput {
  nodeId: string
  amount: Paise
  startMonth: CalendarDate
  endMonth?: CalendarDate | null
  rollover: boolean
}

interface Span {
  id: string
  startMonth: CalendarDate
  endMonth: CalendarDate | null
}

const spanOf = (row: Budget): Span => ({
  id: row.id,
  startMonth: fromDbDate(row.startMonth),
  endMonth: row.endMonth === null ? null : fromDbDate(row.endMonth),
})

const labelOf = (span: Span) => spanLabel(span.startMonth, span.endMonth)

const NOT_POSITIVE = "The amount must be greater than zero"
const END_BEFORE_START = "The end month cannot be before the start month"

/** The first other span (not `exceptId`) that shares a month with `span`, if any. */
function overlapping(span: Pick<Span, "startMonth" | "endMonth">, others: readonly Span[], exceptId?: string): Span | undefined {
  return others.find((other) => other.id !== exceptId && spansOverlap(span, other))
}

/**
 * Take the ledger's lock (false means it is not the user's, which is "not found" like any foreign row) and read its
 * spans. Only ever called first inside a transaction, so the spans are what the decision is made from.
 */
async function lockedSpans(userId: string, nodeId: string, uow: UnitOfWork): Promise<Budget[]> {
  if (!(await lockLedger(userId, nodeId, uow))) throw new NotFoundError("node")
  return findBudgetsForNode(userId, nodeId, uow)
}

/**
 * The budget with `id` and the ledger's spans, read under the ledger's lock. The budget is first found outside the
 * transaction only to learn which ledger to lock; it is looked for again among the locked read, so one deleted or
 * changed in between is judged as it now is. Throws NotFoundError("budget").
 */
async function lockedBudget(userId: string, id: string, uow: UnitOfWork): Promise<{ budget: Budget; spans: Budget[] }> {
  const named = await findBudgetById(userId, id, uow)
  if (!named) throw new NotFoundError("budget")
  const spans = await lockedSpans(userId, named.nodeId, uow)
  const budget = spans.find((row) => row.id === id)
  if (!budget) throw new NotFoundError("budget") // deleted while this waited for the lock
  return { budget, spans }
}

/**
 * Create a budget. Refuses a ledger that is not an expense, a system ledger, an archived one, an end before the start
 * and a span sharing a month with another of the ledger's: InvalidBudgetError with every violation, nothing written.
 * NotFoundError("node") for a ledger that is not the user's.
 */
export async function createBudget(userId: string, input: BudgetInput): Promise<BudgetSettingsView> {
  const startMonth = monthOf(input.startMonth)
  const endMonth = input.endMonth ? monthOf(input.endMonth) : null
  return inTransaction(async (uow) => {
    const spans = (await lockedSpans(userId, input.nodeId, uow)).map(spanOf)
    const node = await requireNode(userId, input.nodeId, uow)

    const violations: BudgetViolation[] = []
    if (node.kind !== "EXPENSE") violations.push({ field: "nodeId", message: "Only an expense ledger can have a budget" })
    else if (node.systemRole !== null) violations.push({ field: "nodeId", message: "A system ledger cannot have a budget" })
    else if (node.archivedAt !== null) violations.push({ field: "nodeId", message: "An archived ledger cannot be given a new budget" })
    if (input.amount <= 0n) violations.push({ field: "amount", message: NOT_POSITIVE })
    if (endMonth !== null && compareDates(endMonth, startMonth) < 0) {
      violations.push({ field: "endMonth", message: END_BEFORE_START })
    } else {
      const clash = overlapping({ startMonth, endMonth }, spans)
      if (clash) {
        violations.push({ field: "startMonth", message: `${node.name} already has a budget for ${labelOf(clash)}. Revise it, or pick other months.` })
      }
    }
    if (violations.length > 0) throw new InvalidBudgetError(violations)

    const row = await insertBudget(userId, { nodeId: input.nodeId, amountPaise: input.amount, startMonth, endMonth, rollover: input.rollover }, uow)
    return toBudgetSettingsView(row, node.name)
  })
}

/**
 * Change a budget's amount from `appliesFrom` on. From its start month or earlier the amount is corrected for the whole
 * span, in place (one view). From a later month it splits: the old span ends the month before and a new one starts there
 * with the new amount, the same rollover and the old end (two views: the shortened old span, then the new one). Months
 * after the current month, or after the budget's end, are refused. Works on an archived ledger's budget.
 */
export async function reviseBudget(
  userId: string,
  id: string,
  input: { amount: Paise; appliesFrom: CalendarDate },
): Promise<BudgetSettingsView[]> {
  const appliesFrom = monthOf(input.appliesFrom)
  const currentMonth = monthOf(await todayFor(userId))
  return inTransaction(async (uow) => {
    const { budget } = await lockedBudget(userId, id, uow)
    const { startMonth, endMonth } = spanOf(budget)
    const node = await requireNode(userId, budget.nodeId, uow)

    const violations: BudgetViolation[] = []
    if (input.amount <= 0n) violations.push({ field: "amount", message: NOT_POSITIVE })
    if (compareDates(appliesFrom, currentMonth) > 0) {
      violations.push({ field: "appliesFrom", message: "A new amount can apply from this month or an earlier one, not from a future month" })
    } else if (endMonth !== null && compareDates(appliesFrom, endMonth) > 0) {
      violations.push({ field: "appliesFrom", message: `This budget ended in ${spanLabel(endMonth, endMonth)}. Pick a month it applies to.` })
    }
    if (violations.length > 0) throw new InvalidBudgetError(violations)

    if (compareDates(appliesFrom, startMonth) <= 0) {
      const updated = await updateBudget(userId, id, { amountPaise: input.amount }, uow)
      return [toBudgetSettingsView(updated, node.name)]
    }
    // The old span is shortened first and the new one inserted after it, in this one transaction: nobody sees both.
    const shortened = await updateBudget(userId, id, { endMonth: addMonths(appliesFrom, -1) }, uow)
    const created = await insertBudget(
      userId,
      { nodeId: budget.nodeId, amountPaise: input.amount, startMonth: appliesFrom, endMonth, rollover: budget.rollover },
      uow,
    )
    return [toBudgetSettingsView(shortened, node.name), toBudgetSettingsView(created, node.name)]
  })
}

/**
 * Set or remove a budget's end month and switch its rollover, in place. An end before the start, and an end (or no end)
 * that would run into the ledger's next span, are refused. Works on an archived ledger's budget.
 */
export async function updateBudgetSettings(
  userId: string,
  id: string,
  input: { endMonth: CalendarDate | null; rollover: boolean },
): Promise<BudgetSettingsView> {
  const endMonth = input.endMonth ? monthOf(input.endMonth) : null
  return inTransaction(async (uow) => {
    const { budget, spans } = await lockedBudget(userId, id, uow)
    const { startMonth } = spanOf(budget)
    const node = await requireNode(userId, budget.nodeId, uow)

    const violations: BudgetViolation[] = []
    if (endMonth !== null && compareDates(endMonth, startMonth) < 0) {
      violations.push({ field: "endMonth", message: END_BEFORE_START })
    } else {
      const clash = overlapping({ startMonth, endMonth }, spans.map(spanOf), id)
      if (clash) {
        violations.push({
          field: "endMonth",
          message: `That would run into the budget for ${labelOf(clash)}. End this one before it starts.`,
        })
      }
    }
    if (violations.length > 0) throw new InvalidBudgetError(violations)

    const updated = await updateBudget(userId, id, { endMonth, rollover: input.rollover }, uow)
    return toBudgetSettingsView(updated, node.name)
  })
}

/** Delete a budget; nothing else depends on it. NotFoundError("budget") if it is not the user's or is already gone. */
export async function deleteBudget(userId: string, id: string): Promise<void> {
  await inTransaction(async (uow) => {
    await lockedBudget(userId, id, uow)
    await deleteBudgetRow(userId, id, uow)
  })
}
