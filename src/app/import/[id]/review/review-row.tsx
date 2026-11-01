"use client"

import { ArrowDownLeft, ArrowUpRight, CircleAlert } from "lucide-react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useMemo, useRef, useState, useTransition } from "react"
import { Amount } from "@/app/amount"
import { attempt, couldNot, figure } from "@/app/feedback"
import type { Announce } from "@/app/transactions/notice"
import { buttonClass, inputClass } from "@/components/ui/styles"
import { calendarDate } from "@/domain/calendar-date"
import { isLegalCounterpart } from "@/domain/import-match"
import type { ImportDirection } from "@/domain/import-map"
import type { ReviewRowView, ReviewScreen } from "@/lib/import-view"
import { formatDay } from "@/lib/transaction-text"
import type { RowChange } from "@/server/services/import-service"
import { applyToSimilarAction, updateRowAction } from "../../actions"

// One staged row, as a card: a plain PENDING row offers a counterpart and Import/Skip; a flagged duplicate or a
// matched recurring occurrence offers its own explicit choices on top of the same counterpart select; READY and
// SKIPPED show what was decided with only Undo; ERRORED shows why and nothing else, since it was never turned into
// anything to decide on. Every action here is the same shape as `delete-budget.tsx`'s: a ref guard against a double
// press, `aria-disabled` so a pending button never drops the keyboard's place, and the result told through the
// shared notice toast with focus moved there (`announce(..., true)`) whenever the row might leave the filter it is
// being shown under — the one way this list can lose a reader's place in the document.

const DIRECTION: Record<ImportDirection, { label: string; Icon: typeof ArrowUpRight }> = {
  OUT: { label: "Out", Icon: ArrowUpRight },
  IN: { label: "In", Icon: ArrowDownLeft },
}

/** The view types carry a day as a plain, already-valid "YYYY-MM-DD" string; `formatDay` wants the branded type, so this
 * re-brands it (`preview-table.tsx` does the same, so both screens write a day identically). */
const day = (value: string) => formatDay(calendarDate(value))

function DirectionChip({ direction }: { direction: ImportDirection }) {
  const { label, Icon } = DIRECTION[direction]
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-line-strong px-2 py-0.5 text-xs font-medium text-fg-soft">
      <Icon aria-hidden className="size-3.5" />
      {label}
    </span>
  )
}

/** A link to the Transactions list, scoped to the matched transaction's other ledger and day: the closest this list
 * supports to "find this one entry" without a dedicated lookup-by-id filter. */
function transactionsHref(duplicate: NonNullable<ReviewRowView["duplicate"]>): string {
  const params = new URLSearchParams({ from: duplicate.occurredAt, to: duplicate.occurredAt })
  return `/transactions?${params.toString()}`
}

/**
 * What `decision: "IMPORT"` sends for a row, whether the user got here via the plain Import button or a
 * duplicate-flagged row's "Import anyway": either way an explicit counterpart choice at review time must win over a
 * stale or coincidental occurrence match, so a row still carrying one is unlinked. The server enforces this itself
 * (`updateRow` clears the link on any IMPORT that is not also a LINK, and commit refuses a linked row whose ledger and
 * rule disagree), so sending UNLINK here is belt and braces, not what correctness rests on. Exported, and shared by
 * both buttons, so the two can never diverge. */
export function buildImportChange(row: Pick<ReviewRowView, "occurrence">, selected: string): RowChange {
  const change: RowChange = { decision: "IMPORT" }
  if (row.occurrence) change.occurrence = "UNLINK"
  if (selected !== "") change.counterpartNodeId = selected
  return change
}

function useRowAction(announce: Announce, locked: boolean) {
  const [pending, startTransition] = useTransition()
  const inFlight = useRef(false)
  const router = useRouter()

  function run(change: RowChange, rowId: string, line: number, verbPhrase: string, successLine: string) {
    if (inFlight.current || locked) return
    inFlight.current = true
    startTransition(async () => {
      try {
        const result = await attempt(() => updateRowAction({ rowId, change }))
        if (result === null || !result.ok) {
          announce({ tone: "warning", lines: [couldNot(`${verbPhrase} line ${line}`, result)] })
          if (result !== null && !result.ok && result.error.code === "not_found") router.refresh()
          return
        }
        announce({ tone: "success", lines: [successLine] }, true)
        router.refresh()
      } finally {
        inFlight.current = false
      }
    })
  }

  return { pending: pending || locked, run }
}

export function ReviewRow({
  row,
  account,
  ledgers,
  siblings,
  announce,
  locked = false,
}: {
  row: ReviewRowView
  account: ReviewScreen["account"]
  ledgers: ReviewScreen["ledgers"]
  siblings: ReviewRowView[]
  announce: Announce
  /** A commit of this batch is in flight: every control is held (aria-disabled) until it settles. */
  locked?: boolean
}) {
  const router = useRouter()
  const { pending, run } = useRowAction(announce, locked)
  const [applying, startApplying] = useTransition()
  const applyInFlight = useRef(false)

  const legalLedgers = useMemo(() => {
    if (!row.direction) return []
    const direction = row.direction
    return ledgers.filter((ledger) => isLegalCounterpart(account, direction, { id: ledger.id, kind: ledger.kind, systemRole: null, archived: ledger.archived, heldByLots: false }))
  }, [ledgers, account, row.direction])

  const suggestedId = row.counterpartNodeId ?? row.occurrence?.otherNodeId ?? null
  const [selected, setSelected] = useState(() => (suggestedId && legalLedgers.some((l) => l.id === suggestedId) ? suggestedId : ""))

  const canApplyToSimilar =
    selected !== "" &&
    row.descriptionKey !== null &&
    siblings.some((other) => other.id !== row.id && other.status === "PENDING" && other.descriptionKey === row.descriptionKey && other.direction === row.direction)

  function doImport() {
    run(buildImportChange(row, selected), row.id, row.line, "import", `Line ${row.line} is ready to import.`)
  }

  function doSkip() {
    run({ decision: "SKIP" }, row.id, row.line, "skip", `Line ${row.line} will be skipped.`)
  }

  function doImportAnyway() {
    run(buildImportChange(row, selected), row.id, row.line, "import", `Line ${row.line} is ready to import, duplicate or not.`)
  }

  function doSkipAsDuplicate() {
    run({ decision: "SKIP" }, row.id, row.line, "skip", `Line ${row.line} will be skipped as a duplicate.`)
  }

  function doLink() {
    if (!row.occurrence) return
    run({ decision: "IMPORT", occurrence: "LINK" }, row.id, row.line, "link", `Line ${row.line} is linked to ${row.occurrence.ruleName} and ready to import.`)
  }

  function doUndo() {
    run({ decision: "UNDO" }, row.id, row.line, "undo", `Line ${row.line} is pending again.`)
  }

  function doApplyToSimilar() {
    if (applyInFlight.current || locked || selected === "") return
    applyInFlight.current = true
    startApplying(async () => {
      try {
        const saved = await attempt(() => updateRowAction({ rowId: row.id, change: { counterpartNodeId: selected } }))
        if (saved === null || !saved.ok) {
          announce({ tone: "warning", lines: [couldNot(`set this ledger on line ${row.line}`, saved)] })
          return
        }
        const result = await attempt(() => applyToSimilarAction({ rowId: row.id }))
        if (result === null || !result.ok) {
          announce({ tone: "warning", lines: [couldNot("apply this ledger to the similar rows", result)] })
          return
        }
        announce({ tone: "success", lines: [`Set this ledger on ${result.data} row${result.data === 1 ? "" : "s"} that read the same.`] }, true)
        router.refresh()
      } finally {
        applyInFlight.current = false
      }
    })
  }

  if (row.status === "ERRORED") {
    return (
      <li className="surface rounded-2xl border border-negative/40 p-4 sm:p-5">
        <p className="figures text-sm text-fg-soft">Line {row.line}</p>
        <p role="alert" className="mt-1 flex items-start gap-2 font-medium text-negative">
          <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
          {row.errorReason ?? "This row could not be read."}
        </p>
        <p className="mt-2 text-sm text-fg-soft [overflow-wrap:anywhere]">{row.raw.join(" · ")}</p>
      </li>
    )
  }

  const ledgerName = (id: string | null) => (id ? (ledgers.find((l) => l.id === id)?.name ?? "An unknown ledger") : "No ledger chosen")

  if (row.status === "READY" || row.status === "SKIPPED") {
    return (
      <li className="surface rounded-2xl p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="figures text-sm text-fg-soft">Line {row.line}</span>
          <span className="rounded-full border border-line-strong px-2 py-0.5 text-[11px] font-medium text-fg-soft">{row.status === "READY" ? "Ready" : "Skipped"}</span>
          {row.occurredOn && <span className="figures text-sm text-fg-soft">{day(row.occurredOn)}</span>}
        </div>
        <p className="mt-1 font-medium [overflow-wrap:anywhere]">{row.description || "(no description)"}</p>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          {row.amountPaise && <Amount text={figure(row.amountPaise)} />}
          {row.direction && <DirectionChip direction={row.direction} />}
          {row.status === "READY" && <span className="text-sm text-fg-soft">→ {ledgerName(row.counterpartNodeId)}</span>}
        </div>
        <button type="button" aria-disabled={pending} onClick={doUndo} className={buttonClass({ variant: "secondary", size: "sm", className: "mt-3 aria-disabled:opacity-55" })}>
          Undo<span className="sr-only"> line {row.line}</span>
        </button>
      </li>
    )
  }

  // PENDING: the full decision card, possibly with a duplicate flag and/or a matched recurring occurrence on top of
  // the same counterpart select every plain row gets.
  return (
    <li className="surface rounded-2xl p-4 sm:p-5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="figures text-sm text-fg-soft">Line {row.line}</span>
        {row.occurredOn && <span className="figures text-sm text-fg-soft">{day(row.occurredOn)}</span>}
      </div>
      <p className="mt-1 font-medium [overflow-wrap:anywhere]">{row.description || "(no description)"}</p>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        {row.amountPaise && <Amount text={figure(row.amountPaise)} />}
        {row.direction && <DirectionChip direction={row.direction} />}
      </div>

      {row.duplicate && (
        <div role="group" aria-label="Possible duplicate" className="mt-3 rounded-xl border border-notice-fg/50 bg-notice-wash p-3">
          <p className="flex items-start gap-2 text-sm font-medium text-notice-fg">
            <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
            This looks like it repeats an existing transaction.
          </p>
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-fg-soft">Date</dt>
            <dd className="figures">{day(row.duplicate.occurredAt)}</dd>
            <dt className="text-fg-soft">Amount</dt>
            <dd>
              <Amount text={figure(row.duplicate.amountPaise)} />
            </dd>
            <dt className="text-fg-soft">Ledger</dt>
            <dd>{row.duplicate.otherLedgerName}</dd>
            {row.duplicate.note && (
              <>
                <dt className="text-fg-soft">Note</dt>
                <dd>{row.duplicate.note}</dd>
              </>
            )}
          </dl>
          <Link href={transactionsHref(row.duplicate)} className="mt-2 inline-block text-sm font-medium text-link underline underline-offset-4">
            See it in Transactions
          </Link>
        </div>
      )}

      {row.occurrence && (
        <div role="group" aria-label="Matches a recurring entry" className="mt-3 rounded-xl border border-line-strong bg-panel-raised p-3">
          <p className="text-sm">
            Matches the pending recurring entry <span className="font-medium">{row.occurrence.ruleName}</span>, due{" "}
            <span className="figures">{day(row.occurrence.dueOn)}</span>.
          </p>
          <button type="button" aria-disabled={pending} onClick={doLink} className={buttonClass({ size: "sm", className: "mt-2 aria-disabled:opacity-55" })}>
            Link to {row.occurrence.ruleName} due {day(row.occurrence.dueOn)}
            <span className="sr-only"> line {row.line}</span>
          </button>
        </div>
      )}

      <div className="mt-3">
        <label htmlFor={`ledger-${row.id}`} className="text-sm font-medium">
          Counterpart ledger
        </label>
        <select
          id={`ledger-${row.id}`}
          value={selected}
          aria-disabled={locked}
          onChange={(event) => {
            if (!locked) setSelected(event.target.value)
          }}
          className={`${inputClass} mt-1.5 max-w-sm aria-disabled:opacity-55`}
        >
          <option value="">Choose a ledger…</option>
          {legalLedgers.map((ledger) => (
            <option key={ledger.id} value={ledger.id}>
              {ledger.name}
              {ledger.id === suggestedId ? " — Suggested" : ""}
            </option>
          ))}
        </select>

        {canApplyToSimilar && (
          <div className="mt-2">
            <button type="button" aria-disabled={applying || locked} onClick={doApplyToSimilar} className={buttonClass({ variant: "ghost", size: "sm", className: "aria-disabled:opacity-55" })}>
              Use this ledger for every row that reads the same
            </button>
          </div>
        )}

        <div className="mt-3 flex flex-wrap gap-2">
          {row.duplicate ? (
            <>
              <button type="button" aria-disabled={pending} onClick={doImportAnyway} className={buttonClass({ size: "sm", className: "aria-disabled:opacity-55" })}>
                Import anyway<span className="sr-only"> line {row.line}</span>
              </button>
              <button type="button" aria-disabled={pending} onClick={doSkipAsDuplicate} className={buttonClass({ variant: "secondary", size: "sm", className: "aria-disabled:opacity-55" })}>
                Skip as duplicate<span className="sr-only"> line {row.line}</span>
              </button>
            </>
          ) : (
            <>
              <button type="button" aria-disabled={pending} onClick={doImport} className={buttonClass({ size: "sm", className: "aria-disabled:opacity-55" })}>
                Import<span className="sr-only"> line {row.line}</span>
              </button>
              <button type="button" aria-disabled={pending} onClick={doSkip} className={buttonClass({ variant: "secondary", size: "sm", className: "aria-disabled:opacity-55" })}>
                Skip<span className="sr-only"> line {row.line}</span>
              </button>
            </>
          )}
        </div>
      </div>
    </li>
  )
}
