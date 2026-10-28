"use client"

import { Plus, Repeat } from "lucide-react"
import Link from "next/link"
import type { Announce } from "@/app/transactions/notice"
import { buttonClass } from "@/components/ui/styles"
import type { OccurrenceView } from "@/lib/recurring-view"
import { InboxCard } from "./inbox-card"

// What is waiting: the entries rules have proposed that nobody has posted or skipped, oldest first (the server's order).
// With nothing waiting it says so; with no rule at all it says what a rule is for and offers the first one.

export function Inbox({ inbox, hasRules, announce }: { inbox: OccurrenceView[]; hasRules: boolean; announce: Announce }) {
  return (
    <section aria-labelledby="inbox-heading">
      <div className="flex items-baseline justify-between gap-4">
        <h2 id="inbox-heading" className="font-display text-lg font-semibold tracking-tight">
          Inbox
        </h2>
        {inbox.length > 0 && <span className="text-sm text-fg-soft">{inbox.length} waiting</span>}
      </div>
      {inbox.length > 0 ? (
        <ul className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2 lg:items-start">
          {inbox.map((occurrence, index) => (
            <InboxCard key={occurrence.id} occurrence={occurrence} index={index} announce={announce} />
          ))}
        </ul>
      ) : hasRules ? (
        <p className="surface mt-4 rounded-2xl p-5 text-fg-soft">Nothing is waiting. The next entry shows here on the day a rule comes due.</p>
      ) : (
        <div className="surface mt-4 max-w-xl rounded-3xl p-8">
          <span aria-hidden className="grid size-12 place-items-center rounded-2xl bg-panel-raised text-accent-edge">
            <Repeat className="size-6" />
          </span>
          <h3 className="mt-5 font-display text-2xl font-semibold tracking-tight">No rules yet</h3>
          <p className="mt-2 text-fg-soft">
            A rule is for something that repeats, like rent, a SIP or a subscription. It proposes each entry here when it falls due, and you
            post it with one press, change it first, or skip it.
          </p>
          <Link href="/recurring/new" className={buttonClass({ className: "mt-6" })}>
            <Plus aria-hidden className="size-4" />
            New rule
          </Link>
        </div>
      )}
    </section>
  )
}
