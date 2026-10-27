import type { LedgerNode } from "@prisma/client"
import type { CalendarDate } from "../domain/calendar-date"
import type { Bucket } from "../domain/periods"
import type { CashFlow, FlowNode, Ranked, RankedRow } from "../domain/reports"
import type { Drill } from "./report-drill"
import { serialisePaise } from "./serialise"

// What the report screens are made of, in a shape that can cross to the browser: money as paise text, days as
// CalendarDate, never a bigint or a Date. Built from the domain's report functions (src/domain/reports.ts), which are the
// only arithmetic: this file renames, serialises and attaches the drill-through each figure leads to. It imports nothing
// from the server, so the tests of a view need no database. Sections: shared range and nodes, flow reports (cash flow,
// spending and income).

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
