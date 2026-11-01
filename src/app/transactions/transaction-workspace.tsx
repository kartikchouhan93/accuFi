"use client"

import { Plus, X } from "lucide-react"
import Link from "next/link"
import { useRef, useState } from "react"
import { NoticeToast } from "@/components/ui/notice-toast"
import { buttonClass } from "@/components/ui/styles"
import type { TransactionScreen } from "@/lib/transaction-list-view"
import type { TransactionView } from "@/lib/transaction-view"
import { Balances } from "./balances"
import { Filters } from "./filters"
import { FilteredTotal } from "./filtered-total"
import type { TransactionNotice } from "./notice"
import { TransactionForm } from "./transaction-form"
import { TransactionList } from "./transaction-list"

// The client half of the transaction screen: balances, filters and the list on one side, the form on the other, and the
// one message area they share. What is drawn comes from `screen`, which the server renders again after every write (the
// actions revalidate this page), so no figure here is a client-side guess at what the server now holds.

/** The page's own `?batch=` notice: an import's file name, and where "Show all transactions" leads (the same filters, `batch` dropped). */
export interface BatchNotice {
  fileName: string
  dropHref: string
}

export function TransactionWorkspace({ screen, batchNotice = null }: { screen: TransactionScreen; batchNotice?: BatchNotice | null }) {
  const [editing, setEditing] = useState<TransactionView | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [notice, setNotice] = useState<TransactionNotice | null>(null)
  const statusRef = useRef<HTMLDivElement>(null)
  const blocked = Object.keys(screen.problems).length > 0

  // A row that deletes itself takes the keyboard's focus with it; the message is where focus lands.
  function announce(next: TransactionNotice, moveFocus = false) {
    setNotice(next)
    if (moveFocus) requestAnimationFrame(() => statusRef.current?.focus())
  }

  function edit(transaction: TransactionView) {
    setEditing(transaction)
    setFormOpen(true)
  }

  return (
    <main className="mx-auto max-w-6xl px-4 pb-28 pt-8 sm:px-8">
      <div className="flex items-center justify-between gap-4">
        <h1 className="font-display text-3xl font-semibold tracking-tight sm:text-4xl">Transactions</h1>
        <button
          type="button"
          aria-expanded={formOpen}
          onClick={() => setFormOpen((open) => !open)}
          className={buttonClass({ className: "lg:hidden" })}
        >
          {formOpen ? <X aria-hidden className="size-4" /> : <Plus aria-hidden className="size-4" />}
          {formOpen ? "Close form" : "Record a transaction"}
        </button>
      </div>

      <div className="mt-8 grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1fr)_24rem] lg:items-start">
        <div className="min-w-0 space-y-8">
          <Balances nodes={screen.nodes} balances={screen.balances} unvalued={screen.unvalued} priced={screen.priced} />
          {batchNotice && (
            <div
              role="status"
              className="surface flex flex-wrap items-center gap-x-2 gap-y-1 rounded-2xl border border-line-strong bg-panel-raised px-4 py-3 text-sm"
            >
              <span>
                Showing entries from import <span className="font-medium [overflow-wrap:anywhere]">{batchNotice.fileName}</span>.
              </span>
              <Link href={batchNotice.dropHref} className="font-medium text-link underline underline-offset-4">
                Show all transactions
              </Link>
            </div>
          )}
          <Filters filter={screen.filter} problems={screen.problems} nodes={screen.nodes} />
          {screen.netTotal && <FilteredTotal paise={screen.netTotal.paise} deleted={screen.filter.deleted === "1"} />}
          <TransactionList
            page={screen.page}
            filter={screen.filter}
            blocked={blocked}
            nodes={screen.nodes}
            today={screen.today}
            announce={announce}
            onEdit={edit}
          />
        </div>
        <aside className={`${formOpen ? "block" : "hidden"} order-first lg:order-none lg:sticky lg:top-6 lg:block lg:max-h-[calc(100vh-3rem)] lg:overflow-y-auto`}>
          <TransactionForm
            key={editing ? editing.id : "new"}
            nodes={screen.nodes}
            today={screen.today}
            listed={screen.filter}
            editing={editing}
            onFinished={() => setEditing(null)}
            announce={announce}
          />
        </aside>
      </div>

      <NoticeToast notice={notice} onDismiss={() => setNotice(null)} statusRef={statusRef} />
    </main>
  )
}
