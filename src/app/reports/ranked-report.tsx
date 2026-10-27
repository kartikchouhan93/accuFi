"use client"

import { ChevronRight, Undo2 } from "lucide-react"
import { useId, useState } from "react"
import { ChartFrame, type ChartTableData } from "@/components/charts/chart-frame"
import { formatShare, RankedBars, type RankedBarRow } from "@/components/charts/ranked-bars"
import { Collapse } from "@/components/ui/collapse"
import { SpotlightCard } from "@/components/ui/spotlight-card"
import { Tag } from "@/components/ui/tag"
import { formatPaiseText } from "@/lib/node-money"
import { isNegative } from "@/lib/report-text"
import type { RankedRowView, RankedView } from "@/lib/report-view"
import { formatDay } from "@/lib/transaction-text"
import { cn } from "@/lib/utils"
import { DrillLink } from "./drill-link"
import { NothingToReport } from "./report-notes"

// Spending, or income, ranked: the biggest first, each with its share of the whole, as the server ranked them
// (RankedView). Every name opens the entries it is made of. A parent opens to what it is made of: its own entries
// ("Direct") and each child's, signed, since a child can take in more than it spent ("net refund"); the children have no
// share, because a share of a parent that a refund has shrunk can pass 100%. A ledger that took in more than it spent
// over the range is not ranked at all: it is listed apart under "Net refunds". The total at the foot is every reportable
// entry of the range, so it is the ranked rows less the net refunds, and it opens those entries too.

const WORDS = {
  EXPENSE: { title: "Where the money went", column: "Expense", total: "Total spending", verb: "spent", nothing: "Nothing was spent" },
  INCOME_SOURCE: { title: "Where the money came from", column: "Income source", total: "Total income", verb: "came in", nothing: "Nothing came in" },
} as const

function Marks({ row }: { row: Pick<RankedRowView, "fromSales" | "archived"> }) {
  return (
    <>
      {row.fromSales && <Tag>from investment sales</Tag>}
      {row.archived && <Tag>archived</Tag>}
    </>
  )
}

/** A signed amount, with "net refund" beside one that came back. */
function Signed({ paise }: { paise: string }) {
  return (
    <span className="figures whitespace-nowrap">
      {formatPaiseText(paise)}
      {isNegative(paise) && <span className="ml-1.5 text-sm font-normal text-fg-soft">net refund</span>}
    </span>
  )
}

/** What a parent row is made of: its own entries, then each child, signed and without a share. */
export function RankedBreakdown({ row }: { row: RankedRowView }) {
  const lines = [
    { key: "direct", name: "Direct", context: ` entries of ${row.name}`, paise: row.directPaise, drill: { ...row.drill, node: [row.id] }, marks: null },
    ...row.children.map((child) => ({ key: child.id, name: child.name, context: undefined, paise: child.paise, drill: child.drill, marks: <Marks row={child} /> })),
  ]
  return (
    <ul className="mt-2 space-y-0.5 border-l border-line pl-4 text-[15px]">
      {lines.map((line) => (
        <li key={line.key} className="flex items-baseline justify-between gap-4 py-1">
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <DrillLink drill={line.drill} context={line.context} className={cn(line.key === "direct" && "text-fg-soft")}>
              {line.name}
            </DrillLink>
            {line.marks}
          </span>
          <span className="flex shrink-0 items-baseline gap-3">
            <Signed paise={line.paise} />
            {/* Under the parent's share column, so its amounts line up with the parent's. */}
            {row.shareTenths !== null && <i aria-hidden className="w-14" />}
          </span>
        </li>
      ))}
    </ul>
  )
}

function RowLabel(props: { row: RankedRowView; open: boolean; panelId: string; onToggle: () => void; indent: boolean }) {
  const { row, open, panelId, onToggle, indent } = props
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 whitespace-normal">
      {/* A row with nothing to open keeps its name in line with the rows that have a toggle. */}
      {row.children.length === 0 && indent && <span aria-hidden className="size-6 shrink-0" />}
      {row.children.length > 0 && (
        <button
          type="button"
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          onClick={onToggle}
          className="grid size-6 shrink-0 place-items-center rounded-md text-fg-soft transition-colors hover:bg-panel hover:text-fg"
        >
          <ChevronRight aria-hidden className={cn("size-4 transition-transform duration-200", open && "rotate-90")} />
          <span className="sr-only">Breakdown of {row.name}</span>
        </button>
      )}
      <DrillLink drill={row.drill}>{row.name}</DrillLink>
      <Marks row={row} />
    </span>
  )
}

function tableOf(view: RankedView): ChartTableData {
  const words = WORDS[view.kind]
  const rows: ChartTableData["rows"] = []
  for (const row of view.rows) {
    rows.push({ label: row.name, cells: [formatPaiseText(row.paise), row.shareTenths === null ? "" : formatShare(row.shareTenths)] })
    if (row.children.length > 0) {
      rows.push({ label: `${row.name}: direct`, cells: [formatPaiseText(row.directPaise), ""] })
      for (const child of row.children) rows.push({ label: `${row.name}: ${child.name}`, cells: [formatPaiseText(child.paise), ""] })
    }
  }
  for (const refund of view.refunds) rows.push({ label: `${refund.name} (net refund)`, cells: [formatPaiseText(refund.paise), ""] })
  rows.push({ label: words.total, cells: [formatPaiseText(view.totalPaise), ""] })
  return { columns: [words.column, "Amount", "Share"], rows }
}

function summaryOf(view: RankedView): string {
  const words = WORDS[view.kind]
  const span = `from ${formatDay(view.range.from)} to ${formatDay(view.range.to)}`
  if (view.rows.length === 0 && view.refunds.length === 0) return `${words.nothing} ${span}.`
  const top = view.rows[0]
  const lead = top && top.shareTenths !== null ? ` ${top.name} is the largest, at ${formatShare(top.shareTenths)}.` : ""
  return `${formatPaiseText(view.totalPaise)} ${words.verb} ${span}.${lead}`
}

export function RankedReport({ view }: { view: RankedView }) {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set())
  const id = useId()
  if (view.empty) return <NothingToReport />
  const words = WORDS[view.kind]
  const toggle = (rowId: string) =>
    setOpen((current) => {
      const next = new Set(current)
      if (!next.delete(rowId)) next.add(rowId)
      return next
    })

  const indent = view.rows.some((row) => row.children.length > 0)
  const ranked: RankedBarRow[] = view.rows.map((row) => {
    const panelId = `${id}-${row.id}`
    const isOpen = open.has(row.id)
    return {
      key: row.id,
      label: <RowLabel row={row} open={isOpen} panelId={panelId} onToggle={() => toggle(row.id)} indent={indent} />,
      amount: formatPaiseText(row.paise),
      shareTenths: row.shareTenths,
      detail:
        row.children.length > 0 ? (
          <Collapse open={isOpen} id={panelId}>
            <RankedBreakdown row={row} />
          </Collapse>
        ) : undefined,
    }
  })
  const refunds: RankedBarRow[] = view.refunds.map((row) => ({
    key: row.id,
    label: (
      <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 whitespace-normal">
        <DrillLink drill={row.drill}>{row.name}</DrillLink>
        <Marks row={row} />
      </span>
    ),
    amount: formatPaiseText(row.paise),
    shareTenths: null,
    muted: true,
  }))

  return (
    <div className="rise space-y-6">
      <ChartFrame title={words.title} summary={summaryOf(view)} table={tableOf(view)}>
        {ranked.length > 0 ? (
          <div className="-mx-3">
            <RankedBars rows={ranked} />
          </div>
        ) : (
          <p className="text-sm text-fg-soft">{words.nothing} in this range.</p>
        )}
        {/* One link for the whole line: the total and the entries it is made of. */}
        <div className="mt-4 border-t-2 border-line-strong pt-3">
          <DrillLink drill={view.totalDrill} className="flex items-baseline justify-between gap-4 py-1 font-semibold">
            <span>{words.total}</span>
            <span className="figures flex items-baseline gap-3">
              {formatPaiseText(view.totalPaise)}
              {/* Under the shares above, so the amounts line up. */}
              {ranked.some((row) => row.shareTenths !== null) && <i aria-hidden className="w-14" />}
            </span>
          </DrillLink>
        </div>
        {view.refunds.length > 0 && <p className="mt-1 text-sm text-fg-soft">After the net refunds below.</p>}
      </ChartFrame>

      {view.refunds.length > 0 && (
        <SpotlightCard as="section" aria-labelledby="net-refunds" className="surface rounded-3xl p-5 sm:p-6" radius={420} strength={8}>
          <h2 id="net-refunds" className="flex items-center gap-2 font-display text-lg font-semibold tracking-tight">
            <Undo2 aria-hidden className="size-4 text-fg-soft" />
            Net refunds
          </h2>
          <p className="mt-1 text-sm text-fg-soft">
            {view.kind === "EXPENSE"
              ? "More came back to these than was spent on them in this range, so they are not ranked."
              : "More was paid back from these than came in from them in this range, so they are not ranked."}
          </p>
          <div className="-mx-3 mt-3">
            <RankedBars rows={refunds} />
          </div>
        </SpotlightCard>
      )}
    </div>
  )
}
