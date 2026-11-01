"use client"

import Link from "next/link"
import { ArrowLeft } from "lucide-react"
import { useRef, useState } from "react"
import { NoticeToast, type ToastNotice } from "@/components/ui/notice-toast"
import type { Announce, TransactionNotice } from "@/app/transactions/notice"
import type { ReviewScreen } from "@/lib/import-view"
import { CommitBar } from "./commit-bar"
import { ReviewFilters } from "./review-filters"
import { ReviewRow } from "./review-row"

// The whole review screen body, one client component reading a single server-built `screen` (the same "one load, one
// workspace" shape every other multi-action screen here already uses: `transaction-workspace.tsx`, `batch-list.tsx`).
// It owns nothing of its own truth: every count, row and flag comes from the prop, and every write just asks the
// server to be read again (`router.refresh()`, inside the actions below it), so this is never out of step with what
// actually got written.

export function ReviewWorkspace({ batchId, screen }: { batchId: string; screen: ReviewScreen }) {
  const [notice, setNotice] = useState<ToastNotice | null>(null)
  // While a commit is in flight every row's controls are held still: the server already serializes a decision behind
  // the commit (and refuses it once the batch is committed), this just stops the person making one that cannot land.
  const [committing, setCommitting] = useState(false)
  const statusRef = useRef<HTMLDivElement>(null)

  const announce: Announce = (next: TransactionNotice, moveFocus = false) => {
    setNotice(next)
    if (moveFocus) requestAnimationFrame(() => statusRef.current?.focus())
  }

  return (
    <main className="mx-auto max-w-4xl px-4 pb-28 pt-8 sm:px-8">
      <Link href="/import" className="inline-flex items-center gap-1.5 rounded-md text-sm font-medium text-link underline underline-offset-4">
        <ArrowLeft aria-hidden className="size-4" />
        Import
      </Link>
      <h1 className="mt-4 font-display text-3xl font-semibold tracking-tight sm:text-4xl [overflow-wrap:anywhere]">{screen.batch.fileName}</h1>
      <p className="mt-2 text-fg-soft">Onto {screen.account.name}. Decide each row, then commit the ones that are ready.</p>

      <div className="mt-6">
        <ReviewFilters batchId={batchId} filter={screen.filter} counts={screen.counts} />
      </div>

      <div className="mt-4">
        <CommitBar batchId={batchId} fileName={screen.batch.fileName} counts={screen.counts} canCommit={screen.canCommit} announce={announce} onCommittingChange={setCommitting} />
      </div>

      <div className="mt-6">
        {screen.rows.length === 0 ? (
          <p className="surface rounded-2xl p-6 text-fg-soft">No rows match this filter.</p>
        ) : (
          <ul aria-label="Staged rows" className="space-y-4">
            {screen.rows.map((row) => (
              <ReviewRow key={row.id} row={row} account={screen.account} ledgers={screen.ledgers} siblings={screen.rows} announce={announce} locked={committing} />
            ))}
          </ul>
        )}
      </div>

      {screen.pageCount > 1 && (
        <nav aria-label="Pages" className="mt-6 flex items-center justify-between gap-4 text-sm">
          {screen.page > 1 ? (
            <Link href={`/import/${batchId}/review?filter=${screen.filter}&page=${screen.page - 1}`} className="font-medium text-link underline underline-offset-4">
              Previous page
            </Link>
          ) : (
            <span />
          )}
          <span className="figures text-fg-soft">
            Page {screen.page} of {screen.pageCount}
          </span>
          {screen.page < screen.pageCount ? (
            <Link href={`/import/${batchId}/review?filter=${screen.filter}&page=${screen.page + 1}`} className="font-medium text-link underline underline-offset-4">
              Next page
            </Link>
          ) : (
            <span />
          )}
        </nav>
      )}

      <NoticeToast notice={notice} onDismiss={() => setNotice(null)} statusRef={statusRef} />
    </main>
  )
}
