import type { Metadata } from "next"
import { AppShell } from "@/app/app-shell"
import { redirectIfUnauthenticated } from "@/server/action-support"
import { requireUserId } from "@/server/auth"
import { loadBatchLabel } from "@/server/services/import-service"
import { loadTransactionScreen } from "@/server/services/transaction-list"
import { TransactionWorkspace, type BatchNotice } from "./transaction-workspace"

export const metadata: Metadata = { title: "Transactions" }

/** The current query with `batch` dropped, as a `/transactions` href: what the notice's "Show all transactions" link goes to. */
function hrefWithoutBatch(query: Record<string, string | undefined>): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (key === "batch" || value === undefined || value === "") continue
    params.set(key, value)
  }
  const qs = params.toString()
  return qs === "" ? "/transactions" : `/transactions?${qs}`
}

// The filters are the URL's search parameters; the server reads them, the ledger and the first page of entries, and hands
// the client plain data: money is paise text, never a bigint, which JSON cannot carry.
export default async function TransactionsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const raw = await searchParams
  // One value per name: a repeated parameter (?kind=A&kind=B) is a hand-edited URL, and the first value is as good as any.
  const query = Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, Array.isArray(value) ? value[0] : value]))
  let userId: string
  let screen: Awaited<ReturnType<typeof loadTransactionScreen>>
  try {
    userId = await requireUserId()
    screen = await loadTransactionScreen(userId, query)
  } catch (error) {
    redirectIfUnauthenticated(error) // the route guard normally catches a missing session first; a deleted user's it cannot
    throw error
  }
  // A foreign or missing batch id (a stale link, a hand-edited URL) silently shows no notice, same as loadBatchLabel's
  // own leniency: the list itself already filtered by it (or matched nothing), which is enough of an answer on its own.
  let batchNotice: BatchNotice | null = null
  const batchId = query.batch?.trim()
  if (batchId) {
    const label = await loadBatchLabel(userId, batchId)
    if (label) batchNotice = { fileName: label.fileName, dropHref: hrefWithoutBatch(query) }
  }
  return (
    <AppShell current="transactions">
      <TransactionWorkspace screen={screen} batchNotice={batchNotice} />
    </AppShell>
  )
}
