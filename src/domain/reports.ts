// Report arithmetic: income and spending over a range, ranked by node, running balances per bucket, and the
// portfolio's invested-versus-value point. Pure: the caller aggregates moves in SQL and passes them in. Like net
// worth, every report classifies by node KIND, never by the sign of an amount, so a refund (a negative spend) lowers
// spending rather than turning into income. The opening-balance pair is bookkeeping, not money the user earned or
// spent, so it is in no figure here; realised gains and losses are, and are told apart so a display can mark them.

import type { Bucket } from "./periods"
import type { Paise } from "./money"
import type { SystemNodeRole } from "./ledger-kind"

type FlowKind = "INCOME_SOURCE" | "EXPENSE"

export interface FlowNode {
  id: string
  name: string
  kind: FlowKind
  parentId: string | null
  systemRole: SystemNodeRole | null
  archived: boolean
}

/** False for the two opening-balance nodes: they seed balances and are never income or spending. */
export function isReportable(node: { systemRole: SystemNodeRole | null }): boolean {
  return node.systemRole !== "OPENING_BALANCE" && node.systemRole !== "OPENING_BALANCE_CONTRA"
}

/** What flowed into and out of one node in one bucket (a bucket key, or any label for a whole-range total). */
export interface Move {
  nodeId: string
  bucket: string
  inPaise: Paise
  outPaise: Paise
}

/** Income is what left the source; spending is what arrived in the expense. A refund makes spending negative. */
export function flowOf(kind: FlowKind, move: { inPaise: Paise; outPaise: Paise }): Paise {
  return kind === "INCOME_SOURCE" ? move.outPaise - move.inPaise : move.inPaise - move.outPaise
}

export interface CashFlowBucket {
  bucket: Bucket
  incomePaise: Paise
  spendingPaise: Paise
  savedPaise: Paise
}

export interface CashFlow {
  buckets: CashFlowBucket[]
  incomePaise: Paise
  spendingPaise: Paise
  savedPaise: Paise
  /** The Realised Gain share of income. */
  gainPaise: Paise
  /** The Realised Loss share of spending. */
  lossPaise: Paise
}

/** Income, spending and what was saved, per bucket and over all of them. Moves outside `buckets` are ignored. */
export function cashFlow(buckets: readonly Bucket[], nodes: readonly FlowNode[], moves: readonly Move[]): CashFlow {
  const nodeById = new Map(nodes.map((n) => [n.id, n]))
  const perBucket = new Map(buckets.map((b) => [b.key, { incomePaise: 0n, spendingPaise: 0n }]))
  let gainPaise = 0n
  let lossPaise = 0n

  for (const move of moves) {
    const node = nodeById.get(move.nodeId)
    const slot = perBucket.get(move.bucket)
    if (!node || !slot || !isReportable(node)) continue
    const flow = flowOf(node.kind, move)
    if (node.kind === "INCOME_SOURCE") {
      slot.incomePaise += flow
      if (node.systemRole === "REALISED_GAIN") gainPaise += flow
    } else {
      slot.spendingPaise += flow
      if (node.systemRole === "REALISED_LOSS") lossPaise += flow
    }
  }

  let incomePaise = 0n
  let spendingPaise = 0n
  const rows = buckets.map((bucket): CashFlowBucket => {
    const slot = perBucket.get(bucket.key)!
    incomePaise += slot.incomePaise
    spendingPaise += slot.spendingPaise
    return { bucket, ...slot, savedPaise: slot.incomePaise - slot.spendingPaise }
  })

  return { buckets: rows, incomePaise, spendingPaise, savedPaise: incomePaise - spendingPaise, gainPaise, lossPaise }
}

export interface RankedRow {
  id: string
  name: string
  /** Its own flow plus its children's. */
  paise: Paise
  /** Its own flow alone. */
  directPaise: Paise
  /**
   * Tenths of a percent of the positive top-level rows' total (852 is 85.2%). Only a top-level row in `rows` has one:
   * null for a refund, for every child (a child can exceed its parent when a sibling refund lowers it), and when
   * there is no total.
   */
  shareTenths: bigint | null
  archived: boolean
  /** True for Realised Gain / Realised Loss: it came from selling an investment, not from a source or a purchase. */
  fromSales: boolean
  children: RankedRow[]
}

export interface Ranked {
  rows: RankedRow[]
  /** Top-level rows whose net amount is negative (money came back), most negative first. */
  refunds: RankedRow[]
  /** The sum of rows and refunds: the same figure cashFlow reports as income or spending. */
  totalPaise: Paise
}

/**
 * `part` as tenths of a percent of `whole`, rounded half up: `part × 1000 ÷ whole`, computed as
 * `(part × 2000 + whole) ÷ (2 × whole)` so it stays exact in bigint. Null when there is no positive whole to take a
 * share of, or the part is negative (a refund has no share).
 */
export function shareTenths(part: Paise, whole: Paise): bigint | null {
  if (whole <= 0n || part < 0n) return null
  return (part * 2000n + whole) / (2n * whole)
}

// Equal amounts fall back to name then id so the order never depends on input order.
function byNameThenId(a: RankedRow, b: RankedRow): number {
  return a.name.localeCompare(b.name, "en") || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}
const byAmount = (a: RankedRow, b: RankedRow) => (a.paise !== b.paise ? (a.paise > b.paise ? -1 : 1) : byNameThenId(a, b))
const byMostNegative = (a: RankedRow, b: RankedRow) => (a.paise !== b.paise ? (a.paise < b.paise ? -1 : 1) : byNameThenId(a, b))

/**
 * Every reportable node of `kind` that has moves, as a tree: a node's `paise` is its own flow plus its children's.
 * A top-level row is a node whose parent is not among those nodes, so a child of a missing or other-kind parent is
 * still shown. Shares are of the positive top-level rows only; refunds stay out of the denominator and have none.
 */
export function rankFlows(kind: FlowKind, nodes: readonly FlowNode[], moves: readonly Move[]): Ranked {
  const eligible = nodes.filter((n) => n.kind === kind && isReportable(n))
  const eligibleIds = new Set(eligible.map((n) => n.id))

  const direct = new Map<string, Paise>()
  for (const move of moves) {
    if (!eligibleIds.has(move.nodeId)) continue
    direct.set(move.nodeId, (direct.get(move.nodeId) ?? 0n) + flowOf(kind, move))
  }

  // Assumes parentId data is acyclic (the schema allows one level only, HierarchyDepthError); a cycle would drop its nodes.
  const childrenOf = new Map<string, FlowNode[]>()
  const topLevel: FlowNode[] = []
  for (const n of eligible) {
    if (n.parentId !== null && eligibleIds.has(n.parentId)) {
      const siblings = childrenOf.get(n.parentId) ?? []
      siblings.push(n)
      childrenOf.set(n.parentId, siblings)
    } else {
      topLevel.push(n)
    }
  }

  // A node with no moves of its own still appears when something beneath it has moves; otherwise it is absent.
  function build(n: FlowNode): RankedRow | null {
    const children = (childrenOf.get(n.id) ?? []).flatMap((c) => build(c) ?? []).sort(byAmount)
    const own = direct.get(n.id)
    if (own === undefined && children.length === 0) return null
    const directPaise = own ?? 0n
    return {
      id: n.id,
      name: n.name,
      paise: children.reduce((sum, c) => sum + c.paise, directPaise),
      directPaise,
      shareTenths: null,
      archived: n.archived,
      fromSales: n.systemRole === "REALISED_GAIN" || n.systemRole === "REALISED_LOSS",
      children,
    }
  }

  const built = topLevel.flatMap((n) => build(n) ?? [])
  const rows = built.filter((r) => r.paise >= 0n).sort(byAmount)
  const refunds = built.filter((r) => r.paise < 0n).sort(byMostNegative)

  const whole = rows.reduce((sum, r) => sum + r.paise, 0n)
  const withShare = (row: RankedRow): RankedRow => ({ ...row, shareTenths: shareTenths(row.paise, whole) })

  return {
    rows: rows.map(withShare),
    refunds,
    totalPaise: whole + refunds.reduce((sum, r) => sum + r.paise, 0n),
  }
}

export interface Step {
  openingPaise: Paise
  inPaise: Paise
  outPaise: Paise
  closingPaise: Paise
}

/**
 * Running balance of each node through the buckets: the first bucket opens on `openings` (zero when absent) and
 * every later one on the previous closing. A node in `openings` or in `moves` has a step in every bucket, so a quiet
 * bucket carries its balance rather than dropping the node. Result: bucket key → node id → step.
 */
export function stepBalances(
  buckets: readonly Bucket[],
  openings: ReadonlyMap<string, Paise>,
  moves: readonly Move[],
): Map<string, Map<string, Step>> {
  const inBucket = new Map<string, Map<string, { inPaise: Paise; outPaise: Paise }>>()
  const nodeIds = new Set(openings.keys())
  for (const move of moves) {
    nodeIds.add(move.nodeId)
    const perNode = inBucket.get(move.bucket) ?? new Map()
    const sum = perNode.get(move.nodeId) ?? { inPaise: 0n, outPaise: 0n }
    perNode.set(move.nodeId, { inPaise: sum.inPaise + move.inPaise, outPaise: sum.outPaise + move.outPaise })
    inBucket.set(move.bucket, perNode)
  }

  const closing = new Map<string, Paise>()
  for (const id of nodeIds) closing.set(id, openings.get(id) ?? 0n)

  const result = new Map<string, Map<string, Step>>()
  for (const bucket of buckets) {
    const steps = new Map<string, Step>()
    for (const id of nodeIds) {
      const openingPaise = closing.get(id)!
      const { inPaise, outPaise } = inBucket.get(bucket.key)?.get(id) ?? { inPaise: 0n, outPaise: 0n }
      const closingPaise = openingPaise + inPaise - outPaise
      steps.set(id, { openingPaise, inPaise, outPaise, closingPaise })
      closing.set(id, closingPaise)
    }
    result.set(bucket.key, steps)
  }
  return result
}

export interface GrowthNodePoint {
  nodeId: string
  investedPaise: Paise
  /** Null when the node could not be valued at that day. */
  valuePaise: Paise | null
  stale: boolean
}

export interface PortfolioPoint {
  /** What was put into every node, valued or not. */
  investedPaise: Paise
  /** What was put into the valued nodes only: the like-with-like figure `valuePaise` is set against. */
  investedValuedPaise: Paise
  valuePaise: Paise
  /** Value minus invested over the valued nodes only: an unvalued node's cost is not set against a missing value. */
  gainPaise: Paise
  covered: number
  total: number
  unvaluedNodeIds: string[]
  stale: boolean
}

/**
 * One day of the portfolio: what was put in (every node, and the valued nodes alone) against what it is worth (the nodes
 * that could be valued). `investedValuedPaise` equals `investedPaise` whenever every node is valued.
 */
export function portfolioPoint(nodes: readonly GrowthNodePoint[]): PortfolioPoint {
  let investedPaise = 0n
  let investedValuedPaise = 0n
  let valuePaise = 0n
  let gainPaise = 0n
  let covered = 0
  let stale = false
  const unvaluedNodeIds: string[] = []

  for (const node of nodes) {
    investedPaise += node.investedPaise
    if (node.valuePaise === null) {
      unvaluedNodeIds.push(node.nodeId)
      continue
    }
    investedValuedPaise += node.investedPaise
    valuePaise += node.valuePaise
    gainPaise += node.valuePaise - node.investedPaise
    covered += 1
    if (node.stale) stale = true
  }

  return { investedPaise, investedValuedPaise, valuePaise, gainPaise, covered, total: nodes.length, unvaluedNodeIds, stale }
}
