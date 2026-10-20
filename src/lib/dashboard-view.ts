import type { LedgerNode, Transaction } from "@prisma/client"
import { fromDbDate, type CalendarDate } from "../domain/calendar-date"
import type { NodeBalance } from "../domain/balance"
import type { LedgerKind } from "../domain/ledger-kind"
import type { Paise } from "../domain/money"
import { HOLDING_KINDS, KIND_ORDER } from "./node-kinds"
import { buildNodeOverview } from "./node-overview"
import { serialisePaise } from "./serialise"

// What the dashboard is made of, in a shape that can cross to the browser: money as paise text, days as CalendarDate,
// never a bigint or a Date. The figures come from `buildNodeOverview`, so the dashboard and the ledger screen share one
// net worth calculation and cannot disagree. As there, every total is computed from EVERY node, archived ones included;
// which rows are listed is decided afterwards and changes no figure (EC-32).

export interface DashboardAccount {
  id: string
  name: string
  kind: LedgerKind
  /** Signed paise: a card you owe on is negative. Describe it with `describeBalance`, which negates it once. */
  balance: string
}

export interface DashboardKindTotal {
  kind: LedgerKind
  /** The sum of every node of the kind, archived included. */
  total: string
  archivedCount: number
}

export interface DashboardTransaction {
  id: string
  fromName: string
  toName: string
  amountPaise: string
  occurredAt: CalendarDate
  note: string | null
}

export interface DashboardView {
  netWorth: {
    assets: string
    investments: string
    /** The positive magnitude owed: the total has already subtracted it. */
    liabilities: string
    total: string
    /** True when an investment could not be valued and is left out of `total`: the figure is incomplete and must say so. */
    isPartial: boolean
    unvaluedNodeIds: string[]
    /** The same investments by name (an archived one is not in `accounts`, so the screen could not look it up). */
    unvaluedNames: string[]
    /** How many accounts, investments and liabilities are archived: counted in the figures, not listed. */
    archivedCount: number
  }
  /** The live (not archived) accounts, investments and liabilities of the user, in the order the ledger shows them. */
  accounts: DashboardAccount[]
  /** One entry per holding kind, in the same order, with the total over archived nodes too. */
  kindTotals: DashboardKindTotal[]
  /** What net worth will be once everything already dated after today has happened; null when nothing is. */
  projected: { total: string; asOf: CalendarDate } | null
  /** The newest transactions up to today, newest first. */
  recent: DashboardTransaction[]
  /** No account, investment or liability exists yet (archived ones count): there is nothing to total, so say how to start. */
  isEmpty: boolean
}

export interface DashboardInput {
  /** Every node, archived included. */
  nodes: readonly LedgerNode[]
  /** Balances as of today, for every node. */
  current: readonly NodeBalance[]
  /** Balances with no upper bound on the date, for every node: what `current` becomes once future entries land. */
  all: readonly NodeBalance[]
  recent: readonly Transaction[]
  /** The date of the furthest transaction, when any is dated after today. */
  latestDate: CalendarDate | null
  /** An investment mapped to `null` cannot be valued. Nothing supplies these in M1; the dashboard must not hide it when something does. */
  valuations?: ReadonlyMap<string, Paise | null>
}

function differ(current: readonly NodeBalance[], all: readonly NodeBalance[]): boolean {
  const before = new Map(current.map((row) => [row.nodeId, row.balance]))
  return all.some((row) => (before.get(row.nodeId) ?? 0n) !== row.balance)
}

export function buildDashboard({ nodes, current, all, recent, latestDate, valuations }: DashboardInput): DashboardView {
  const overview = buildNodeOverview(nodes, current, valuations)
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const holdings = nodes.filter((node) => HOLDING_KINDS.has(node.kind) && node.systemRole === null)
  const nameOf = (id: string) => byId.get(id)?.name ?? "an unknown account"
  const kindOrder = (kind: LedgerKind) => (KIND_ORDER as readonly LedgerKind[]).indexOf(kind)

  // Only the display is narrowed to live nodes; the totals above and below were already summed over all of them.
  const accounts = holdings
    .filter((node) => node.archivedAt === null)
    .sort((a, b) => kindOrder(a.kind) - kindOrder(b.kind) || a.name.localeCompare(b.name))
    .map((node) => ({ id: node.id, name: node.name, kind: node.kind, balance: overview.balances[node.id] ?? "0" }))

  const archivedCount = KIND_ORDER.filter((kind) => HOLDING_KINDS.has(kind)).reduce((sum, kind) => sum + overview.kinds[kind].archivedCount, 0)

  const projectsMore = differ(current, all)
  return {
    netWorth: {
      assets: overview.netWorth.assets,
      investments: overview.netWorth.investments,
      liabilities: overview.netWorth.liabilities,
      total: overview.netWorth.total,
      isPartial: overview.netWorth.isPartial,
      unvaluedNodeIds: overview.netWorth.unvaluedNodeIds,
      unvaluedNames: overview.netWorth.unvaluedNodeIds.map(nameOf),
      archivedCount,
    },
    accounts,
    kindTotals: KIND_ORDER.filter((kind) => HOLDING_KINDS.has(kind)).map((kind) => ({
      kind,
      total: overview.kinds[kind].total,
      archivedCount: overview.kinds[kind].archivedCount,
    })),
    projected:
      projectsMore && latestDate !== null
        ? { total: buildNodeOverview(nodes, all, valuations).netWorth.total, asOf: latestDate }
        : null,
    recent: recent.map((row) => ({
      id: row.id,
      fromName: nameOf(row.fromNodeId),
      toName: nameOf(row.toNodeId),
      amountPaise: serialisePaise(row.amountPaise),
      occurredAt: fromDbDate(row.occurredAt),
      note: row.note,
    })),
    isEmpty: holdings.length === 0,
  }
}
