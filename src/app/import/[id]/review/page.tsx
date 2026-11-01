import type { Metadata } from "next"
import { notFound, redirect } from "next/navigation"
import { AppShell } from "@/app/app-shell"
import { redirectIfUnauthenticated } from "@/server/action-support"
import { requireUserId } from "@/server/auth"
import { NotFoundError } from "@/server/repositories/errors"
import { InvalidImportError, loadReview, type ReviewFilter } from "@/server/services/import-service"
import { ReviewWorkspace } from "./review-workspace"

export const metadata: Metadata = { title: "Review import" }

const FILTERS: readonly ReviewFilter[] = ["all", "pending", "duplicates", "errors", "ready", "skipped"]

/** One value per name: a repeated parameter is a hand-edited URL, and the first value is as good as any. */
const first = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value[0] : value)

function filterFrom(value: string | string[] | undefined): ReviewFilter {
  const v = first(value)
  return (FILTERS as readonly string[]).includes(v ?? "") ? (v as ReviewFilter) : "all"
}

function pageFrom(value: string | string[] | undefined): number {
  const n = Number(first(value))
  return Number.isFinite(n) && n >= 1 ? Math.trunc(n) : 1
}

// The review screen (design §6 stage 4): one server read of the whole page's worth of rows (REVIEW_PAGE_SIZE at a
// time), handed down as one literal prop tree to a single client workspace — no row fetches its own data. A batch
// that is not STAGED (already committed, reversed, discarded, or still only uploaded) redirects through `/import/[id]`,
// the same generic redirector Task 10 built, rather than this page guessing the right destination itself.
export default async function ReviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { id } = await params
  const raw = await searchParams
  const filter = filterFrom(raw.filter)
  const page = pageFrom(raw.page)

  let screen: Awaited<ReturnType<typeof loadReview>>
  try {
    screen = await loadReview(await requireUserId(), id, { filter, page })
  } catch (error) {
    redirectIfUnauthenticated(error) // the route guard normally catches a missing session first; a deleted user's it cannot
    if (error instanceof InvalidImportError) return redirect(`/import/${id}`)
    if (error instanceof NotFoundError) notFound()
    throw error
  }
  return (
    <AppShell current="import">
      <ReviewWorkspace batchId={id} screen={screen} />
    </AppShell>
  )
}
