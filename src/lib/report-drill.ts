import type { CalendarDate } from "../domain/calendar-date"
import type { LedgerKind } from "../domain/ledger-kind"

// Where a figure on a report leads: the Transactions screen filtered to exactly the entries the figure is made of, so a
// number on a report can always be traced to its entries. A drill is data, not a string, so a test can say what a
// figure drills into; `transactionsHref` is the one place it becomes a URL.

export interface Drill {
  /** Specific ledgers: a row's own id followed by its children's. */
  node?: readonly string[]
  /** Every reportable income source, or every reportable expense. */
  flow?: "income" | "spending"
  kind?: LedgerKind
  from: CalendarDate
  to: CalendarDate
}

/** `/transactions?` with node, flow, kind, from and to in that order, leaving out the ones not set. */
export function transactionsHref(drill: Drill): string {
  const params = new URLSearchParams()
  if (drill.node !== undefined && drill.node.length > 0) params.set("node", drill.node.join(","))
  if (drill.flow !== undefined) params.set("flow", drill.flow)
  if (drill.kind !== undefined) params.set("kind", drill.kind)
  params.set("from", drill.from)
  params.set("to", drill.to)
  return `/transactions?${params.toString()}`
}
