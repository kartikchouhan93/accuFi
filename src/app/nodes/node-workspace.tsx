"use client"

import { Plus, X } from "lucide-react"
import { useRef, useState } from "react"
import { buttonClass } from "@/components/ui/styles"
import { NoticeToast, type ToastNotice } from "@/components/ui/notice-toast"
import type { LedgerKind } from "@/domain/ledger-kind"
import type { NodeOverview } from "@/lib/node-overview"
import { NodeForm } from "./node-form"
import { NodeList } from "./node-list"

// The client half of the ledger screen: the list, the form, and the one message area they share. Everything money
// related arrives already computed in `overview`; after any change the server component is asked again (router.refresh
// in the form and the rows), so what is drawn is never a client-side guess at what the server now holds.

export type Notice = ToastNotice

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
    <main className="mx-auto max-w-6xl px-4 pb-28 pt-8 sm:px-8">
      <div className="flex items-center justify-between gap-4">
        <h1 className="font-display text-3xl font-semibold tracking-tight sm:text-4xl">Ledger</h1>
        <button
          type="button"
          aria-expanded={formOpen}
          onClick={() => setFormOpen((open) => !open)}
          className={buttonClass({ className: "lg:hidden" })}
        >
          {formOpen ? <X aria-hidden className="size-4" /> : <Plus aria-hidden className="size-4" />}
          {formOpen ? "Close form" : "Add to ledger"}
        </button>
      </div>

      <div className="mt-8 grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1fr)_23rem] lg:items-start">
        <div className="space-y-8">
          {netWorth}
          <NodeList
            overview={overview}
            announce={announce}
            onAdd={(next) => {
              setKind(next)
              setFormOpen(true)
            }}
          />
        </div>
        <aside className={`${formOpen ? "block" : "hidden"} order-first lg:order-none lg:sticky lg:top-6 lg:block lg:max-h-[calc(100vh-3rem)] lg:overflow-y-auto`}>
          <NodeForm kind={kind} onKindChange={setKind} announce={announce} />
        </aside>
      </div>

      <NoticeToast notice={notice} onDismiss={() => setNotice(null)} statusRef={statusRef} />
    </main>
  )
}
