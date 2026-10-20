import { buildNodeOverview, type NodeOverview } from "@/lib/node-overview"
import { sumBalances } from "@/server/repositories/transaction-repository"
import { listAllNodes } from "@/server/services/node-service"
import { todayFor } from "@/server/services/transaction-service"

/**
 * The ledger screen's data: every node of the user (archived included, hiding them is the screen's choice) with its
 * balance, the total per kind, and net worth. Safe to hand to a client component: no bigint, no Date.
 *
 * The figures are the CURRENT ones: transactions dated after today in the user's timezone are not in them (EC-10), so
 * a rent payment entered in advance does not lower this month's net worth until its day comes.
 */
export async function loadNodeOverview(userId: string): Promise<NodeOverview> {
  const today = await todayFor(userId)
  const [nodes, balances] = await Promise.all([listAllNodes(userId), sumBalances(userId, today)])
  return buildNodeOverview(nodes, balances)
}
