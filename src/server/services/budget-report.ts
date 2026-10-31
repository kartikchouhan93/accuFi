import {
  countedNodeIds,
  evaluateMonths,
  type BudgetSpan,
  type BudgetStatus,
  type MonthFigures,
} from "@/domain/budgets"
import {
  addMonths,
  compareDates,
  daysInMonth,
  fromDbDate,
  monthOf,
  type CalendarDate,
} from "@/domain/calendar-date"
import type { Paise } from "@/domain/money"
import { flowOf } from "@/domain/reports"
import type { BudgetCard, BudgetHistoryRow, BudgetsScreen } from "@/lib/budget-view"
import { transactionsHref } from "@/lib/report-drill"
import { serialisePaise } from "@/lib/serialise"
import { findBudgets } from "@/server/repositories/budget-repository"
import { findMoves } from "@/server/repositories/report-repository"
import { todayFor } from "@/server/services/clock"
import { listAllNodes } from "@/server/services/node-service"

// What the budgets screen and the "needs attention" count read (design §4, §8). Nothing is stored: every figure is
// computed from the live transactions each time, so a backdated expense changes a closed month the moment it is
// recorded. The spend comes from the same `findMoves` + `flowOf` the Spending report uses, summed over the ledger and
// its children, which is also what the Transactions screen totals for the card's drill link: a card's "used" is that
// figure and cannot drift from it. One query serves every budgeted ledger.

interface LedgerEvaluation {
  nodeId: string
  name: string
  archived: boolean
  /** The ledger first, then its counted children: the ids the figure and its drill link are made of. */
  counted: string[]
  /** The children's names only. */
  countedNames: string[]
  spans: BudgetSpan[]
  /** Every budgeted month through the current one, oldest first. */
  rows: MonthFigures[]
}

interface Evaluation {
  today: CalendarDate
  currentMonth: CalendarDate
  /** Earliest start month through the current month, oldest first; empty when no budget has started. */
  months: CalendarDate[]
  hasBudgets: boolean
  ledgers: LedgerEvaluation[]
}

/** The last day of the month `month` is the first of. */
function lastDayOf(month: CalendarDate): CalendarDate {
  return `${month.slice(0, 8)}${String(daysInMonth(month)).padStart(2, "0")}` as CalendarDate
}

async function evaluateAll(userId: string): Promise<Evaluation> {
  const [today, budgetRows, nodes] = await Promise.all([todayFor(userId), findBudgets(userId), listAllNodes(userId, ["EXPENSE"])])
  const currentMonth = monthOf(today)

  const byNode = new Map<string, BudgetSpan[]>()
  for (const row of budgetRows) {
    const span: BudgetSpan = {
      id: row.id,
      nodeId: row.nodeId,
      amountPaise: row.amountPaise,
      startMonth: fromDbDate(row.startMonth),
      endMonth: row.endMonth === null ? null : fromDbDate(row.endMonth),
      rollover: row.rollover,
    }
    byNode.set(row.nodeId, [...(byNode.get(row.nodeId) ?? []), span])
  }

  const nodeById = new Map(nodes.map((node) => [node.id, node]))
  const budgeted = [...byNode.entries()].flatMap(([nodeId, spans]) => {
    const node = nodeById.get(nodeId)
    if (!node) return []
    const counted = countedNodeIds(nodeId, nodes)
    return [{ node, spans, counted }]
  })

  // Budgets that start after the current month have no month to show yet.
  const started = budgeted.flatMap(({ spans }) => spans.map((span) => span.startMonth)).filter((start) => compareDates(start, currentMonth) <= 0)
  if (started.length === 0) {
    const ledgers = budgeted.map(({ node, spans, counted }) => toLedger(node, spans, counted, nodeById, []))
    return { today, currentMonth, months: [], hasBudgets: budgetRows.length > 0, ledgers }
  }
  const earliest = started.reduce((a, b) => (compareDates(a, b) <= 0 ? a : b))

  const moves = await findMoves(userId, {
    from: earliest,
    to: today,
    bucket: "month",
    kinds: ["EXPENSE"],
    nodeIds: [...new Set(budgeted.flatMap(({ counted }) => counted))],
  })
  const flowByNode = new Map<string, Map<CalendarDate, Paise>>()
  for (const move of moves) {
    const month = `${move.bucket}-01` as CalendarDate
    const months = flowByNode.get(move.nodeId) ?? new Map<CalendarDate, Paise>()
    months.set(month, (months.get(month) ?? 0n) + flowOf("EXPENSE", move))
    flowByNode.set(move.nodeId, months)
  }

  const ledgers = budgeted.map(({ node, spans, counted }) => {
    const usedByMonth = new Map<CalendarDate, Paise>()
    for (const id of counted) {
      for (const [month, paise] of flowByNode.get(id) ?? []) usedByMonth.set(month, (usedByMonth.get(month) ?? 0n) + paise)
    }
    return toLedger(node, spans, counted, nodeById, evaluateMonths(spans, usedByMonth, today))
  })

  const months: CalendarDate[] = []
  for (let month = earliest; compareDates(month, currentMonth) <= 0; month = addMonths(month, 1)) months.push(month)
  return { today, currentMonth, months, hasBudgets: true, ledgers }
}

function toLedger(
  node: { id: string; name: string; archivedAt: Date | null },
  spans: BudgetSpan[],
  counted: string[],
  nodeById: ReadonlyMap<string, { name: string }>,
  rows: MonthFigures[],
): LedgerEvaluation {
  return {
    nodeId: node.id,
    name: node.name,
    archived: node.archivedAt !== null,
    counted,
    countedNames: counted.slice(1).map((id) => nodeById.get(id)?.name ?? ""),
    spans,
    rows,
  }
}

const STRAIN: Record<BudgetStatus, number> = { OVER: 0, NEAR: 1, ON_TRACK: 2 }

/** OVER, then NEAR, then ON_TRACK; within each, the larger percent first (none last), then name, then id. */
function byStrain(a: BudgetCard, b: BudgetCard): number {
  if (STRAIN[a.status] !== STRAIN[b.status]) return STRAIN[a.status] - STRAIN[b.status]
  if (a.percentTenths !== b.percentTenths) {
    if (a.percentTenths === null) return 1
    if (b.percentTenths === null) return -1
    return BigInt(a.percentTenths) > BigInt(b.percentTenths) ? -1 : 1
  }
  return a.name.localeCompare(b.name, "en") || a.budgetId.localeCompare(b.budgetId)
}

/** The Transactions screen for the ledgers' spending in the month, through today for the current month. */
function drillFor(counted: string[], month: CalendarDate, today: CalendarDate): string {
  const end = lastDayOf(month)
  return transactionsHref({ node: counted, flow: "spending", from: month, to: compareDates(end, today) < 0 ? end : today })
}

function cardFor(ledger: LedgerEvaluation, figures: MonthFigures, today: CalendarDate): BudgetCard {
  const span = ledger.spans.find((s) => s.id === figures.budgetId)!
  const history: BudgetHistoryRow[] = [...ledger.rows].reverse().map((row) => ({
    month: row.month,
    usedPaise: serialisePaise(row.usedPaise),
    availablePaise: serialisePaise(row.availablePaise),
    status: row.status,
    drillHref: drillFor(ledger.counted, row.month, today),
  }))
  return {
    budgetId: figures.budgetId,
    nodeId: ledger.nodeId,
    name: ledger.name,
    archived: ledger.archived,
    countedNames: ledger.countedNames,
    amountPaise: serialisePaise(figures.capPaise),
    carryPaise: serialisePaise(figures.carryPaise),
    availablePaise: serialisePaise(figures.availablePaise),
    usedPaise: serialisePaise(figures.usedPaise),
    remainingPaise: serialisePaise(figures.remainingPaise),
    percentTenths: figures.percentTenths === null ? null : String(figures.percentTenths),
    status: figures.status,
    projectionPaise: figures.projectionPaise === null ? null : serialisePaise(figures.projectionPaise),
    overAtPace: figures.overAtPace,
    rollover: span.rollover,
    startMonth: span.startMonth,
    endMonth: span.endMonth,
    drillHref: drillFor(ledger.counted, figures.month, today),
    history,
  }
}

/** The cards for `month`: one per budgeted ledger with a span covering it, most strained first. */
function cardsFor(evaluation: Evaluation, month: CalendarDate): BudgetCard[] {
  return evaluation.ledgers
    .flatMap((ledger) => {
      const figures = ledger.rows.find((row) => row.month === month)
      return figures ? [cardFor(ledger, figures, evaluation.today)] : []
    })
    .sort(byStrain)
}

/**
 * The budgets screen for `month` (any day of it; the current month by default). A month before the first budget or
 * after the current month is clamped into the selectable range, not refused. Budgets with no spending still have cards.
 */
export async function loadBudgetsScreen(userId: string, month?: CalendarDate): Promise<BudgetsScreen> {
  const evaluation = await evaluateAll(userId)
  const { months, currentMonth, today } = evaluation

  let selected = month === undefined ? currentMonth : monthOf(month)
  if (months.length > 0) {
    if (compareDates(selected, months[0]) < 0) selected = months[0]
    if (compareDates(selected, currentMonth) > 0) selected = currentMonth
  } else {
    selected = currentMonth
  }

  return {
    today,
    month: selected,
    months,
    cards: cardsFor(evaluation, selected),
    empty: !evaluation.hasBudgets,
  }
}

/** How many budgets are near or over for the current month (design §7: the dashboard's one line). */
export async function loadBudgetAttention(userId: string): Promise<{ near: number; over: number }> {
  const evaluation = await evaluateAll(userId)
  const cards = cardsFor(evaluation, evaluation.currentMonth)
  return {
    near: cards.filter((card) => card.status === "NEAR").length,
    over: cards.filter((card) => card.status === "OVER").length,
  }
}
