"use client"

import { useRef, useState } from "react"
import type { TransactionScreen } from "@/lib/transaction-list-view"
import type { TransactionView } from "@/lib/transaction-view"
import { Balances } from "./balances"
import { Filters } from "./filters"
import type { TransactionNotice } from "./notice"
import { TransactionForm } from "./transaction-form"
import { TransactionList } from "./transaction-list"

// The client half of the transaction screen: balances, filters and the list on one side, the form on the other, and the
// one message area they share. What is drawn comes from `screen`, which the server renders again after every write (the
// actions revalidate this page), so no figure here is a client-side guess at what the server now holds.

export function TransactionWorkspace({ screen }: { screen: TransactionScreen }) {
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
    <main className="mx-auto max-w-6xl px-4 pb-28 pt-8 sm:px-6">
      <div className="flex items-end justify-between gap-4">
        <h1 className="font-display text-4xl font-bold tracking-tight">Transactions</h1>
        <button
          type="button"
          aria-expanded={formOpen}
          onClick={() => setFormOpen((open) => !open)}
          className="rounded-sm bg-accent px-4 py-2 font-medium text-accent-fg lg:hidden"
        >
          {formOpen ? "Close form" : "Record a transaction"}
        </button>
      </div>

      <div className="mt-8 grid gap-10 lg:grid-cols-[minmax(0,1fr)_23rem] lg:items-start">
        <div className="space-y-8">
          <Balances nodes={screen.nodes} balances={screen.balances} />
          <Filters filter={screen.filter} problems={screen.problems} nodes={screen.nodes} />
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

      <div
        ref={statusRef}
        role="status"
        tabIndex={-1}
        className="fixed inset-x-4 bottom-4 z-10 mx-auto max-w-xl outline-offset-4 empty:hidden"
      >
        {notice && (
          <div
            className={`flex items-start gap-3 border-l-4 bg-panel px-4 py-3 shadow-[0_2px_0_var(--line-strong)] ${
              notice.tone === "warning" ? "border-notice-fg" : "border-accent"
            }`}
          >
            <div className="flex-1 space-y-1">
              {notice.lines.map((line, index) => (
                <p key={index}>{line}</p>
              ))}
            </div>
            {notice.undo && (
              <button
                type="button"
                onClick={() => {
                  notice.undo?.run()
                  setNotice(null)
                }}
                className="text-sm font-medium text-accent underline underline-offset-4"
              >
                {notice.undo.label}
              </button>
            )}
            <button type="button" onClick={() => setNotice(null)} className="text-sm font-medium text-accent underline underline-offset-4">
              Dismiss
            </button>
          </div>
        )}
      </div>
    </main>
  )
}
