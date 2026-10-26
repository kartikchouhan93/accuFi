import type { Metadata } from "next"
import { AppShell } from "@/app/app-shell"
import type { Portfolio } from "@/lib/investment-view"
import { redirectIfUnauthenticated } from "@/server/action-support"
import { requireUserId } from "@/server/auth"
import { todayFor } from "@/server/services/clock"
import { loadPortfolio } from "@/server/services/investment-service"
import type { PriceTarget } from "./price-form"
import { PricesWorkspace } from "./prices-workspace"

export const metadata: Metadata = { title: "Record prices" }

// Entering prices: the server reads the portfolio (for which investments take a price, and in what unit) and the user's
// today (the latest day a price may have), and hands the client plain data. An investment is chosen with a select, so its
// id never goes into the URL; its prices are read when it is chosen (getHoldingAction).
//
// Only an investment revalued by a price is offered: one held by quantity or as a lump. One valued by what was put into it
// has no price (EC-28). An archived one is not offered either: it is out of use, as it is out of every other picker, and
// the investments screen lists it only on request. It is still valued by the prices it has.
export default async function PricesPage() {
  let data: Awaited<ReturnType<typeof load>>
  try {
    data = await load(await requireUserId())
  } catch (error) {
    redirectIfUnauthenticated(error) // the route guard normally catches a missing session first; a deleted user's it cannot
    throw error
  }
  return (
    <AppShell current="investments">
      <PricesWorkspace {...data} />
    </AppShell>
  )
}

async function load(userId: string) {
  const [portfolio, today] = await Promise.all([loadPortfolio(userId), todayFor(userId)])
  return { targets: targetsOf(portfolio), contributionOnly: portfolio.holdings.filter((h) => h.valuationMode === "CONTRIBUTION_ONLY").length, today }
}

function targetsOf(portfolio: Portfolio): PriceTarget[] {
  return portfolio.holdings
    .filter((holding) => !holding.archived && (holding.valuationMode === "QUANTITY" || holding.valuationMode === "LUMP"))
    .map((holding) => ({
      nodeId: holding.nodeId,
      name: holding.name,
      unit: holding.unitLabel || null,
      lump: holding.valuationMode === "LUMP",
      quantityHeld: holding.quantityHeld,
      needsQuantity: holding.notValued === "NEEDS_QUANTITY",
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}
