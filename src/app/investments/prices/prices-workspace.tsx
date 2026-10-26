"use client"

import { ArrowLeft, LineChart, Plus } from "lucide-react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useEffect, useRef, useState } from "react"
import { GlowingEffect } from "@/components/ui/glowing-effect"
import { NoticeToast, type ToastNotice } from "@/components/ui/notice-toast"
import { SpotlightCard } from "@/components/ui/spotlight-card"
import { buttonClass } from "@/components/ui/styles"
import type { CalendarDate } from "@/domain/calendar-date"
import type { HoldingDetail } from "@/lib/investment-view"
import { priceText } from "@/lib/investment-text"
import { formatDay, paiseTextToRupees } from "@/lib/transaction-text"
import type { ActionResult } from "@/server/action-support"
import { getHoldingAction, recordPriceAction } from "../actions"
import { PriceForm, type KnownPrice, type PriceTarget } from "./price-form"
import { PriceHistory, type HistoryState } from "./price-history"

// The client half of the price screen: the form, the chosen investment's prices beside it, and the one message area they
// share. The chosen investment is state, never the URL. Its prices are read from the server when it is chosen and again
// after every write; an answer for an investment no longer chosen, or one overtaken by a newer read, is dropped. After a
// write the server component is asked again too (router.refresh), so which investments need a quantity, and what each
// holds, are the server's word.

interface Props {
  targets: PriceTarget[]
  /** How many investments are valued by what was put in: they take no price, so they are not offered. */
  contributionOnly: number
  today: CalendarDate
}

/** The prices read for one investment, at one revision of the screen's writes. `result` is null when the request failed. */
interface Loaded {
  nodeId: string
  revision: number
  result: ActionResult<HoldingDetail> | null
}

export function PricesWorkspace({ targets, contributionOnly, today }: Props) {
  const router = useRouter()
  const statusRef = useRef<HTMLDivElement>(null)
  const [notice, setNotice] = useState<ToastNotice | null>(null)
  // With one investment to price there is nothing to choose between.
  const [selected, setSelected] = useState(targets.length === 1 ? targets[0].nodeId : "")
  const [revision, setRevision] = useState(0)
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  // A delete takes its row off at once, before the prices are read again, so the list never shows what is gone.
  const [removed, setRemoved] = useState<{ nodeId: string; asOf: CalendarDate } | null>(null)

  const target = targets.find((candidate) => candidate.nodeId === selected)

  useEffect(() => {
    if (selected === "") return
    let current = true
    getHoldingAction({ nodeId: selected }).then(
      (result) => current && setLoaded({ nodeId: selected, revision, result }),
      () => current && setLoaded({ nodeId: selected, revision, result: null }),
    )
    return () => {
      current = false // chosen again, or written to since: this answer is out of date
    }
  }, [selected, revision])

  // What was last read for the chosen investment, while a newer read is out too: the list does not blink after a save.
  const forSelected = loaded !== null && loaded.nodeId === selected ? loaded : null
  const history: HistoryState =
    forSelected === null
      ? { status: "reading" }
      : forSelected.result === null
        ? { status: "failed", message: "Try again." }
        : !forSelected.result.ok
          ? { status: "failed", message: forSelected.result.error.message }
          : {
              status: "read",
              prices: forSelected.result.data.prices.filter(
                (point) => !(removed?.nodeId === selected && removed.asOf === point.asOf && forSelected.revision < revision),
              ),
              latest: forSelected.result.data.price,
            }
  const known = history.status === "read" ? history.prices : null

  // A save or a delete takes the control that had the focus away (a cleared field, a deleted row): the message has it.
  function announce(next: ToastNotice) {
    setNotice(next)
    requestAnimationFrame(() => statusRef.current?.focus())
  }

  function written() {
    setRevision((n) => n + 1)
    router.refresh()
  }

  function deleted(point: KnownPrice) {
    if (target === undefined) return
    const nodeId = target.nodeId
    const what = `the price for ${formatDay(point.asOf)} (${priceText(point.pricePerUnitPaise, target.unit, target.lump)})`
    setRemoved({ nodeId, asOf: point.asOf })
    written()
    announce({
      tone: "success",
      lines: [`Deleted ${what}.`],
      // Putting it back is saving the same price for the same day: nothing else was lost with it.
      undo: {
        label: "Undo",
        run: () =>
          void recordPriceAction({ nodeId, asOf: point.asOf, price: paiseTextToRupees(point.pricePerUnitPaise) }).then(
            (result) => {
              if (result.ok) {
                announce({ tone: "success", lines: [`Put back ${what}.`] })
                written()
              } else announce({ tone: "warning", lines: [`Could not put back ${what}. ${result.error.message}`] })
            },
            () => announce({ tone: "warning", lines: [`Could not put back ${what} just now. Check your connection and try again.`] }),
          ),
      },
    })
  }

  return (
    <main className="mx-auto max-w-6xl px-4 pb-28 pt-8 sm:px-8">
      <Link href="/investments" className={buttonClass({ variant: "ghost", size: "sm", className: "-ml-3.5" })}>
        <ArrowLeft aria-hidden className="size-4" />
        Investments
      </Link>
      <h1 className="mt-3 font-display text-3xl font-semibold tracking-tight sm:text-4xl">Record prices</h1>
      <p className="mt-2 max-w-prose text-fg-soft">
        The price of one unit on a day values what you hold. A day can have one price: saving another for it replaces it.
      </p>

      {targets.length === 0 ? (
        <section aria-labelledby="nothing-to-price" className="surface mt-8 max-w-xl rounded-3xl p-8">
          <h2 id="nothing-to-price" className="font-display text-2xl font-semibold tracking-tight">
            Nothing to price
          </h2>
          <p className="mt-2 text-fg-soft">
            {contributionOnly > 0
              ? "Your investments are valued by what was put into them, so they take no price. One valued by quantity, like gold or a fund, or as a lump, like a property, is priced here."
              : "Add an investment valued by quantity, like gold or a fund, or as a lump, like a property, and its prices are entered here."}
          </p>
          <Link href="/nodes" className={buttonClass({ className: "mt-6" })}>
            <Plus aria-hidden className="size-4" />
            Add an investment
          </Link>
        </section>
      ) : (
        <div className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.85fr)] lg:items-start">
          <SpotlightCard as="section" aria-labelledby="record-a-price" className="surface rise rounded-3xl p-5 sm:p-6" radius={380} strength={10}>
            <GlowingEffect />
            <div className="mb-5 flex items-center gap-3">
              <span aria-hidden className="grid size-10 shrink-0 place-items-center rounded-xl bg-panel-raised text-fg-soft">
                <LineChart className="size-5" />
              </span>
              <h2 id="record-a-price" className="font-display text-lg font-semibold tracking-tight">
                Record a price
              </h2>
            </div>
            <PriceForm
              targets={targets}
              selected={selected}
              onSelect={setSelected}
              today={today}
              known={known}
              revision={revision}
              onSaved={(lines) => {
                announce({ tone: "success", lines })
                written()
              }}
            />
          </SpotlightCard>

          <div className="surface rise rounded-3xl p-5 sm:p-6" style={{ "--i": 1 } as React.CSSProperties}>
            {target ? (
              <PriceHistory target={target} state={history} onRetry={() => setRevision((n) => n + 1)} onDeleted={deleted} />
            ) : (
              <section aria-labelledby="price-history">
                <h2 id="price-history" className="font-display text-lg font-semibold tracking-tight">
                  Price history
                </h2>
                <p className="mt-3 text-sm text-fg-soft">Choose an investment to see its prices.</p>
              </section>
            )}
          </div>
        </div>
      )}

      <NoticeToast notice={notice} onDismiss={() => setNotice(null)} statusRef={statusRef} />
    </main>
  )
}
