import type { Metadata } from "next"
import { notFound, redirect } from "next/navigation"
import { AppShell } from "@/app/app-shell"
import { redirectIfUnauthenticated } from "@/server/action-support"
import { requireUserId } from "@/server/auth"
import { NotFoundError } from "@/server/repositories/errors"
import { loadBatchPage } from "@/server/services/import-service"
import { BatchWorkspace } from "./batch-workspace"

export const metadata: Metadata = { title: "Imported" }

// The committed/reversed batch page (design §6 stage 5), reached through `/import/[id]`'s own redirect for either
// status. `loadBatchPage` only ever returns a `summary` for COMMITTED or REVERSED (null otherwise, and it treats a
// discarded or foreign batch as not found) — this page still checks the status itself before trusting that, and sends
// anything else back through the generic redirector, the same defensive shape Task 10's own `[id]/page.tsx` uses,
// rather than assuming nothing else can ever land here.
export default async function BatchPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  let loaded: Awaited<ReturnType<typeof loadBatchPage>>
  try {
    loaded = await loadBatchPage(await requireUserId(), id)
  } catch (error) {
    redirectIfUnauthenticated(error) // the route guard normally catches a missing session first; a deleted user's it cannot
    if (error instanceof NotFoundError) notFound()
    throw error
  }
  if (loaded.summary === null || (loaded.batch.status !== "COMMITTED" && loaded.batch.status !== "REVERSED")) {
    return redirect(`/import/${id}`)
  }
  return (
    <AppShell current="import">
      <BatchWorkspace batch={loaded.batch} summary={loaded.summary} />
    </AppShell>
  )
}
