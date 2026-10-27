import { compareDates, type CalendarDate } from "@/domain/calendar-date"
import { clipToHistory, monthBuckets, resolveRange, type RangeChoice } from "@/domain/periods"
import { cashFlow, rankFlows } from "@/domain/reports"
import {
  buildCashFlowView,
  buildRankedView,
  toFlowNodes,
  type CashFlowView,
  type RangeView,
  type RankedView,
} from "@/lib/report-view"
import {
  countLiveTransactionsAfter,
  findFirstTransactionDate,
  findMoves,
} from "@/server/repositories/report-repository"
import { findFinancialYearStartMonth } from "@/server/repositories/user-repository"
import { todayFor } from "@/server/services/clock"
import { listAllNodes } from "@/server/services/node-service"

// What the report screens read. Each loader reads the user's settings, resolves the range the person chose (a bad one
// throws ReportRangeError for the page to show), asks the repository for the moves and hands them to the domain's report
// functions, which are the only arithmetic. A report never reaches past today (EC-10): the entries it leaves out are
// counted so the screen can say so. Sections: shared range, flow reports.

// -- Shared ---------------------------------------------------------------------------------------------------------------

async function settingsFor(userId: string): Promise<{ today: CalendarDate; fyStartMonth: number }> {
  const [today, fyStartMonth] = await Promise.all([todayFor(userId), findFinancialYearStartMonth(userId)])
  return { today, fyStartMonth }
}

/** How many live entries a report ending on `to` leaves out because they are dated later; only a range ending today has any. */
async function futureCountFor(userId: string, to: CalendarDate, today: CalendarDate): Promise<number> {
  return compareDates(to, today) === 0 ? countLiveTransactionsAfter(userId, today) : 0
}

// -- Flow reports: cash flow, spending, income -----------------------------------------------------------------------------

const FLOW_KINDS: ["INCOME_SOURCE", "EXPENSE"] = ["INCOME_SOURCE", "EXPENSE"]

/**
 * Income, spending and what was saved, per month and over the range. A range that begins before the user's first entry
 * starts at that entry's month, and `range.historyBegins` says so. `empty` only when the user has no live entry at all.
 */
export async function loadCashFlow(userId: string, choice: RangeChoice): Promise<CashFlowView> {
  const { today, fyStartMonth } = await settingsFor(userId)
  const resolved = resolveRange(choice, today, fyStartMonth)
  const first = await findFirstTransactionDate(userId)
  const clipped = clipToHistory(resolved, first)
  const range: RangeView = {
    from: clipped.from,
    to: clipped.to,
    clampedToToday: resolved.clampedToToday,
    historyBegins: clipped.historyBegins,
    futureCount: await futureCountFor(userId, clipped.to, today),
  }
  if (first === null) return buildCashFlowView({ range, empty: true, flow: cashFlow([], [], []) })

  const buckets = monthBuckets(clipped)
  const [nodes, moves] = await Promise.all([
    listAllNodes(userId, FLOW_KINDS),
    findMoves(userId, { from: clipped.from, to: clipped.to, bucket: "month", kinds: FLOW_KINDS }),
  ])
  return buildCashFlowView({ range, empty: false, flow: cashFlow(buckets, toFlowNodes(nodes), moves) })
}

/** Income sources or expenses ranked over the range, with their children, shares and refunds. Not clipped to history. */
export async function loadRanked(userId: string, choice: RangeChoice, kind: "INCOME_SOURCE" | "EXPENSE"): Promise<RankedView> {
  const { today, fyStartMonth } = await settingsFor(userId)
  const resolved = resolveRange(choice, today, fyStartMonth)
  const first = await findFirstTransactionDate(userId)
  const range: RangeView = {
    from: resolved.from,
    to: resolved.to,
    clampedToToday: resolved.clampedToToday,
    historyBegins: null,
    futureCount: await futureCountFor(userId, resolved.to, today),
  }
  const [nodes, moves] = await Promise.all([
    listAllNodes(userId, [kind]),
    first === null ? [] : findMoves(userId, { from: resolved.from, to: resolved.to, bucket: "month", kinds: [kind] }),
  ])
  return buildRankedView({ range, empty: first === null, kind, ranked: rankFlows(kind, toFlowNodes(nodes), moves) })
}
