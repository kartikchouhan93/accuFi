import type { LedgerNode } from "@prisma/client"
import { netWorth, type NodeBalance } from "../domain/balance"
import { LEDGER_KINDS, type LedgerKind } from "../domain/ledger-kind"
import { toNodeView, type NodeView } from "./node-view"
import { serialisePaise } from "./serialise"

// Everything the ledger screen needs, in a shape that can cross to the browser: money as paise strings, never a
// bigint. Built from EVERY node, archived ones included, and the totals are computed here, before the screen decides
// which rows to show. Hiding an archived row is a display choice made later and elsewhere; it must not reach a total
// (EC-32: archiving a card you still owe on must not raise your net worth), so no total below reads a "visible" set.

export interface KindSummary {
  /** The sum of every node of the kind, archived included, as a signed balance in paise (liabilities negative). */
  total: string
  /** How many of the kind are archived: the screen mentions them when it hides their rows. */
  archivedCount: number
}

export interface NodeOverview {
  /** Every node, archived included. The screen filters for display. */
  nodes: NodeView[]
  /** Paise by node id, for every node in `nodes`. */
  balances: Record<string, string>
  kinds: Record<LedgerKind, KindSummary>
  netWorth: {
    total: string
    assets: string
    investments: string
    /** The positive magnitude owed, as `netWorth` reports it: the total already subtracts it. */
    liabilities: string
  }
}

/** `nodes` and `balances` must both cover archived nodes. Balances of nodes missing from `nodes` are ignored. */
export function buildNodeOverview(nodes: readonly LedgerNode[], balances: readonly NodeBalance[]): NodeOverview {
  const kinds = Object.fromEntries(LEDGER_KINDS.map((kind) => [kind, { total: 0n, archivedCount: 0 }])) as Record<
    LedgerKind,
    { total: bigint; archivedCount: number }
  >
  const byNode = new Map(balances.map((row) => [row.nodeId, row.balance]))
  const known = new Set(nodes.map((node) => node.id))
  const balanceStrings: Record<string, string> = {}

  for (const node of nodes) {
    const balance = byNode.get(node.id) ?? 0n
    balanceStrings[node.id] = serialisePaise(balance)
    kinds[node.kind].total += balance
    if (node.archivedAt !== null) kinds[node.kind].archivedCount += 1
  }

  const worth = netWorth(balances.filter((row) => known.has(row.nodeId)))
  return {
    nodes: nodes.map(toNodeView),
    balances: balanceStrings,
    kinds: Object.fromEntries(
      LEDGER_KINDS.map((kind) => [kind, { total: serialisePaise(kinds[kind].total), archivedCount: kinds[kind].archivedCount }]),
    ) as Record<LedgerKind, KindSummary>,
    netWorth: {
      total: serialisePaise(worth.total),
      assets: serialisePaise(worth.assets),
      investments: serialisePaise(worth.investments),
      liabilities: serialisePaise(worth.liabilities),
    },
  }
}
