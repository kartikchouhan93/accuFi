"use client"

import { ChevronDown, Pencil } from "lucide-react"
import Link from "next/link"
import { useId, useState } from "react"
import { Amount } from "@/app/amount"
import { figure } from "@/app/feedback"
import type { Announce } from "@/app/transactions/notice"
import { Collapse } from "@/components/ui/collapse"
import { GlowingEffect } from "@/components/ui/glowing-effect"
import { SpotlightCard } from "@/components/ui/spotlight-card"
import { buttonClass } from "@/components/ui/styles"
import { Tag } from "@/components/ui/tag"
import { monthLabel, spanLabel, type BudgetCard } from "@/lib/budget-view"
import { formatPaiseText } from "@/lib/node-money"
import { deserialisePaise } from "@/lib/serialise"
import { cn } from "@/lib/utils"
import { absolutePaise, barWidth, cardDeleteText, percentText } from "./budget-text"
import { DeleteButton, DeleteConfirm, useDeleteBudget } from "./delete-budget"
import { HistoryTable } from "./history-table"
import { BAR_FILL, StatusChip } from "./status-chip"

// One budget for the month on screen: the ledger it is on (and the sub-ledgers it counts), the cap and anything carried
// over, what was used, what is left (or how far over), a bar for the share used, where the month ends at this pace, and the
// months before. The bar stops at full while the figures go on being exact: 250% used is a full bar and "250.0% used".
// A month of net refunds has negative used and an empty bar, and is never called over. Delete is behind a confirm.
//
// Every figure is printed from paise text; nothing here turns it into a JS number.

interface Props {
  card: BudgetCard
  /** The month the screen is on ("YYYY-MM-01"): what the card's figures are for. */
  month: string
  index: number
  announce: Announce
}

const DEFINITION = "min-w-0"
const TERM = "text-sm text-fg-soft"

export function BudgetCardItem({ card, month, index, announce }: Props) {
  const historyId = useId()
  const [showHistory, setShowHistory] = useState(false)
  const del = useDeleteBudget(card, announce)

  const used = deserialisePaise(card.usedPaise)
  const remaining = deserialisePaise(card.remainingPaise)
  const over = remaining < 0n
  const refund = used < 0n
  const percent = percentText(card.percentTenths)
  const width = barWidth(card)
  const carried = card.rollover && deserialisePaise(card.carryPaise) > 0n
  const subLedgers = card.countedNames.length

  return (
    <SpotlightCard as="li" className="surface rise rounded-2xl p-4 sm:p-5" style={{ "--i": index } as React.CSSProperties} radius={300} strength={10}>
      <GlowingEffect />
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
          <h3 className="min-w-0 font-display text-lg font-semibold tracking-tight [overflow-wrap:anywhere]">{card.name}</h3>
          {card.archived && <Tag>Archived</Tag>}
          <StatusChip status={card.status} />
        </div>
        {subLedgers > 0 && (
          <p className="mt-1 text-sm text-fg-soft [overflow-wrap:anywhere]">
            Includes {subLedgers} {subLedgers === 1 ? "sub-ledger" : "sub-ledgers"}: {card.countedNames.join(", ")}
          </p>
        )}
        <p className="text-sm text-fg-soft">{spanLabel(card.startMonth, card.endMonth)}</p>
      </div>

      <dl className="mt-4 flex flex-wrap gap-x-8 gap-y-3">
        <div className={DEFINITION}>
          <dt className={TERM}>Used</dt>
          <dd className="text-xl font-medium tracking-tight">
            <Link
              href={card.drillHref}
              className="rounded-md underline decoration-line-strong decoration-1 underline-offset-4 transition-colors hover:decoration-accent-edge"
            >
              <Amount text={refund ? { amount: formatPaiseText(card.usedPaise), qualifier: "net refund", tone: "neutral" } : figure(card.usedPaise)} />
              <span className="sr-only"> {card.name} spending in {monthLabel(month)}, see the entries</span>
            </Link>
          </dd>
        </div>
        <div className={DEFINITION}>
          <dt className={TERM}>{over ? "Over by" : "Remaining"}</dt>
          <dd className="text-xl font-medium tracking-tight">
            {over ? <Amount text={{ ...figure(absolutePaise(card.remainingPaise)), tone: "negative" }} /> : <Amount text={figure(card.remainingPaise)} />}
          </dd>
        </div>
        <div className={DEFINITION}>
          <dt className={TERM}>Budget</dt>
          <dd className="text-xl font-medium tracking-tight">
            <Amount text={figure(card.amountPaise)} />
            {carried && (
              <span className="block text-sm font-normal text-fg-soft">
                + <Amount text={figure(card.carryPaise)} /> carried over
              </span>
            )}
          </dd>
        </div>
      </dl>

      <div aria-hidden className="mt-4 h-2.5 w-full overflow-hidden rounded-full bg-line">
        <div
          data-bar={width}
          className={cn("h-full rounded-full transition-[width] duration-500 motion-reduce:transition-none", BAR_FILL[card.status])}
          style={{ width: `${width}%` }}
        />
      </div>
      {percent !== null && <p className="figures mt-1.5 text-sm text-fg-soft">{percent} used</p>}

      {card.projectionPaise !== null && (
        <p className={cn("mt-2 text-sm", card.overAtPace ? "font-medium text-negative" : "text-fg-soft")}>
          {card.overAtPace ? "Over at this pace" : "At this pace"}: <Amount text={{ ...figure(card.projectionPaise), tone: card.overAtPace ? "negative" : "muted" }} /> by month end
        </p>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Link href={`/budgets/${card.budgetId}/edit`} className={buttonClass({ variant: "secondary", size: "sm" })}>
          <Pencil aria-hidden className="size-4" />
          Edit<span className="sr-only"> {card.name} budget</span>
        </Link>
        <DeleteButton control={del} name={card.name} />
        {card.history.length > 1 && (
          <button
            type="button"
            aria-expanded={showHistory}
            aria-controls={showHistory ? historyId : undefined}
            onClick={() => setShowHistory((current) => !current)}
            className={buttonClass({ variant: "ghost", size: "sm" })}
          >
            <ChevronDown aria-hidden className={cn("size-4 transition-transform motion-reduce:transition-none", showHistory && "rotate-180")} />
            Past months<span className="sr-only"> for {card.name}</span>
          </button>
        )}
      </div>

      <DeleteConfirm control={del} name={card.name}>
        {cardDeleteText(card)}
      </DeleteConfirm>

      {card.history.length > 1 && (
        <Collapse open={showHistory} id={historyId}>
          <HistoryTable name={card.name} rows={card.history} />
        </Collapse>
      )}
    </SpotlightCard>
  )
}
