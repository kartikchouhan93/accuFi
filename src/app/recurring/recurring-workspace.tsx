"use client"

import { Plus } from "lucide-react"
import Link from "next/link"
import { useRef, useState } from "react"
import { NoticeToast, type ToastNotice } from "@/components/ui/notice-toast"
import { buttonClass } from "@/components/ui/styles"
import type { OccurrenceView, RuleView } from "@/lib/recurring-view"
import type { TransactionNotice } from "@/app/transactions/notice"
import { Inbox } from "./inbox"
import { RecentList } from "./recent-list"
import { RulesList } from "./rules-list"

// The client half of the Recurring screen: the inbox, the rules and what was handled lately, and the one message area they
// share. Every card is drawn from what the server sent; after an action the server component is asked again
// (router.refresh in the card), so nothing drawn is a client-side guess at what the server now holds.

interface Props {
  inbox: OccurrenceView[]
  rules: RuleView[]
  recent: OccurrenceView[]
}

export function RecurringWorkspace({ inbox, rules, recent }: Props) {
  const [notice, setNotice] = useState<ToastNotice | null>(null)
  const statusRef = useRef<HTMLDivElement>(null)

  // What was pressed often disappears with its card (a posted entry leaves the inbox), taking the keyboard's place with
  // it: the message is where focus lands then, as on the other screens.
  function announce(next: TransactionNotice, moveFocus = false) {
    setNotice(next)
    if (moveFocus) requestAnimationFrame(() => statusRef.current?.focus())
  }

  return (
    <main className="mx-auto max-w-6xl px-4 pb-28 pt-8 sm:px-8">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="font-display text-3xl font-semibold tracking-tight sm:text-4xl">Recurring</h1>
        {rules.length > 0 && (
          <Link href="/recurring/new" className={buttonClass()}>
            <Plus aria-hidden className="size-4" />
            New rule
          </Link>
        )}
      </div>
      <div className="mt-8">
        <Inbox inbox={inbox} hasRules={rules.length > 0} announce={announce} />
        <RulesList rules={rules} announce={announce} />
        <RecentList recent={recent} announce={announce} />
      </div>
      <NoticeToast notice={notice} onDismiss={() => setNotice(null)} statusRef={statusRef} />
    </main>
  )
}
