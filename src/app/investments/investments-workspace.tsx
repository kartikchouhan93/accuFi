"use client"

import { LineChart, Plus } from "lucide-react"
import Link from "next/link"
import { useRef, useState } from "react"
import { NoticeToast, type ToastNotice } from "@/components/ui/notice-toast"
import { buttonClass } from "@/components/ui/styles"
import { Switch } from "@/components/ui/switch"
import type { CalendarDate } from "@/domain/calendar-date"
import type { Portfolio } from "@/lib/investment-view"
import type { PickerNode } from "@/lib/transaction-list-view"
import { HoldingCard } from "./holding-card"
import { PortfolioHero } from "./portfolio-hero"

// The client half of the investments screen: the portfolio, a card per investment, and the one message area they share.
// Every figure arrives computed by the server in `portfolio`; after a sale the server component is asked again
// (router.refresh in the card), so nothing drawn is a client-side guess at what the server now holds. Archived
// investments still count in the totals; whether their cards are drawn is this screen's choice, and it says so.

interface Props {
  portfolio: Portfolio
  today: CalendarDate
  destinations: PickerNode[]
}

export function InvestmentsWorkspace({ portfolio, today, destinations }: Props) {
  const [notice, setNotice] = useState<ToastNotice | null>(null)
  const [showArchived, setShowArchived] = useState(false)
  const statusRef = useRef<HTMLDivElement>(null)
  const archivedCount = portfolio.holdings.filter((holding) => holding.archived).length
  const visible = showArchived ? portfolio.holdings : portfolio.holdings.filter((holding) => !holding.archived)

  return (
    <main className="mx-auto max-w-6xl px-4 pb-28 pt-8 sm:px-8">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="font-display text-3xl font-semibold tracking-tight sm:text-4xl">Investments</h1>
        {portfolio.holdings.length > 0 && (
          <Link href="/investments/prices" className={buttonClass({ variant: "secondary" })}>
            <LineChart aria-hidden className="size-4" />
            Record prices
          </Link>
        )}
      </div>

      {portfolio.holdings.length === 0 ? (
        <section aria-labelledby="no-investments" className="surface mt-8 max-w-xl rounded-3xl p-8">
          <h2 id="no-investments" className="font-display text-2xl font-semibold tracking-tight">
            No investments yet
          </h2>
          <p className="mt-2 text-fg-soft">
            Add gold, a fund, a property or a deposit on the ledger, then record buying it from one of your accounts. Its value,
            cost and gain show here.
          </p>
          <Link href="/nodes" className={buttonClass({ className: "mt-6" })}>
            <Plus aria-hidden className="size-4" />
            Add an investment
          </Link>
        </section>
      ) : (
        <>
          <div className="mt-8">
            <PortfolioHero portfolio={portfolio} />
          </div>
          {archivedCount > 0 && (
            <div className="mt-8 flex flex-wrap items-center gap-x-4 gap-y-2">
              <Switch checked={showArchived} onChange={setShowArchived}>
                Show archived
              </Switch>
              {!showArchived && <p className="text-sm text-fg-soft">The totals include {archivedCount} archived, not listed.</p>}
            </div>
          )}
          <div className="mt-8 grid grid-cols-1 gap-5 lg:grid-cols-2 lg:items-start">
            {visible.map((holding, index) => (
              <HoldingCard
                key={holding.nodeId}
                holding={holding}
                destinations={destinations}
                today={today}
                index={index}
                announce={(lines) => setNotice({ tone: "success", lines })}
              />
            ))}
          </div>
        </>
      )}

      <NoticeToast notice={notice} onDismiss={() => setNotice(null)} statusRef={statusRef} />
    </main>
  )
}
