import type { PricePoint } from "@/domain/valuation"
import { listPrices } from "@/server/repositories/price-repository"

// The price provider seam (spec §7.4). Valuation reads prices only through a PriceResolver, so a future feed (a gold
// rate API, the AMFI NAV file) implements this same interface, writes snapshots with source FEED, and no valuation code
// changes. The one implementation in M2 reads the snapshot table, where hand-entered prices live.

export interface PriceResolver {
  /** Every known price of one unit of the user's node, in any order; empty for another user's node. */
  pricesFor(userId: string, nodeId: string): Promise<PricePoint[]>
}

export const snapshotPriceResolver: PriceResolver = {
  pricesFor: (userId, nodeId) => listPrices(userId, nodeId),
}
