"use client"

import { Pencil } from "lucide-react"
import Link from "next/link"
import { Amount } from "@/app/amount"
import { figure } from "@/app/feedback"
import type { Announce } from "@/app/transactions/notice"
import { buttonClass } from "@/components/ui/styles"
import { Tag } from "@/components/ui/tag"
import { monthLabel, type UpcomingBudget } from "@/lib/budget-view"
import { upcomingDeleteText } from "./budget-text"
import { DeleteButton, DeleteConfirm, useDeleteBudget } from "./delete-budget"

// The budgets that start after the current month. They have no card yet (nothing to measure), so this is where they are
// found: the ledger, the cap, when it starts and, behind the same Edit link and confirmed Delete as a card, what can be done
// with it. The screen shows it only when there is something to list.

export function UpcomingSection({ upcoming, announce }: { upcoming: UpcomingBudget[]; announce: Announce }) {
  return (
    <section aria-labelledby="upcoming-budgets" className="mt-10">
      <h2 id="upcoming-budgets" className="font-display text-xl font-semibold tracking-tight">
        Upcoming
      </h2>
      <p className="mt-1 text-sm text-fg-soft">These start in a later month, so there is nothing to measure yet.</p>
      <ul className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2 lg:items-start">
        {upcoming.map((budget) => (
          <UpcomingItem key={budget.budgetId} budget={budget} announce={announce} />
        ))}
      </ul>
    </section>
  )
}

function UpcomingItem({ budget, announce }: { budget: UpcomingBudget; announce: Announce }) {
  const del = useDeleteBudget(budget, announce)
  return (
    <li className="surface rounded-2xl p-4 sm:p-5">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
        <h3 className="min-w-0 font-display text-lg font-semibold tracking-tight [overflow-wrap:anywhere]">{budget.name}</h3>
        {budget.archived && <Tag>Archived</Tag>}
      </div>
      <p className="mt-1 text-sm text-fg-soft">
        Starts {monthLabel(budget.startMonth)}
        {budget.endMonth !== null && `, ends ${monthLabel(budget.endMonth)}`}
        {budget.rollover && ". Unspent budget carries over"}
      </p>
      <p className="mt-3 text-xl font-medium tracking-tight">
        <Amount text={figure(budget.amountPaise)} /> <span className="text-sm font-normal text-fg-soft">a month</span>
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Link href={`/budgets/${budget.budgetId}/edit`} className={buttonClass({ variant: "secondary", size: "sm" })}>
          <Pencil aria-hidden className="size-4" />
          Edit<span className="sr-only"> {budget.name} budget</span>
        </Link>
        <DeleteButton control={del} name={budget.name} />
      </div>
      <DeleteConfirm control={del} name={budget.name}>
        {upcomingDeleteText(budget)}
      </DeleteConfirm>
    </li>
  )
}
