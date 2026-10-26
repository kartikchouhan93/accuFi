import { NetWorthCard } from "@/app/net-worth-card"
import { HOLDING_KINDS } from "@/lib/node-kinds"
import type { NodeOverview } from "@/lib/node-overview"

// What you own less what you owe, on the ledger screen: the same card as the dashboard, from the server's total, which is
// summed over every node, archived ones included. It is drawn by one component so the two screens cannot disagree about how
// the figure looks or what it says; this file only turns the ledger's overview into the shape that card takes. The ledger
// shows nothing dated in the future, so it has no projection to pass.

export function NetWorth({ overview }: { overview: NodeOverview }) {
  const { netWorth, kinds, nodes } = overview
  const unvaluedNames = nodes.filter((node) => netWorth.unvaluedNodeIds.includes(node.id)).map((node) => node.name)
  const staleNames = nodes.filter((node) => netWorth.staleNodeIds.includes(node.id)).map((node) => node.name)
  const archivedCount = (Object.keys(kinds) as (keyof typeof kinds)[])
    .filter((kind) => HOLDING_KINDS.has(kind))
    .reduce((sum, kind) => sum + kinds[kind].archivedCount - kinds[kind].archivedUnvaluedCount, 0) // an unvalued one is in no figure

  return <NetWorthCard netWorth={{ ...netWorth, unvaluedNames, staleNames, archivedCount }} projected={null} />
}
