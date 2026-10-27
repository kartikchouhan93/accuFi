import { addDays, compareDates, daysBetween, type CalendarDate } from "@/domain/calendar-date"
import type { LedgerKind } from "@/domain/ledger-kind"
import {
  clipToHistory,
  dayBuckets,
  monthBuckets,
  resolveRange,
  selectableFinancialYears,
  selectableMonths,
  type RangeChoice,
  type ResolvedRange,
} from "@/domain/periods"
import { cashFlow, rankFlows } from "@/domain/reports"
import {
  buildAccountHistoryView,
  buildCashFlowView,
  buildInvestmentGrowthView,
  buildNetWorthView,
  buildRankedView,
  toAccountRef,
  toFlowNodes,
  type AccountHistoryView,
  type CashFlowView,
  type InvestmentGrowthView,
  type NetWorthReportView,
  type RangeOptions,
  type RangeView,
  type RankedView,
} from "@/lib/report-view"
import { NotFoundError } from "@/server/repositories/errors"
import {
  countLiveTransactionsAfter,
  findFirstTransactionDate,
  findMoves,
  findRealisedByMonth,
} from "@/server/repositories/report-repository"
import { sumBalances } from "@/server/repositories/transaction-repository"
import { findFinancialYearStartMonth } from "@/server/repositories/user-repository"
import { todayFor } from "@/server/services/clock"
import { readValuationInputs, valuationStatesFrom, type ValuationInputs } from "@/server/services/investment-service"
import { listAllNodes } from "@/server/services/node-service"

// What the report screens read. Each loader reads the user's settings, resolves the range the person chose (a bad one
// throws ReportRangeError for the page to show), asks the repository for the moves and hands them to the domain's report
// functions, which are the only arithmetic. A report never reaches past today (EC-10): the entries it leaves out are
// counted so the screen can say so. Sections: shared range, flow reports, balance reports.

// -- Shared ---------------------------------------------------------------------------------------------------------------

interface ReportRange {
  today: CalendarDate
  /** The range as asked for, clamped to today but not clipped to history. */
  resolved: ResolvedRange
  /** The user's first live entry, or null when they have none: the report is then empty. */
  first: CalendarDate | null
  /** What the report covers: `resolved`, clipped to history when asked for, with the entries it leaves out counted. */
  range: RangeView
}

/**
 * Read the user's settings and first entry and resolve the range they chose (a bad one throws ReportRangeError). With
 * `clip`, a range that begins before the user's first entry starts at that entry's month and `historyBegins` says so.
 */
async function resolveReportRange(userId: string, choice: RangeChoice, options: { clip: boolean }): Promise<ReportRange> {
  const [today, fyStartMonth, first] = await Promise.all([todayFor(userId), findFinancialYearStartMonth(userId), findFirstTransactionDate(userId)])
  const resolved = resolveRange(choice, today, fyStartMonth)
  const { from, to, historyBegins } = options.clip ? clipToHistory(resolved, first) : { ...resolved, historyBegins: null }
  // Only a range ending today leaves anything out: the live entries dated after it.
  const futureCount = compareDates(to, today) === 0 ? await countLiveTransactionsAfter(userId, today) : 0
  return { today, resolved, first, range: { from, to, clampedToToday: resolved.clampedToToday, historyBegins, futureCount } }
}

/**
 * What the range pickers offer: every month and every financial year (by the user's own start month) from the month of
 * the user's first live entry to today in their timezone, newest first. Nothing to pick for a user with no entries.
 */
export async function loadRangeOptions(userId: string): Promise<RangeOptions> {
  const [today, fyStartMonth, first] = await Promise.all([todayFor(userId), findFinancialYearStartMonth(userId), findFirstTransactionDate(userId)])
  if (first === null) return { months: [], fys: [], fyStartMonth }
  return { months: selectableMonths(first, today), fys: selectableFinancialYears(first, today, fyStartMonth), fyStartMonth }
}

// -- Flow reports: cash flow, spending, income -----------------------------------------------------------------------------

const FLOW_KINDS: ["INCOME_SOURCE", "EXPENSE"] = ["INCOME_SOURCE", "EXPENSE"]

/**
 * Income, spending and what was saved, per month and over the range. A range that begins before the user's first entry
 * starts at that entry's month, and `range.historyBegins` says so. `empty` only when the user has no live entry at all.
 */
export async function loadCashFlow(userId: string, choice: RangeChoice): Promise<CashFlowView> {
  const { range, first } = await resolveReportRange(userId, choice, { clip: true })
  if (first === null) return buildCashFlowView({ range, empty: true, flow: cashFlow([], [], []) })

  const buckets = monthBuckets(range)
  const [nodes, moves] = await Promise.all([
    listAllNodes(userId, FLOW_KINDS),
    findMoves(userId, { from: range.from, to: range.to, bucket: "month", kinds: FLOW_KINDS }),
  ])
  return buildCashFlowView({ range, empty: false, flow: cashFlow(buckets, toFlowNodes(nodes), moves) })
}

/** Income sources or expenses ranked over the range, with their children, shares and refunds. Not clipped to history. */
export async function loadRanked(userId: string, choice: RangeChoice, kind: "INCOME_SOURCE" | "EXPENSE"): Promise<RankedView> {
  const { range, first } = await resolveReportRange(userId, choice, { clip: false })
  const [nodes, moves] = await Promise.all([
    listAllNodes(userId, [kind]),
    first === null ? [] : findMoves(userId, { from: range.from, to: range.to, bucket: "month", kinds: [kind] }),
  ])
  return buildRankedView({ range, empty: first === null, kind, ranked: rankFlows(kind, toFlowNodes(nodes), moves) })
}

// -- Balance reports: net worth over time, account history, investment growth ----------------------------------------------
// A balance on a day is the balance the day before the range plus the moves since, stepped bucket by bucket. An investment
// held by lots is valued on each bucket's last day at the latest price known by then (EC-25), through the same
// `valuationStatesFrom` the dashboard calls, so a month-end figure is the figure the dashboard showed on that day.

const BALANCE_KINDS: LedgerKind[] = ["ASSET", "INVESTMENT", "LIABILITY"]
const ACCOUNT_KINDS: LedgerKind[] = ["ASSET", "LIABILITY"]

/** Account history is daily for a range of at most this many days, inclusive. */
const MAX_DAILY_DAYS = 93

/**
 * Net worth on the last day of each month of the range (today for the month that contains it). `options.inputs` is the
 * valuation inputs a caller already read (the dashboard), so they are not read twice.
 */
export async function loadNetWorthReport(
  userId: string,
  choice: RangeChoice,
  options: { inputs?: ValuationInputs } = {},
): Promise<NetWorthReportView> {
  const { range, first } = await resolveReportRange(userId, choice, { clip: true })
  if (first === null) {
    return buildNetWorthView({ range, empty: true, buckets: [], openings: [], moves: [], valuations: [], names: new Map() })
  }
  const buckets = monthBuckets(range)
  const [openings, moves, inputs] = await Promise.all([
    sumBalances(userId, addDays(range.from, -1)),
    findMoves(userId, { from: range.from, to: range.to, bucket: "month", kinds: BALANCE_KINDS }),
    options.inputs ?? readValuationInputs(userId),
  ])
  return buildNetWorthView({
    range,
    empty: false,
    buckets,
    openings,
    moves,
    valuations: buckets.map((bucket) => valuationStatesFrom(inputs, bucket.to)),
    names: new Map(inputs.holdings.map(({ node }) => [node.id, node.name])),
  })
}

/**
 * The running balance of one account or liability, by day for a range of 93 days or fewer and by month otherwise. With
 * no `nodeId`, the user's oldest live account. NotFoundError for a node that is not the user's or not an account or a
 * liability.
 */
export async function loadAccountHistory(userId: string, choice: RangeChoice, nodeId: string | undefined): Promise<AccountHistoryView> {
  const [{ range, resolved, first }, nodes] = await Promise.all([
    resolveReportRange(userId, choice, { clip: true }),
    listAllNodes(userId, ACCOUNT_KINDS),
  ])
  const accounts = nodes.flatMap((node) => toAccountRef(node) ?? [])
  const selected =
    nodeId === undefined
      ? (accounts.find((account) => account.kind === "ASSET" && !account.archived) ?? null)
      : accounts.find((account) => account.id === nodeId)
  if (selected === undefined) throw new NotFoundError("node")

  // Decided on the range as asked for, so clipping it to history does not turn a long range into a daily one.
  const granularity = daysBetween(resolved.from, resolved.to) + 1 <= MAX_DAILY_DAYS ? "day" : "month"
  const buckets = granularity === "day" ? dayBuckets(range) : monthBuckets(range)
  const empty = first === null
  if (empty || selected === null) {
    return buildAccountHistoryView({ range, empty, granularity, accounts, selected, buckets, openingPaise: 0n, moves: [] })
  }
  const [openings, moves] = await Promise.all([
    sumBalances(userId, addDays(range.from, -1)),
    findMoves(userId, { from: range.from, to: range.to, bucket: granularity, nodeIds: [selected.id] }),
  ])
  const openingPaise = openings.find((row) => row.nodeId === selected.id)?.balance ?? 0n
  return buildAccountHistoryView({ range, empty, granularity, accounts, selected, buckets, openingPaise, moves })
}

/**
 * What went into the user's investments against what they were worth, at the end of each month, with what sales
 * realised: for the whole portfolio, or for one investment (`nodeId`). NotFoundError for a node that is not one of the
 * user's investments. Archived investments count.
 */
export async function loadInvestmentGrowth(userId: string, choice: RangeChoice, nodeId: string | undefined): Promise<InvestmentGrowthView> {
  const [{ range, first }, investments] = await Promise.all([
    resolveReportRange(userId, choice, { clip: true }),
    listAllNodes(userId, ["INVESTMENT"]),
  ])
  if (nodeId !== undefined && !investments.some((node) => node.id === nodeId)) throw new NotFoundError("node")
  const base = { range, investments, selectedId: nodeId ?? null }
  if (first === null) {
    return buildInvestmentGrowthView({ ...base, empty: true, buckets: [], openings: [], moves: [], valuations: [], realised: [] })
  }
  const buckets = monthBuckets(range)
  const [openings, moves, realised, inputs] = await Promise.all([
    sumBalances(userId, addDays(range.from, -1)),
    findMoves(userId, { from: range.from, to: range.to, bucket: "month", kinds: ["INVESTMENT"] }),
    findRealisedByMonth(userId, range),
    readValuationInputs(userId),
  ])
  return buildInvestmentGrowthView({
    ...base,
    empty: false,
    buckets,
    openings,
    moves,
    valuations: buckets.map((bucket) => valuationStatesFrom(inputs, bucket.to)),
    realised,
  })
}
