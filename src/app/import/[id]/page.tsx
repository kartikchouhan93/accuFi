import { notFound, redirect } from "next/navigation"
import { redirectIfUnauthenticated } from "@/server/action-support"
import { requireUserId } from "@/server/auth"
import { NotFoundError } from "@/server/repositories/errors"
import { loadBatchPage } from "@/server/services/import-service"

// A thin redirect by status, never a screen of its own: UPLOADED still needs mapping, STAGED still needs review,
// and COMMITTED/REVERSED land on the batch page (Task 11, src/app/import/[id]/batch/page.tsx; until that lands this
// is an expected 404, the same as the Review page the list and the map screen already point at). `loadBatchPage`
// already treats a discarded batch as gone, the same as a foreign one, so both become a plain not-found here too.
export default async function ImportBatchRedirectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  let loaded: Awaited<ReturnType<typeof loadBatchPage>>
  try {
    loaded = await loadBatchPage(await requireUserId(), id)
  } catch (error) {
    redirectIfUnauthenticated(error) // the route guard normally catches a missing session first; a deleted user's it cannot
    if (error instanceof NotFoundError) notFound()
    throw error
  }
  // redirect() throws in the real app, but never relies on that here: each branch returns, so nothing could ever
  // fall through to the next one even under a test double that lets redirect() return normally.
  if (loaded.batch.status === "UPLOADED") return redirect(`/import/${id}/map`)
  if (loaded.batch.status === "STAGED") return redirect(`/import/${id}/review`)
  // COMMITTED or REVERSED: DISCARDED already threw NotFoundError above.
  return redirect(`/import/${id}/batch`)
}
