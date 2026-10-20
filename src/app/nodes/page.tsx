import type { Metadata } from "next"
import { AppShell } from "@/app/app-shell"
import { redirectIfUnauthenticated } from "@/server/action-support"
import { requireUserId } from "@/server/auth"
import { loadNodeOverview } from "@/server/services/node-overview"
import { NetWorth } from "./net-worth"
import { NodeWorkspace } from "./node-workspace"

export const metadata: Metadata = { title: "Ledger" }

// Reads the whole ledger on the server (archived nodes included, so every total is the true one) and hands the client
// plain data: money is paise text, never a bigint, which JSON cannot carry.
export default async function NodesPage() {
  let overview: Awaited<ReturnType<typeof loadNodeOverview>>
  try {
    overview = await loadNodeOverview(await requireUserId())
  } catch (error) {
    redirectIfUnauthenticated(error) // the route guard normally catches a missing session first; a deleted user's it cannot
    throw error
  }
  return (
    <AppShell>
      <NodeWorkspace overview={overview} netWorth={<NetWorth overview={overview} />} />
    </AppShell>
  )
}
