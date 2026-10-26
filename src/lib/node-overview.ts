import type { LedgerNode } from "@prisma/client"
import { netWorth, type NodeBalance } from "../domain/balance"
import { LEDGER_KINDS, type LedgerKind } from "../domain/ledger-kind"
import type { Paise } from "../domain/money"
import type { NotValuedReason, PriceState } from "./investment-view"
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
  /**
   * Paise by node id, for every node in `nodes`. For an investment held by lots, its value (call 6), or "0" when it is not
   * valued: `unvalued` says so, and a screen shows that instead of the figure (EC-23).
   */
  balances: Record<string, string>
  /** The investments that could not be valued, by node id, with why. Empty when every investment has a value. */
  unvalued: Record<string, NotValuedReason>
  /**
   * For each investment whose value rests on a price, the price's day and whether it is stale (EC-24): a screen shows
   * "as of" that day beside the value, and a Stale label when it is, so an old price never passes for today's.
   */
  priced: Record<string, PriceState>
  /** For INVESTMENT, the sum of the values in `balances`: a node not valued counts as nothing there and in net worth. */
  kinds: Record<LedgerKind, KindSummary>
  netWorth: {
    total: string
    assets: string
    investments: string
    /** The positive magnitude owed, as `netWorth` reports it: the total already subtracts it. */
    liabilities: string
    /**
     * True when an investment could not be valued and so is NOT in `total`: the figure is a lower bound, and every screen
     * that prints it must say so.
     */
    isPartial: boolean
    /** The investments left out of the total, by node id. Empty unless `isPartial`. */
    unvaluedNodeIds: string[]
    /** The investments counted at a stale price, by node id (archived ones included, as they are in the total). */
    staleNodeIds: string[]
  }
}

/** Why an investment's valuation is what it is, beside `valuations` (`ValuationStates` from the investment service). */
export interface ValuationDetail {
  /** Why each null valuation is null; one with none given is "NO_PRICE". */
  unvalued?: ReadonlyMap<string, NotValuedReason>
  priced?: ReadonlyMap<string, PriceState>
}

/**
 * `nodes` and `balances` must both cover archived nodes. Balances of nodes missing from `nodes` are ignored.
 * `valuations` is what `netWorth` takes: an investment mapped to a value counts at it instead of its balance; one mapped to
 * `null` cannot be valued and is reported, not counted. `detail` says why each null is and dates each price.
 */
export function buildNodeOverview(
  nodes: readonly LedgerNode[],
  balances: readonly NodeBalance[],
  valuations?: ReadonlyMap<string, Paise | null>,
  detail: ValuationDetail = {},
): NodeOverview {
  const kinds = Object.fromEntries(LEDGER_KINDS.map((kind) => [kind, { total: 0n, archivedCount: 0 }])) as Record<
    LedgerKind,
    { total: bigint; archivedCount: number }
  >
  const byNode = new Map(balances.map((row) => [row.nodeId, row.balance]))
  const known = new Set(nodes.map((node) => node.id))
  const balanceStrings: Record<string, string> = {}
  const unvalued: Record<string, NotValuedReason> = {}
  const priced: Record<string, PriceState> = {}

  for (const node of nodes) {
    let balance = byNode.get(node.id) ?? 0n
    // `has`, not truthiness: as in netWorth, a 0n value and a null one both mean something.
    if (node.kind === "INVESTMENT" && valuations?.has(node.id)) {
      const value = valuations.get(node.id) ?? null
      if (value === null) unvalued[node.id] = detail.unvalued?.get(node.id) ?? "NO_PRICE"
      const price = detail.priced?.get(node.id)
      if (value !== null && price) priced[node.id] = { asOf: price.asOf, stale: price.stale }
      balance = value ?? 0n
    }
    balanceStrings[node.id] = serialisePaise(balance)
    kinds[node.kind].total += balance
    if (node.archivedAt !== null) kinds[node.kind].archivedCount += 1
  }

  const worth = netWorth(
    balances.filter((row) => known.has(row.nodeId)),
    valuations,
  )
  return {
    nodes: nodes.map(toNodeView),
    balances: balanceStrings,
    unvalued,
    priced,
    kinds: Object.fromEntries(
      LEDGER_KINDS.map((kind) => [kind, { total: serialisePaise(kinds[kind].total), archivedCount: kinds[kind].archivedCount }]),
    ) as Record<LedgerKind, KindSummary>,
    netWorth: {
      total: serialisePaise(worth.total),
      assets: serialisePaise(worth.assets),
      investments: serialisePaise(worth.investments),
      liabilities: serialisePaise(worth.liabilities),
      isPartial: worth.isPartial,
      unvaluedNodeIds: worth.unvaluedNodeIds,
      staleNodeIds: nodes.filter((node) => priced[node.id]?.stale).map((node) => node.id),
    },
  }
}
