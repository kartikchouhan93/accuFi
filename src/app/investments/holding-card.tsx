"use client"

import { Building2, ChevronDown, CircleAlert, HandCoins, PiggyBank, Scale } from "lucide-react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useEffect, useId, useRef, useState } from "react"
import { Amount } from "@/app/amount"
import { PriceLine } from "@/app/price-line"
import { Collapse } from "@/components/ui/collapse"
import { GlowingEffect } from "@/components/ui/glowing-effect"
import { SpotlightCard } from "@/components/ui/spotlight-card"
import { buttonClass } from "@/components/ui/styles"
import { Switch } from "@/components/ui/switch"
import { Tag } from "@/components/ui/tag"
import type { CalendarDate } from "@/domain/calendar-date"
import type { HoldingDetail, HoldingView } from "@/lib/investment-view"
import { quantityText } from "@/lib/investment-text"
import { describeBalance, formatPaiseText } from "@/lib/node-money"
import type { PickerNode } from "@/lib/transaction-list-view"
import { cn } from "@/lib/utils"
import type { ActionResult } from "@/server/action-support"
import { getHoldingAction } from "./actions"
import { Gain } from "./gain"
import { LotTable } from "./lot-table"
import { SellForm } from "./sell-form"

// One investment: what it is worth, what it cost and the gain, with the price behind the value and its day. Opening the
// holding shows the figures in full and, on request, the lots, which are read from the server when the card is opened (no
// id ever goes into the URL). "Sell / redeem" opens the Sell form in the card.
//
// An investment that cannot be valued shows no figure for its value, only "Not valued" and why (EC-23), with the way to
// fix it. One valued by what was put into it is not revalued: its figure is that money, it has no lots and nothing to
// sell here (EC-28), because money in and out of it is an ordinary transaction.

interface Props {
  holding: HoldingView
  destinations: PickerNode[]
  today: CalendarDate
  index: number
  /** Show a message; with `moveFocus`, the message takes the keyboard's focus (the control that had it is gone). */
  announce: (lines: string[], moveFocus?: boolean) => void
}

const MODE_ICON = { QUANTITY: Scale, LUMP: Building2, CONTRIBUTION_ONLY: PiggyBank } as const

function subtitle(holding: HoldingView): string {
  switch (holding.valuationMode) {
    case "QUANTITY":
      return holding.unitLabel ? `Valued by quantity, in ${holding.unitLabel}` : "Valued by quantity"
    case "LUMP":
      return "Valued as one lump sum"
    default:
      return "Valued by what was put in"
  }
}

const linkClass = "rounded-md font-medium text-link underline underline-offset-4"

/**
 * The detail read for one state of the holding: kept with the figures it was read for, so a stale read is never shown.
 * `result` is null when the request itself failed (the network, the server), rather than being refused.
 */
interface Loaded {
  version: string
  attempt: number
  result: ActionResult<HoldingDetail> | null
}

export function HoldingCard({ holding, destinations, today, index, announce }: Props) {
  const router = useRouter()
  const headingId = useId()
  const panelId = useId()
  const sellId = useId()
  const [open, setOpen] = useState(false)
  const [selling, setSelling] = useState(false)
  const [showLots, setShowLots] = useState(false)
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [attempt, setAttempt] = useState(0)
  const sellButton = useRef<HTMLButtonElement>(null)

  const lotMode = holding.valuationMode === "QUANTITY" || holding.valuationMode === "LUMP"
  const lump = holding.valuationMode === "LUMP"
  const unit = holding.unitLabel || null
  const held = holding.quantityHeld !== "0"
  const canSell = lotMode && held && !holding.archived
  const Icon = MODE_ICON[holding.valuationMode ?? "CONTRIBUTION_ONLY"]

  // What the server said the holding is now. When it changes (a sale, a refresh), the lots are read again.
  const version = [holding.quantityHeld, holding.costBasisPaise, holding.valuePaise, holding.lotCount].join("|")
  const fresh = loaded !== null && loaded.version === version && loaded.attempt === attempt ? loaded : null

  useEffect(() => {
    if (!open || !lotMode) return
    let current = true
    getHoldingAction({ nodeId: holding.nodeId }).then(
      (result) => current && setLoaded({ version, attempt, result }),
      () => current && setLoaded({ version, attempt, result: null }),
    )
    return () => {
      current = false
    }
  }, [open, lotMode, holding.nodeId, version, attempt])

  return (
    <SpotlightCard
      as="section"
      aria-labelledby={headingId}
      // Opened, a card takes the full width of the grid, so its holding and the Sell form sit side by side on a wide screen
      // rather than stretching one column far below its neighbour.
      className={cn("surface rise rounded-3xl p-5 sm:p-6", (open || selling) && "lg:col-span-2")}
      style={{ "--i": index + 1 } as React.CSSProperties}
      radius={360}
      strength={10}
    >
      <GlowingEffect />
      <div className="flex items-start gap-3">
        <span aria-hidden className="grid size-10 shrink-0 place-items-center rounded-xl bg-panel-raised text-fg-soft">
          <Icon className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 id={headingId} className="font-display text-lg font-semibold tracking-tight">
              {holding.name}
            </h2>
            {!lotMode && <Tag>Not revalued</Tag>}
            {holding.archived && <Tag>Archived</Tag>}
          </div>
          <p className="text-sm text-fg-soft">{subtitle(holding)}</p>
        </div>
      </div>

      <Figures holding={holding} unit={unit} />

      {lotMode && (
        <div className="mt-5 flex flex-wrap gap-2">
          <button
            type="button"
            aria-expanded={open}
            aria-controls={open ? panelId : undefined}
            onClick={() => setOpen((current) => !current)}
            className={buttonClass({ variant: "secondary", size: "sm" })}
          >
            Holding
            <ChevronDown aria-hidden className={cn("size-4 transition-transform duration-200", open && "rotate-180")} />
          </button>
          {canSell && (
            <button
              type="button"
              ref={sellButton}
              aria-expanded={selling}
              aria-controls={selling ? sellId : undefined}
              onClick={() => setSelling((current) => !current)}
              className={buttonClass({ size: "sm" })}
            >
              <HandCoins aria-hidden className="size-4" />
              Sell / redeem
            </button>
          )}
        </div>
      )}

      <div className={cn("grid grid-cols-1 gap-x-6", open && selling && "lg:grid-cols-2 lg:items-start")}>
      {lotMode && (
        <Collapse open={open} id={panelId} className="min-w-0">
          <div className="pt-4 text-sm">
            <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 rounded-xl border border-line bg-canvas/60 p-3">
              <dt className="text-fg-soft">Held</dt>
              <dd className="figures">{lump ? (held ? "The whole of it" : "Nothing") : quantityText(holding.quantityHeld, unit)}</dd>
              <dt className="text-fg-soft">Cost basis</dt>
              <dd className="figures">{holding.notValued === "NEEDS_QUANTITY" ? "Not known" : formatPaiseText(holding.costBasisPaise)}</dd>
              <dt className="text-fg-soft">Value</dt>
              <dd className="figures">{holding.valuePaise === null ? "Not valued" : formatPaiseText(holding.valuePaise)}</dd>
              <dt className="text-fg-soft">Purchases</dt>
              <dd className="figures">{holding.lotCount}</dd>
            </dl>
            <Switch checked={showLots} onChange={setShowLots} className="mt-4">
              Show lots
            </Switch>
            <Collapse open={showLots}>
              <div className="pt-3">
                {fresh === null ? (
                  <p className="text-fg-soft">Reading the lots…</p>
                ) : fresh.result?.ok ? (
                  <LotTable name={holding.name} unit={unit} lots={fresh.result.data.lots} />
                ) : (
                  <div role="alert" className="flex flex-wrap items-start gap-2.5 rounded-xl bg-negative-wash px-3.5 py-2.5 font-medium text-negative">
                    <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
                    <span className="flex-1">
                      Could not read the lots. {fresh.result ? fresh.result.error.message : "Try again."}
                    </span>
                    <button type="button" className={linkClass} onClick={() => setAttempt((n) => n + 1)}>
                      Try again
                    </button>
                  </div>
                )}
              </div>
            </Collapse>
          </div>
        </Collapse>
      )}

      {canSell && (
        <Collapse open={selling} id={sellId} className="min-w-0">
          <div className="pt-4">
            <SellForm
              holding={holding}
              destinations={destinations}
              today={today}
              onCancel={() => {
                setSelling(false)
                sellButton.current?.focus() // the form had the focus; it goes back to what opened it
              }}
              onSold={(lines) => {
                setSelling(false)
                announce(lines, true)
                router.refresh()
              }}
            />
          </div>
        </Collapse>
      )}
      </div>

      {!lotMode && (
        <p className="mt-4 text-sm text-fg-soft">
          Money into and out of it is recorded on the{" "}
          <Link href="/transactions" className={linkClass}>
            Transactions
          </Link>{" "}
          screen.
        </p>
      )}
    </SpotlightCard>
  )
}

/** The value and the gain, or "Not valued" and why; and the price the value rests on, with its day. */
function Figures({ holding, unit }: { holding: HoldingView; unit: string | null }) {
  const lotMode = holding.valuationMode === "QUANTITY" || holding.valuationMode === "LUMP"
  const perUnit = holding.valuationMode === "QUANTITY" // a lump's price is the whole holding's, so it is not "per" anything

  if (holding.notValued !== null) {
    return (
      <div className="mt-5">
        <p className="text-2xl font-medium tracking-tight text-fg-soft">Not valued</p>
        {holding.notValued === "NO_PRICE" ? (
          <p className="mt-1 text-sm text-fg-soft">
            No price yet.{" "}
            <Link href="/investments/prices" className={linkClass}>
              Record a price
            </Link>
          </p>
        ) : (
          <p className="mt-1 max-w-prose text-sm text-fg-soft">
            Some purchases have no quantity, so how much is held is not known. Edit those transactions on the{" "}
            {/* Every month, not only the current one: the purchases without a quantity are usually older than this month. */}
            <Link href="/transactions?from=&to=" className={linkClass}>
              Transactions
            </Link>{" "}
            screen to add one.
          </p>
        )}
      </div>
    )
  }

  if (lotMode && holding.quantityHeld === "0") {
    return (
      <div className="mt-5">
        <p className="text-2xl font-medium tracking-tight text-fg-soft">Nothing held</p>
        <p className="mt-1 text-sm text-fg-soft">Everything bought has been sold.</p>
      </div>
    )
  }

  // Not valued without a reason should not happen; if it does, it is still not a figure (EC-23).
  if (holding.valuePaise === null) return <p className="mt-5 text-2xl font-medium tracking-tight text-fg-soft">Not valued</p>

  const value = describeBalance("INVESTMENT", holding.valuePaise)
  return (
    <div className="mt-5 flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
      <div>
        {!lotMode && <p className="text-sm text-fg-soft">Put in</p>}
        <Amount text={value} className="block font-display text-3xl font-semibold tracking-tight" />
        {lotMode && holding.unrealisedGainPaise !== null && (
          <Gain paise={holding.unrealisedGainPaise} points={holding.gainBasisPoints} className="mt-0.5 block text-sm font-medium" />
        )}
      </div>
      {holding.price && (
        <div className="flex flex-col items-start gap-0.5 sm:items-end">
          {perUnit && (
            <span className="figures text-sm font-medium">
              {formatPaiseText(holding.price.pricePerUnitPaise)} per {unit ?? "unit"}
            </span>
          )}
          <PriceLine priced={holding.price} className="sm:justify-end" />
        </div>
      )}
    </div>
  )
}
