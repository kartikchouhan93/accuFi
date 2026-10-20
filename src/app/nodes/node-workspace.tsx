"use client"

import { useRef, useState } from "react"
import type { LedgerKind } from "@/domain/ledger-kind"
import type { NodeOverview } from "@/lib/node-overview"
import { NodeForm } from "./node-form"
import { NodeList } from "./node-list"

// The client half of the ledger screen: the list, the form, and the one message area they share. Everything money
// related arrives already computed in `overview`; after any change the server component is asked again (router.refresh
// in the form and the rows), so what is drawn is never a client-side guess at what the server now holds.

export interface Notice {
  tone: "success" | "warning"
  text: string
}

export function NodeWorkspace({ overview, netWorth }: { overview: NodeOverview; netWorth: React.ReactNode }) {
  const [kind, setKind] = useState<LedgerKind>("ASSET")
  const [formOpen, setFormOpen] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const statusRef = useRef<HTMLDivElement>(null)

  // A row that archives or deletes itself takes the keyboard's focus with it; the message is where focus lands.
  function announce(next: Notice, moveFocus = false) {
    setNotice(next)
    if (moveFocus) requestAnimationFrame(() => statusRef.current?.focus())
  }

  return (
    <main className="mx-auto max-w-6xl px-4 pb-28 pt-8 sm:px-6">
      <div className="flex items-end justify-between gap-4">
        <h1 className="font-display text-4xl font-bold tracking-tight">Ledger</h1>
        <button
          type="button"
          aria-expanded={formOpen}
          onClick={() => setFormOpen((open) => !open)}
          className="rounded-sm bg-accent px-4 py-2 font-medium text-accent-fg lg:hidden"
        >
          {formOpen ? "Close form" : "Add to ledger"}
        </button>
      </div>

      <div className="mt-8 grid gap-10 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start">
        <div>
          {netWorth}
          <div className="mt-8">
            <NodeList
              overview={overview}
              announce={announce}
              onAdd={(next) => {
                setKind(next)
                setFormOpen(true)
              }}
            />
          </div>
        </div>
        <aside className={`${formOpen ? "block" : "hidden"} order-first lg:order-none lg:sticky lg:top-6 lg:block lg:max-h-[calc(100vh-3rem)] lg:overflow-y-auto`}>
          <NodeForm kind={kind} onKindChange={setKind} announce={announce} />
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
            <p className="flex-1">{notice.text}</p>
            <button type="button" onClick={() => setNotice(null)} className="text-sm font-medium text-accent underline underline-offset-4">
              Dismiss
            </button>
          </div>
        )}
      </div>
    </main>
  )
}
