"use client"

import { CalendarClock, PiggyBank, Plus } from "lucide-react"
import Link from "next/link"
import { useRef, useState } from "react"
import type { Announce, TransactionNotice } from "@/app/transactions/notice"
import { NoticeToast, type ToastNotice } from "@/components/ui/notice-toast"
import { buttonClass } from "@/components/ui/styles"
import { addMonths, type CalendarDate } from "@/domain/calendar-date"
import { monthLabel, type BudgetsScreen } from "@/lib/budget-view"
import { BudgetCardItem } from "./budget-card"
import { useFlash } from "./flash"
import { MonthPicker } from "./month-picker"
import { UpcomingSection } from "./upcoming-section"

// The client half of the Budgets screen: the month picker, a card per budget and the one message area they share. What is
// drawn is what the server sent; after a delete the server component is asked again (router.refresh in the card), so
// nothing on screen is a client-side guess at what the server now holds. The screen has four states: no budget at all (what
// a budget is for), budgets that have not started yet, a month that no budget covers, and the cards. A budget that starts
// after the current month has no card, so the Upcoming list below the cards (or below the not-started message) is where it is
// edited or deleted.

export function BudgetsWorkspace({ screen }: { screen: BudgetsScreen }) {
  const [notice, setNotice] = useState<ToastNotice | null>(null)
  const statusRef = useRef<HTMLDivElement>(null)

  // What the budget form left for this screen when it saved: said once, as the screen opens.
  useFlash(setNotice)

  // A deleted card takes the keyboard's place with it: the message is where focus lands then, as on the other screens.
  const announce: Announce = (next: TransactionNotice, moveFocus = false) => {
    setNotice(next)
    if (moveFocus) requestAnimationFrame(() => statusRef.current?.focus())
  }

  return (
    <main className="mx-auto max-w-6xl px-4 pb-28 pt-8 sm:px-8">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="font-display text-3xl font-semibold tracking-tight sm:text-4xl">Budgets</h1>
        {!screen.empty && (
          <Link href="/budgets/new" className={buttonClass()}>
            <Plus aria-hidden className="size-4" />
            New budget
          </Link>
        )}
      </div>
      <div className="mt-8">
        {screen.empty ? (
          <EmptyState />
        ) : screen.months.length === 0 ? (
          <NotStarted month={screen.month} firstStart={screen.upcoming[0]?.startMonth ?? null} />
        ) : (
          <>
            <MonthPicker month={screen.month} months={screen.months} />
            {screen.cards.length === 0 ? (
              <p className="surface mt-6 rounded-2xl p-5 text-fg-soft">
                No budget covers {monthLabel(screen.month)}. Pick another month, or add a budget for it.
              </p>
            ) : (
              <ul aria-label={`Budgets for ${monthLabel(screen.month)}`} className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-2 lg:items-start">
                {screen.cards.map((card, index) => (
                  <BudgetCardItem key={card.budgetId} card={card} month={screen.month} index={index} announce={announce} />
                ))}
              </ul>
            )}
          </>
        )}
        {screen.upcoming.length > 0 && <UpcomingSection upcoming={screen.upcoming} announce={announce} />}
      </div>
      <NoticeToast notice={notice} onDismiss={() => setNotice(null)} statusRef={statusRef} />
    </main>
  )
}

function EmptyState() {
  return (
    <section aria-labelledby="no-budgets" className="surface rounded-3xl p-6 sm:p-10">
      <PiggyBank aria-hidden className="size-8 text-accent-edge" />
      <h2 id="no-budgets" className="mt-4 font-display text-xl font-semibold tracking-tight">
        Set a limit on what you spend
      </h2>
      <p className="mt-2 max-w-prose text-fg-soft">
        A budget is a monthly cap on an expense ledger, such as Groceries or Eating out. It shows how much of the month&rsquo;s limit is used
        and how much is left, and warns you as you near it. It counts what you spend on the ledger and the ledgers inside it, and never
        stops you recording anything.
      </p>
      <Link href="/budgets/new" className={`${buttonClass()} mt-6`}>
        <Plus aria-hidden className="size-4" />
        New budget
      </Link>
    </section>
  )
}

/** Budgets exist but all begin after the current month: nothing to measure yet, and no month to pick. */
function NotStarted({ month, firstStart }: { month: string; firstStart: string | null }) {
  const nextMonth = addMonths(month as CalendarDate, 1)
  const heading =
    firstStart === null ? "Your budgets have not started yet" : firstStart === nextMonth ? "Your budgets start next month" : `Your budgets start in ${monthLabel(firstStart)}`
  return (
    <section aria-labelledby="not-started" className="surface rounded-3xl p-6 sm:p-10">
      <CalendarClock aria-hidden className="size-8 text-accent-edge" />
      <h2 id="not-started" className="mt-4 font-display text-xl font-semibold tracking-tight">
        {heading}
      </h2>
      <p className="mt-2 max-w-prose text-fg-soft">
        None has started yet, so there is nothing to measure.{firstStart === nextMonth && ` The first begins in ${monthLabel(firstStart)}.`} Each
        budget appears here from its first month.
      </p>
    </section>
  )
}
