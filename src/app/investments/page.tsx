import type { Metadata } from "next"
import { AppShell } from "@/app/app-shell"
import { toPickerNode } from "@/lib/transaction-list-view"
import { redirectIfUnauthenticated } from "@/server/action-support"
import { requireUserId } from "@/server/auth"
import { todayFor } from "@/server/services/clock"
import { loadPortfolio } from "@/server/services/investment-service"
import { listNodesForPicker } from "@/server/services/node-service"
import { InvestmentsWorkspace } from "./investments-workspace"

export const metadata: Metadata = { title: "Investments" }

// Reads the portfolio on the server (every investment, archived ones included, valued as of today) and hands the client
// plain data: money as paise text, quantities as decimal text. A holding's lots are read when its card is opened
// (getHoldingAction), so nothing here puts an id in the URL. The Sell form's destinations are the user's own accounts and
// liabilities that are still in use: where a sale's money can go (the service checks it again).
export default async function InvestmentsPage() {
  let data: Awaited<ReturnType<typeof load>>
  try {
    data = await load(await requireUserId())
  } catch (error) {
    redirectIfUnauthenticated(error) // the route guard normally catches a missing session first; a deleted user's it cannot
    throw error
  }
  return (
    <AppShell current="investments">
      <InvestmentsWorkspace {...data} />
    </AppShell>
  )
}

async function load(userId: string) {
  const [portfolio, today, accounts] = await Promise.all([
    loadPortfolio(userId),
    todayFor(userId),
    listNodesForPicker(userId, ["ASSET", "LIABILITY"]),
  ])
  return { portfolio, today, destinations: accounts.filter((node) => node.systemRole === null).map(toPickerNode) }
}
