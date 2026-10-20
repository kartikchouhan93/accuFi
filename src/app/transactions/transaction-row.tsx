"use client"

import { useId, useState, useTransition } from "react"
import { Amount } from "@/app/amount"
import { compareDates, type CalendarDate } from "@/domain/calendar-date"
import { formatPaiseText, type BalanceText } from "@/lib/node-money"
import type { ListEntry, PickerNode } from "@/lib/transaction-list-view"
import { describeTakeOut, formatDay } from "@/lib/transaction-text"
import type { TransactionView } from "@/lib/transaction-view"
import type { ActionResult } from "@/server/action-support"
import { removeTransactionAction, restoreTransactionAction, ungroupTransactionAction } from "./actions"
import type { Announce, TransactionNotice } from "./notice"
import { nodeLabel } from "./pickers"
import { describeTransactionFailure } from "./transaction-failure"

// One entry of the list. A transaction is a row that opens to its details and what can be done with it; a split is one
// row (its total, where it came from, what it went to) that opens to its legs. Every figure here comes from the server
// as paise text: a row's own amount, and a split's total, which the server summed over the legs it is showing.

const figure = (paise: string): BalanceText => ({ amount: formatPaiseText(paise), qualifier: null, tone: "neutral" })

const buttonClass = "rounded-sm border border-rule-strong px-3 py-1.5 text-sm font-medium hover:bg-paper disabled:opacity-60"

interface Context {
  nodes: ReadonlyMap<string, PickerNode>
  today: CalendarDate
  announce: Announce
  onEdit: (transaction: TransactionView) => void
}

const nameOf = (nodes: Context["nodes"], id: string) => nodes.get(id)?.name ?? "an unknown account"

const deletedRowClass = "bg-sheet/50 text-ink-soft"

function Tag({ children, title }: { children: React.ReactNode; title?: string }) {
  return (
    <span title={title} className="rounded-sm border border-rule-strong px-1.5 py-0.5 align-middle text-xs font-normal text-ink-soft">
      {children}
    </span>
  )
}

const restoredNotice = (restored: TransactionView): TransactionNotice => ({
  tone: restored.warnings.length > 0 ? "warning" : "success",
  lines: ["Restored.", ...restored.warnings.map((w) => w.message)],
})

/**
 * Restores what a delete removed, from the message that followed it. It never touches the row that was deleted (it is
 * gone from the screen by now). Once that message is dismissed the way back is "Show deleted" on the filters, where the
 * entry is listed with its own Restore.
 */
async function undoDelete(id: string, announce: Announce) {
  const result = await restoreTransactionAction({ id })
  if (!result.ok) {
    announce({ tone: "warning", lines: [`Could not restore it. ${describeTransactionFailure(result).message}`] })
    return
  }
  announce(restoredNotice(result.data))
}

export function EntryRow({ entry, context }: { entry: ListEntry; context: Context }) {
  return entry.kind === "single" ? (
    <SingleRow transaction={entry.transaction} context={context} />
  ) : (
    <GroupRow entry={entry} context={context} />
  )
}

function useRowActions() {
  const [pending, startTransition] = useTransition()
  const [problem, setProblem] = useState<string | null>(null)

  /** Run an action; a refusal is said on the row, a success is handed to `done`. */
  function run<T>(call: () => Promise<ActionResult<T>>, done: (data: T) => void) {
    setProblem(null)
    startTransition(async () => {
      const result = await call()
      if (!result.ok) {
        setProblem(describeTransactionFailure(result).message)
        return
      }
      done(result.data)
    })
  }

  return { pending, problem, run }
}

function Panel({ id, children, problem }: { id: string; children: React.ReactNode; problem: string | null }) {
  return (
    <div id={id} className="pb-4 text-sm">
      {children}
      {problem && (
        <p role="alert" className="mt-3 max-w-lg bg-red-wash px-3 py-2 font-medium text-red">
          {problem}
        </p>
      )}
    </div>
  )
}

function Heading({ title, amount, onToggle, open, panelId, children }: { title: React.ReactNode; amount: string; onToggle: () => void; open: boolean; panelId: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-controls={open ? panelId : undefined}
      onClick={onToggle}
      className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-baseline gap-x-3 py-3 text-left"
    >
      <span className="font-medium">{title}</span>
      <span className="leader" aria-hidden="true" />
      <Amount text={figure(amount)} />
      <span className="col-span-3 text-sm text-ink-soft">{children}</span>
    </button>
  )
}

function SingleRow({ transaction, context }: { transaction: TransactionView; context: Context }) {
  const { nodes, today, announce, onEdit } = context
  const panelId = useId()
  const [open, setOpen] = useState(false)
  const { pending, problem, run } = useRowActions()
  const from = nodes.get(transaction.fromNodeId)
  const to = nodes.get(transaction.toNodeId)
  const title = `${nameOf(nodes, transaction.fromNodeId)} → ${nameOf(nodes, transaction.toNodeId)}`
  const deleted = transaction.deleted
  // A deleted row counts toward nothing, so "not in your current balances" would be no news.
  const projected = !deleted && compareDates(transaction.occurredAt, today) > 0

  const restore = () =>
    run(
      () => restoreTransactionAction({ id: transaction.id }),
      (restored) => announce(restoredNotice(restored), true),
    )

  const remove = () =>
    run(
      () => removeTransactionAction({ id: transaction.id }),
      () =>
        announce(
          {
            tone: "success",
            lines: [`Deleted ${title}, ${formatPaiseText(transaction.amountPaise)}.`],
            undo: { label: "Undo", run: () => void undoDelete(transaction.id, announce) },
          },
          true,
        ),
    )

  return (
    <li className={deleted ? deletedRowClass : undefined}>
      <Heading
        title={
          <>
            <span className={deleted ? "line-through" : undefined}>{title}</span>
            {deleted && (
              <>
                {" "}
                <Tag>Deleted</Tag>
              </>
            )}
          </>
        }
        amount={transaction.amountPaise}
        open={open}
        panelId={panelId}
        onToggle={() => setOpen((current) => !current)}
      >
        <span className="figures">{formatDay(transaction.occurredAt)}</span>
        {projected && (
          <>
            {" "}
            <Tag title="Dated after today, so it is not in your current balances">Projected</Tag>
          </>
        )}
        {transaction.note && <span> · {transaction.note}</span>}
        {transaction.tags.length > 0 && <span> · {transaction.tags.map((tag) => `#${tag}`).join(" ")}</span>}
      </Heading>
      {open && (
        <Panel id={panelId} problem={problem}>
          <dl className="mb-3 grid max-w-md grid-cols-[auto_1fr] gap-x-6 gap-y-0.5">
            <dt className="text-ink-soft">From</dt>
            <dd>{from ? nodeLabel(from) : "an unknown account"}</dd>
            <dt className="text-ink-soft">To</dt>
            <dd>{to ? nodeLabel(to) : "an unknown account"}</dd>
            <dt className="text-ink-soft">Date</dt>
            <dd className="figures">{formatDay(transaction.occurredAt)}</dd>
            {transaction.note && (
              <>
                <dt className="text-ink-soft">Note</dt>
                <dd>{transaction.note}</dd>
              </>
            )}
            {transaction.tags.length > 0 && (
              <>
                <dt className="text-ink-soft">Tags</dt>
                <dd>{transaction.tags.join(", ")}</dd>
              </>
            )}
          </dl>
          {deleted ? (
            <div className="space-y-3">
              <p className="max-w-xl">Deleted: this is not in any balance. Restoring it puts it back, as it was.</p>
              <button type="button" className={buttonClass} disabled={pending} onClick={restore}>
                Restore
              </button>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              <button type="button" className={buttonClass} onClick={() => onEdit(transaction)}>
                Edit
              </button>
              <button type="button" className={`${buttonClass} text-red`} disabled={pending} onClick={remove}>
                Delete
              </button>
            </div>
          )}
        </Panel>
      )}
    </li>
  )
}

function GroupRow({ entry, context }: { entry: Extract<ListEntry, { kind: "group" }>; context: Context }) {
  const { nodes, today, announce, onEdit } = context
  const panelId = useId()
  const [open, setOpen] = useState(false)
  const { pending, problem, run } = useRowActions()
  const first = entry.legs[0]
  const source = entry.fromNodeId === null ? "several sources" : nameOf(nodes, entry.fromNodeId)
  const destinations = entry.legs.map((leg) => nameOf(nodes, leg.toNodeId)).join(", ")
  const deleted = entry.deleted
  const projected = !deleted && compareDates(entry.occurredAt, today) > 0
  const total = formatPaiseText(entry.totalPaise)

  // Any leg restores the whole split: the service brings back every deleted member of the group.
  const restoreAll = () =>
    run(
      () => restoreTransactionAction({ id: first.id }),
      (restored) => announce(restoredNotice(restored), true),
    )

  const removeAll = () =>
    run(
      // One click removes every leg: the service deletes the whole group whichever leg it is given.
      () => removeTransactionAction({ id: first.id }),
      () =>
        announce(
          {
            tone: "success",
            lines: [`Deleted the split of ${total} from ${source}: all ${entry.legs.length} legs.`],
            undo: { label: "Undo", run: () => void undoDelete(first.id, announce) },
          },
          true,
        ),
    )

  const takeOut = (leg: TransactionView) =>
    run(
      () => ungroupTransactionAction({ id: leg.id }),
      () =>
        announce({
          tone: "success",
          lines: [
            describeTakeOut(
              { name: nameOf(nodes, leg.toNodeId), amountPaise: leg.amountPaise },
              entry.legs.filter((other) => other.id !== leg.id).map((other) => ({ name: nameOf(nodes, other.toNodeId), amountPaise: other.amountPaise })),
            ),
          ],
        }),
    )

  return (
    <li className={deleted ? deletedRowClass : undefined}>
      <Heading
        title={
          <>
            <span className={deleted ? "line-through" : undefined}>Split from {source}</span> <Tag>Split</Tag>
            {deleted && (
              <>
                {" "}
                <Tag>Deleted</Tag>
              </>
            )}
          </>
        }
        amount={entry.totalPaise}
        open={open}
        panelId={panelId}
        onToggle={() => setOpen((current) => !current)}
      >
        <span className="figures">{formatDay(entry.occurredAt)}</span>
        {projected && (
          <>
            {" "}
            <Tag title="Dated after today, so it is not in your current balances">Projected</Tag>
          </>
        )}
        <span>
          {" "}
          · {entry.legs.length} legs: {destinations}
        </span>
        {first.note && <span> · {first.note}</span>}
        {first.tags.length > 0 && <span> · {first.tags.map((tag) => `#${tag}`).join(" ")}</span>}
      </Heading>
      {open && (
        <Panel id={panelId} problem={problem}>
          <ul aria-label="Legs" className="mb-3 max-w-xl divide-y divide-rule border-y border-rule">
            {entry.legs.map((leg) => (
              <li key={leg.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2">
                <span className="font-medium">→ {nameOf(nodes, leg.toNodeId)}</span>
                <span className="leader" aria-hidden="true" />
                <Amount text={figure(leg.amountPaise)} />
                {!deleted && (
                  <>
                    <button
                      type="button"
                      className="text-sm font-medium text-pen underline underline-offset-4"
                      aria-label={`Edit the ${nameOf(nodes, leg.toNodeId)} leg`}
                      onClick={() => onEdit(leg)}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className="text-sm font-medium text-pen underline underline-offset-4 disabled:opacity-60"
                      disabled={pending}
                      aria-label={`Take ${nameOf(nodes, leg.toNodeId)} out of the split`}
                      onClick={() => takeOut(leg)}
                    >
                      Take out of split
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
          {deleted ? (
            <div className="space-y-3">
              <p className="max-w-xl">Deleted: none of these legs is in any balance. Restoring brings back every leg, as it was.</p>
              <button type="button" className={buttonClass} disabled={pending} onClick={restoreAll}>
                Restore split
              </button>
            </div>
          ) : (
            <>
              <p className="mb-3 max-w-xl text-ink-soft">
                Edit changes one leg and leaves the split as it is. Taking a leg out keeps the money where it went and makes it an
                ordinary transaction
                {entry.legs.length === 2 ? "; with only two legs, that dissolves the split and both become ordinary transactions" : ""}.
                Deleting removes every leg.
              </p>
              <button type="button" className={`${buttonClass} text-red`} disabled={pending} onClick={removeAll}>
                Delete split
              </button>
            </>
          )}
        </Panel>
      )}
    </li>
  )
}
