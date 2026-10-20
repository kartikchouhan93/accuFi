import type { Metadata } from "next"
import { AppShell } from "@/app/app-shell"
import { redirectIfUnauthenticated } from "@/server/action-support"
import { requireUserId } from "@/server/auth"
import { loadTransactionScreen } from "@/server/services/transaction-list"
import { TransactionWorkspace } from "./transaction-workspace"

export const metadata: Metadata = { title: "Transactions" }

// The filters are the URL's search parameters; the server reads them, the ledger and the first page of entries, and hands
// the client plain data: money is paise text, never a bigint, which JSON cannot carry.
export default async function TransactionsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const raw = await searchParams
  // One value per name: a repeated parameter (?kind=A&kind=B) is a hand-edited URL, and the first value is as good as any.
  const query = Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, Array.isArray(value) ? value[0] : value]))
  let screen: Awaited<ReturnType<typeof loadTransactionScreen>>
  try {
    screen = await loadTransactionScreen(await requireUserId(), query)
  } catch (error) {
    redirectIfUnauthenticated(error) // the route guard normally catches a missing session first; a deleted user's it cannot
    throw error
  }
  return (
    <AppShell current="transactions">
      <TransactionWorkspace screen={screen} />
    </AppShell>
  )
}
