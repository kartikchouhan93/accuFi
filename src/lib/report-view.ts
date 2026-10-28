import type { LedgerNode } from "@prisma/client"
import { netWorth, type NodeBalance } from "../domain/balance"
import type { CalendarDate } from "../domain/calendar-date"
import type { LedgerKind } from "../domain/ledger-kind"
import type { Paise } from "../domain/money"
import type { Bucket } from "../domain/periods"
import {
  portfolioPoint,
  stepBalances,
  type CashFlow,
  type FlowNode,
  type GrowthNodePoint,
  type Move,
  type Ranked,
  type RankedRow,
  type Step,
} from "../domain/reports"
import type { NotValuedReason, PriceState } from "./investment-view"
import type { Drill } from "./report-drill"
import { serialisePaise } from "./serialise"

// What the report screens are made of, in a shape that can cross to the browser: money as paise text, days as
// CalendarDate, never a bigint or a Date. Built from the domain's report functions (src/domain/reports.ts) and `netWorth`
// (src/domain/balance.ts), which are the only arithmetic: this file renames, serialises and attaches the drill-through each figure leads to. It imports nothing
// from the server, so the tests of a view need no database. Sections: shared range and nodes, flow reports (cash flow,
// spending and income), balance reports (net worth over time, account history, investment growth).

// -- Shared: the range a report covers, and the nodes it classifies ------------------------------------------------------

export interface RangeView {
  from: CalendarDate
  /** The last day reported on: the end asked for, or today when that is still ahead. */
  to: CalendarDate
  clampedToToday: boolean
  /** Set when the start was moved to the month of the user's first entry; that entry's day. */
  historyBegins: CalendarDate | null
  /** Live entries dated after `to` that no figure includes; 0 unless the range ends today. */
  futureCount: number
}

export interface BucketView {
  /** "YYYY-MM" for a month. */
  key: string
  from: CalendarDate
  to: CalendarDate
  /** The bucket covers only part of its month because the range cuts it short. */
  partial: boolean
}

/** What a report's range pickers offer: every month and financial year from the user's first entry to today, newest first. */
export interface RangeOptions {
  months: { year: number; month: number }[]
  /** Start years of financial years. */
  fys: number[]
  /** The month (1–12) the user's financial year starts in; 4 (April) when not given. */
  fyStartMonth?: number
}

function toBucketView(bucket: Bucket): BucketView {
  return { key: bucket.key, from: bucket.from, to: bucket.to, partial: bucket.partial }
}

/** The income-source and expense nodes of a user as the report functions take them; every other kind is not a flow. */
export function toFlowNodes(nodes: readonly LedgerNode[]): FlowNode[] {
  return nodes.flatMap((node): FlowNode[] =>
    node.kind === "INCOME_SOURCE" || node.kind === "EXPENSE"
      ? [{ id: node.id, name: node.name, kind: node.kind, parentId: node.parentId, systemRole: node.systemRole, archived: node.archivedAt !== null }]
      : [],
  )
}

// -- Flow reports: cash flow, spending, income -----------------------------------------------------------------------------

export interface CashFlowView {
  range: RangeView
  /** The user has no live transaction at all: there is nothing to chart, and `buckets` is empty. */
  empty: boolean
  buckets: {
    bucket: BucketView
    incomePaise: string
    spendingPaise: string
    savedPaise: string
    incomeDrill: Drill
    spendingDrill: Drill
  }[]
  totals: {
    incomePaise: string
    spendingPaise: string
    savedPaise: string
    gainPaise: string
    lossPaise: string
    incomeDrill: Drill
    spendingDrill: Drill
  }
}

export function buildCashFlowView(input: { range: RangeView; empty: boolean; flow: CashFlow }): CashFlowView {
  const { range, flow } = input
  return {
    range,
    empty: input.empty,
    buckets: flow.buckets.map((row) => ({
      bucket: toBucketView(row.bucket),
      incomePaise: serialisePaise(row.incomePaise),
      spendingPaise: serialisePaise(row.spendingPaise),
      savedPaise: serialisePaise(row.savedPaise),
      incomeDrill: { flow: "income", from: row.bucket.from, to: row.bucket.to },
      spendingDrill: { flow: "spending", from: row.bucket.from, to: row.bucket.to },
    })),
    totals: {
      incomePaise: serialisePaise(flow.incomePaise),
      spendingPaise: serialisePaise(flow.spendingPaise),
      savedPaise: serialisePaise(flow.savedPaise),
      gainPaise: serialisePaise(flow.gainPaise),
      lossPaise: serialisePaise(flow.lossPaise),
      incomeDrill: { flow: "income", from: range.from, to: range.to },
      spendingDrill: { flow: "spending", from: range.from, to: range.to },
    },
  }
}

export interface RankedRowView {
  id: string
  name: string
  /** Its own flow plus its children's. */
  paise: string
  /** Its own flow alone. */
  directPaise: string
  /** Tenths of a percent of the total (852 is 85.2%); null for a child, a refund, or when there is no total. */
  shareTenths: number | null
  archived: boolean
  /** Realised Gain / Realised Loss: it came from selling an investment. */
  fromSales: boolean
  /** The entries the row is made of: the node itself and its children. */
  drill: Drill
  children: RankedRowView[]
}

export interface RankedView {
  range: RangeView
  empty: boolean
  kind: "INCOME_SOURCE" | "EXPENSE"
  rows: RankedRowView[]
  /** Top-level rows whose net amount is negative (money came back). */
  refunds: RankedRowView[]
  totalPaise: string
  totalDrill: Drill
}

function toRankedRowView(row: RankedRow, range: { from: CalendarDate; to: CalendarDate }): RankedRowView {
  return {
    id: row.id,
    name: row.name,
    paise: serialisePaise(row.paise),
    directPaise: serialisePaise(row.directPaise),
    // Tenths of a percent are at most 1000: an exact small integer, not money.
    shareTenths: row.shareTenths === null ? null : Number(row.shareTenths),
    archived: row.archived,
    fromSales: row.fromSales,
    drill: { node: [row.id, ...row.children.map((child) => child.id)], from: range.from, to: range.to },
    children: row.children.map((child) => toRankedRowView(child, range)),
  }
}

export function buildRankedView(input: {
  range: RangeView
  empty: boolean
  kind: "INCOME_SOURCE" | "EXPENSE"
  ranked: Ranked
}): RankedView {
  const { range, ranked } = input
  return {
    range,
    empty: input.empty,
    kind: input.kind,
    rows: ranked.rows.map((row) => toRankedRowView(row, range)),
    refunds: ranked.refunds.map((row) => toRankedRowView(row, range)),
    totalPaise: serialisePaise(ranked.totalPaise),
    totalDrill: { flow: input.kind === "INCOME_SOURCE" ? "income" : "spending", from: range.from, to: range.to },
  }
}

// -- Balance reports: net worth over time, account history, investment growth ----------------------------------------------
// Every balance here is a running balance (`stepBalances`) from the openings the day before the range, so a point is the
// balance on its bucket's last day. Net worth and the value of an investment held by lots come from the same functions the
// dashboard uses: `netWorth` over those balances, with the valuation the service worked out as of each bucket's last day.

/** What `valuationStatesFrom` says of the investments held by lots on one day (its `ValuationStates`, without the server). */
export interface BucketValuation {
  valuations: ReadonlyMap<string, Paise | null>
  unvalued: ReadonlyMap<string, NotValuedReason>
  priced: ReadonlyMap<string, PriceState>
}

/** Node ids in name order, then id, so a list never depends on the order the database returned. */
function sortedByName(ids: Iterable<string>, nameOf: (id: string) => string): string[] {
  return [...ids].sort((a, b) => nameOf(a).localeCompare(nameOf(b), "en") || (a < b ? -1 : a > b ? 1 : 0))
}

/** The closing balance of each node in each bucket, keyed by bucket key then node id. */
function closings(buckets: readonly Bucket[], openings: readonly NodeBalance[], moves: readonly Move[]): Map<string, Map<string, Step>> {
  return stepBalances(buckets, new Map(openings.map((row) => [row.nodeId, row.balance])), moves)
}

export interface NetWorthPointView {
  bucket: BucketView
  /** The day the point is valued on: the bucket's last day. */
  asOf: CalendarDate
  assetsPaise: string
  investmentsPaise: string
  /** The positive amount owed. */
  liabilitiesPaise: string
  totalPaise: string
  /** An investment could not be valued on `asOf` and is left out of the total. */
  partial: boolean
  unvalued: { nodeId: string; name: string; reason: NotValuedReason }[]
  /** Investments counted at a price older than their window on `asOf` (EC-24). */
  staleNames: string[]
  /** Every entry of the month; the other three, the entries touching an account, an investment or a liability. */
  movementDrill: Drill
  assetsDrill: Drill
  investmentsDrill: Drill
  liabilitiesDrill: Drill
}

export interface NetWorthReportView {
  range: RangeView
  /** The user has no live transaction at all: `points` is empty. */
  empty: boolean
  points: NetWorthPointView[]
}

const HOLDING_KIND_SET: ReadonlySet<LedgerKind> = new Set(["ASSET", "INVESTMENT", "LIABILITY"])

export function buildNetWorthView(input: {
  range: RangeView
  empty: boolean
  buckets: readonly Bucket[]
  /** Every node's balance the day before the range (`sumBalances`); its kind and archived flag are what net worth reads. */
  openings: readonly NodeBalance[]
  /** The moves of the holding nodes per bucket. */
  moves: readonly Move[]
  /** The valuation on each bucket's last day, one per bucket in the same order. */
  valuations: readonly BucketValuation[]
  /** Node id to name, for the investments named as not valued or stale. */
  names: ReadonlyMap<string, string>
}): NetWorthReportView {
  const { range, buckets } = input
  if (input.empty) return { range, empty: true, points: [] }
  const holdings = input.openings.filter((row) => HOLDING_KIND_SET.has(row.kind))
  const steps = closings(buckets, holdings, input.moves)
  const nameOf = (id: string) => input.names.get(id) ?? "an unknown investment"

  const points = buckets.map((bucket, index): NetWorthPointView => {
    const state = input.valuations[index]
    const inBucket = steps.get(bucket.key)!
    const balances = holdings.map((row) => ({ ...row, balance: inBucket.get(row.nodeId)?.closingPaise ?? row.balance }))
    const worth = netWorth(balances, state.valuations)
    const drill = (kind?: LedgerKind): Drill => (kind ? { kind, from: bucket.from, to: bucket.to } : { from: bucket.from, to: bucket.to })
    return {
      bucket: toBucketView(bucket),
      asOf: bucket.to,
      assetsPaise: serialisePaise(worth.assets),
      investmentsPaise: serialisePaise(worth.investments),
      liabilitiesPaise: serialisePaise(worth.liabilities),
      totalPaise: serialisePaise(worth.total),
      partial: worth.isPartial,
      unvalued: sortedByName(worth.unvaluedNodeIds, nameOf).map((nodeId) => ({
        nodeId,
        name: nameOf(nodeId),
        reason: state.unvalued.get(nodeId)!,
      })),
      staleNames: sortedByName(
        [...state.priced].filter(([, price]) => price.stale).map(([id]) => id),
        nameOf,
      ).map(nameOf),
      movementDrill: drill(),
      assetsDrill: drill("ASSET"),
      investmentsDrill: drill("INVESTMENT"),
      liabilitiesDrill: drill("LIABILITY"),
    }
  })
  return { range, empty: false, points }
}

export interface AccountRef {
  id: string
  name: string
  kind: "ASSET" | "LIABILITY"
  archived: boolean
}

export interface AccountHistoryView {
  range: RangeView
  empty: boolean
  /** Days for a range of 93 days or fewer as asked for (before it is clipped to history), months otherwise. */
  granularity: "day" | "month"
  /** Every account and liability of the user, archived ones included, oldest first. */
  accounts: AccountRef[]
  /** The account the steps are of; null when the user has none to show. */
  selected: AccountRef | null
  steps: { bucket: BucketView; openingPaise: string; inPaise: string; outPaise: string; closingPaise: string; drill: Drill }[]
}

/** The account-history choice of `node`, or null for a node that is not an account or a liability. */
export function toAccountRef(node: LedgerNode): AccountRef | null {
  return node.kind === "ASSET" || node.kind === "LIABILITY"
    ? { id: node.id, name: node.name, kind: node.kind, archived: node.archivedAt !== null }
    : null
}

export function buildAccountHistoryView(input: {
  range: RangeView
  empty: boolean
  granularity: "day" | "month"
  accounts: AccountRef[]
  selected: AccountRef | null
  buckets: readonly Bucket[]
  /** The selected account's balance the day before the range. */
  openingPaise: Paise
  /** The selected account's moves per bucket. */
  moves: readonly Move[]
}): AccountHistoryView {
  const { range, granularity, accounts, selected } = input
  if (input.empty || selected === null) return { range, empty: input.empty, granularity, accounts, selected, steps: [] }
  const steps = closings(input.buckets, [{ nodeId: selected.id, kind: selected.kind, balance: input.openingPaise, archived: selected.archived }], input.moves)
  return {
    range,
    empty: false,
    granularity,
    accounts,
    selected,
    steps: input.buckets.map((bucket) => {
      const step = steps.get(bucket.key)!.get(selected.id)!
      return {
        bucket: toBucketView(bucket),
        openingPaise: serialisePaise(step.openingPaise),
        inPaise: serialisePaise(step.inPaise),
        outPaise: serialisePaise(step.outPaise),
        closingPaise: serialisePaise(step.closingPaise),
        drill: { node: [selected.id], from: bucket.from, to: bucket.to },
      }
    }),
  }
}

export interface GrowthPointView {
  bucket: BucketView
  asOf: CalendarDate
  /** What is in the investments on `asOf`: their balance. */
  investedPaise: string
  /** What they are worth on `asOf`, over the ones that can be valued; null for a single investment that cannot be (a gap). */
  valuePaise: string | null
  /** Value minus invested over the same valued investments; null with `valuePaise`. */
  gainPaise: string | null
  /** Gain minus loss realised by sales in the bucket. */
  realisedPaise: string
  stale: boolean
  /** For the whole portfolio: how many of the investments are valued. Null for a single investment. */
  covered: { covered: number; total: number } | null
  /** The investments not valued on `asOf`, by name. */
  unvaluedNames: string[]
  drill: Drill
}

export interface InvestmentGrowthView {
  range: RangeView
  empty: boolean
  /** Every investment of the user, archived ones included, oldest first. */
  investments: { id: string; name: string; archived: boolean }[]
  /** Null for the whole portfolio. */
  selected: { id: string; name: string } | null
  points: GrowthPointView[]
}

export function buildInvestmentGrowthView(input: {
  range: RangeView
  empty: boolean
  buckets: readonly Bucket[]
  investments: readonly LedgerNode[]
  /** One of `investments`, or null for the whole portfolio. */
  selectedId: string | null
  /** Every investment's balance the day before the range. */
  openings: readonly NodeBalance[]
  /** The investments' moves per bucket. */
  moves: readonly Move[]
  /** The valuation on each bucket's last day, one per bucket in the same order. */
  valuations: readonly BucketValuation[]
  /** What sales realised per investment and month (`findRealisedByMonth`). */
  realised: readonly { nodeId: string; bucket: string; gainPaise: Paise; lossPaise: Paise }[]
}): InvestmentGrowthView {
  const { range, buckets } = input
  const investments = input.investments.map((node) => ({ id: node.id, name: node.name, archived: node.archivedAt !== null }))
  const chosen = input.selectedId === null ? null : investments.find((node) => node.id === input.selectedId) ?? null
  const selected = chosen && { id: chosen.id, name: chosen.name }
  if (input.empty) return { range, empty: true, investments, selected, points: [] }

  const nodes = chosen ? [chosen] : investments
  const ids = new Set(nodes.map((node) => node.id))
  const names = new Map(nodes.map((node) => [node.id, node.name]))
  const nameById = (id: string) => names.get(id)!
  const openings = input.openings.filter((row) => ids.has(row.nodeId))
  const steps = closings(buckets, openings, input.moves.filter((move) => ids.has(move.nodeId)))
  const realisedIn = (key: string) =>
    input.realised.filter((row) => row.bucket === key && ids.has(row.nodeId)).reduce((sum, row) => sum + row.gainPaise - row.lossPaise, 0n)

  const points = buckets.map((bucket, index): GrowthPointView => {
    const state = input.valuations[index]
    const inBucket = steps.get(bucket.key)!
    const perNode = nodes.map((node): GrowthNodePoint => {
      const investedPaise = inBucket.get(node.id)?.closingPaise ?? 0n
      // As in netWorth: absent from the valuations means valued by what was put in; present and null means not valued.
      const valuePaise = state.valuations.has(node.id) ? state.valuations.get(node.id)! : investedPaise
      return { nodeId: node.id, investedPaise, valuePaise, stale: state.priced.get(node.id)?.stale ?? false }
    })
    const point = portfolioPoint(perNode)
    const single = chosen !== null
    const valued = point.covered > 0 // one investment or the portfolio: with nothing valued there is no value, never ₹0 (EC-23)
    return {
      bucket: toBucketView(bucket),
      asOf: bucket.to,
      investedPaise: serialisePaise(point.investedPaise),
      valuePaise: valued ? serialisePaise(point.valuePaise) : null,
      gainPaise: valued ? serialisePaise(point.gainPaise) : null,
      realisedPaise: serialisePaise(realisedIn(bucket.key)),
      stale: point.stale,
      covered: single ? null : { covered: point.covered, total: point.total },
      unvaluedNames: sortedByName(point.unvaluedNodeIds, nameById).map(nameById),
      // An empty node list is no filter at all (transactionsHref leaves it out), so a user with no investment would be
      // sent to every entry of the month; the investment kind is what the figure is of, and has none of theirs.
      drill:
        nodes.length > 0
          ? { node: nodes.map((node) => node.id), from: bucket.from, to: bucket.to }
          : { kind: "INVESTMENT", from: bucket.from, to: bucket.to },
    }
  })
  return { range, empty: false, investments, selected, points }
}
