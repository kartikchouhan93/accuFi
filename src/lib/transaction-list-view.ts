import type { LedgerNode } from "@prisma/client"
import type { CalendarDate } from "../domain/calendar-date"
import type { LedgerKind, SystemNodeRole } from "../domain/ledger-kind"
import type { TransactionView } from "./transaction-view"

// What the transaction screen is made of, in a shape that can cross to the browser: money as paise text, days as
// CalendarDate, never a bigint or a Date. Built on the server (src/server/services/transaction-list.ts); the types live
// here because the client components import them and may not import anything that reaches the database.

/** A node as a picker or a list row needs it: a name, a kind, and whether it may still be chosen for a new entry. */
export interface PickerNode {
  id: string
  name: string
  kind: LedgerKind
  archived: boolean
  /** Set for the application's own nodes (Opening Balance, Realised Gain and the like), null for the user's. */
  systemRole: SystemNodeRole | null
}

export function toPickerNode(node: LedgerNode): PickerNode {
  return { id: node.id, name: node.name, kind: node.kind, archived: node.archivedAt !== null, systemRole: node.systemRole }
}

/**
 * One row of the list. A split is one entry however many transactions it is, shown whole: `legs` is every live member
 * of the group, including any the filter alone would not have matched, so `total` is always the sum of the legs below it.
 */
export type ListEntry =
  | { kind: "single"; transaction: TransactionView }
  | {
      kind: "group"
      groupId: string
      /** The day of the leg that brought the group into the page. A split's legs share one day. */
      occurredAt: CalendarDate
      /** The one source of every leg, or null if edits have since given the legs different sources. */
      fromNodeId: string | null
      /** The sum of `legs`, in paise. */
      totalPaise: string
      legs: TransactionView[]
    }

export interface TransactionPage {
  entries: ListEntry[]
  /** Pass back to read the next page; null when this was the last. */
  nextCursor: string | null
}

/** The filters as the form shows them: the text typed, with the current month filled in when none was chosen. */
export interface FilterValues {
  node: string
  kind: string
  from: string
  to: string
  min: string
  max: string
  tag: string
  q: string
}

export const FILTER_KEYS = ["node", "kind", "from", "to", "min", "max", "tag", "q"] as const satisfies readonly (keyof FilterValues)[]

export interface TransactionScreen {
  /** Today in the user's own timezone: what a new entry is dated and what "current balance" means. */
  today: CalendarDate
  /** Every node, archived included: history still names them. The form's pickers narrow this themselves. */
  nodes: PickerNode[]
  /** Paise text by node id, as of today: future-dated transactions are not in it (EC-10). */
  balances: Record<string, string>
  filter: FilterValues
  /** Problems with the filter, by field. When there are any, `page` is empty rather than a list the filter did not make. */
  problems: Record<string, string[]>
  page: TransactionPage
}
