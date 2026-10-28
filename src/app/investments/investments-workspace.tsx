"use client"

import { ChevronDown, LineChart, Plus } from "lucide-react"
import Link from "next/link"
import { useEffect, useId, useRef, useState } from "react"
import { Collapse } from "@/components/ui/collapse"
import { NoticeToast, type ToastNotice } from "@/components/ui/notice-toast"
import { buttonClass } from "@/components/ui/styles"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"
import type { CalendarDate } from "@/domain/calendar-date"
import type { Portfolio } from "@/lib/investment-view"
import { describeArchivedLine } from "@/lib/node-overview"
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
  // An archived investment that cannot be valued is in no total, so it is never said to be included.
  const archivedUnvalued = portfolio.holdings.filter((holding) => holding.archived && holding.notValued !== null).length
  const visible = showArchived ? portfolio.holdings : portfolio.holdings.filter((holding) => !holding.archived)

  // The investment growth report links to one card (`#holding-<id>`). The browser's own jump to it is not to be relied on:
  // the cards may stream in after it has looked for the id, and an archived card is not drawn until asked for. So, on
  // arrival only (a refresh after a sale leaves the page where it is), the card is brought into view here, after the
  // archived cards are shown when it is one of them.
  const anchor = useRef<string | null>(null)
  useEffect(() => {
    const hash = window.location.hash
    const target = portfolio.holdings.find((holding) => `#holding-${holding.nodeId}` === hash)
    if (!target) return
    const scroll = () => document.getElementById(hash.slice(1))?.scrollIntoView()
    if (!target.archived) {
      requestAnimationFrame(scroll)
      return
    }
    anchor.current = hash.slice(1)
    requestAnimationFrame(() => setShowArchived(true))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- on arrival only, not when a sale refreshes the holdings
  }, [])
  useEffect(() => {
    if (!showArchived || anchor.current === null) return
    document.getElementById(anchor.current)?.scrollIntoView()
    anchor.current = null
  }, [showArchived])

  // A sale closes the form that had the keyboard's focus; the message is where focus lands, as on the other screens.
  function announce(lines: string[], moveFocus = false) {
    setNotice({ tone: "success", lines })
    if (moveFocus) requestAnimationFrame(() => statusRef.current?.focus())
  }

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
            <Limits />
          </div>
          {archivedCount > 0 && (
            <div className="mt-8 flex flex-wrap items-center gap-x-4 gap-y-2">
              <Switch checked={showArchived} onChange={setShowArchived}>
                Show archived
              </Switch>
              {!showArchived && (
                <p className="text-sm text-fg-soft">
                  {archivedUnvalued === 0
                    ? `The totals include ${archivedCount} archived, not listed.`
                    : describeArchivedLine(archivedCount, archivedUnvalued)}
                </p>
              )}
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
                announce={announce}
              />
            ))}
          </div>
        </>
      )}

      <NoticeToast notice={notice} onDismiss={() => setNotice(null)} statusRef={statusRef} />
    </main>
  )
}

/** What M2 leaves out, said where a user would look for it, quietly and on request. */
function Limits() {
  const panelId = useId()
  const [open, setOpen] = useState(false)
  return (
    <div className="mt-3 text-sm">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((current) => !current)}
        className="inline-flex items-center gap-1 rounded-md font-medium text-fg-soft underline-offset-4 hover:underline"
      >
        What this screen does not do
        <ChevronDown aria-hidden className={cn("size-4 transition-transform duration-200", open && "rotate-180")} />
      </button>
      <Collapse open={open} id={panelId}>
        <p className="max-w-xl pt-2 text-fg-soft">
          Switching funds and paying fees out of an investment are not supported yet: sell, then buy. A sale cannot be edited:
          delete it and enter it again.
        </p>
      </Collapse>
    </div>
  )
}
