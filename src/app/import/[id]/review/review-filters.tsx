import Link from "next/link"
import type { ReviewFilter, ReviewScreen } from "@/lib/import-view"

// The six ways to look at a batch's rows, as links with their own counts: a plain navigation (the server re-filters
// and re-paginates), so this needs no client state of its own. The one the screen is already on is marked
// `aria-current="page"` and never duplicated as a link to itself with different wording, so the status reads the
// same to everyone. Picking a different filter always starts back at page 1: a page number from the old filter means
// nothing under the new one.

const LABELS: Record<ReviewFilter, string> = {
  all: "All",
  pending: "Needs a decision",
  duplicates: "Possible duplicates",
  errors: "Errors",
  ready: "Ready",
  skipped: "Skipped",
}

const ORDER: ReviewFilter[] = ["all", "pending", "duplicates", "errors", "ready", "skipped"]

export function ReviewFilters({ batchId, filter, counts }: { batchId: string; filter: ReviewFilter; counts: ReviewScreen["counts"] }) {
  const countOf: Record<ReviewFilter, number> = {
    all: counts.pending + counts.ready + counts.skipped + counts.errored,
    pending: counts.pending,
    duplicates: counts.duplicates,
    errors: counts.errored,
    ready: counts.ready,
    skipped: counts.skipped,
  }
  return (
    <nav aria-label="Filter rows" className="flex flex-wrap gap-2">
      {ORDER.map((key) => {
        const current = key === filter
        return (
          <Link
            key={key}
            href={`/import/${batchId}/review?filter=${key}&page=1`}
            aria-current={current ? "page" : undefined}
            className={
              current
                ? "rounded-full border border-accent-edge bg-accent/10 px-3.5 py-1.5 text-sm font-medium text-accent-edge"
                : "rounded-full border border-line-strong px-3.5 py-1.5 text-sm font-medium text-fg-soft transition-colors duration-200 hover:border-fg-soft hover:text-fg"
            }
          >
            {LABELS[key]} <span className="figures">({countOf[key]})</span>
          </Link>
        )
      })}
    </nav>
  )
}
