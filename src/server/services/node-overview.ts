import { buildNodeOverview, type NodeOverview } from "@/lib/node-overview"
import { sumBalances } from "@/server/repositories/transaction-repository"
import { listAllNodes } from "@/server/services/node-service"

/**
 * The ledger screen's data: every node of the user (archived included, hiding them is the screen's choice) with its
 * balance, the total per kind, and net worth. Safe to hand to a client component: no bigint, no Date.
 */
export async function loadNodeOverview(userId: string): Promise<NodeOverview> {
  const [nodes, balances] = await Promise.all([listAllNodes(userId), sumBalances(userId)])
  return buildNodeOverview(nodes, balances)
}
