import type { Metadata } from "next"
import { AppShell } from "@/app/app-shell"
import { redirectIfUnauthenticated } from "@/server/action-support"
import { requireUserId } from "@/server/auth"
import { loadBatchList } from "@/server/services/import-service"
import { BatchList } from "./batch-list"

export const metadata: Metadata = { title: "Import" }

// Every statement the user has ever uploaded, newest first. The route guard sends anyone without a session to /login
// before this runs; a deleted user's session is caught here the same way every other screen does.
export default async function ImportPage() {
  let batches: Awaited<ReturnType<typeof loadBatchList>>
  try {
    batches = await loadBatchList(await requireUserId())
  } catch (error) {
    redirectIfUnauthenticated(error)
    throw error
  }
  return (
    <AppShell current="import">
      <BatchList batches={batches} />
    </AppShell>
  )
}
