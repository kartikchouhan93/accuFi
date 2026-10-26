import { buildNodeOverview, type NodeOverview } from "@/lib/node-overview"
import { sumBalances } from "@/server/repositories/transaction-repository"
import { todayFor } from "@/server/services/clock"
import { loadValuationStates } from "@/server/services/investment-service"
import { listAllNodes } from "@/server/services/node-service"

/**
 * The ledger screen's data: every node of the user (archived included, hiding them is the screen's choice) with its
 * balance, the total per kind, and net worth. Safe to hand to a client component: no bigint, no Date.
 *
 * The figures are the CURRENT ones: transactions dated after today in the user's timezone are not in them (EC-10), so
 * a rent payment entered in advance does not lower this month's net worth until its day comes. An investment held by lots
 * is shown and counted at its value today, or as not valued (`unvalued`, EC-23). Reading the nodes overlaps with finding
 * today and summing, rather than waiting for the day first.
 */
export async function loadNodeOverview(userId: string): Promise<NodeOverview> {
  const [nodes, [balances, { valuations, unvalued }]] = await Promise.all([
    listAllNodes(userId),
    todayFor(userId).then((today) => Promise.all([sumBalances(userId, today), loadValuationStates(userId, today)])),
  ])
  return buildNodeOverview(nodes, balances, valuations, unvalued)
}
