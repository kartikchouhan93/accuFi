import type { LedgerNode } from "@prisma/client"
import type { CalendarDate } from "../domain/calendar-date"
import type { LedgerKind, SystemNodeRole } from "../domain/ledger-kind"
import type { NotValuedReason, PriceState } from "./investment-view"
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
  /** How an investment is valued (by quantity, as a lump, or by what was put in); null for every other kind. */
  valuationMode: LedgerNode["valuationMode"]
  /** What one unit of an investment is called ("gram"); null for every other kind. */
  unitLabel: string | null
}

export function toPickerNode(node: LedgerNode): PickerNode {
  return {
    id: node.id,
    name: node.name,
    kind: node.kind,
    archived: node.archivedAt !== null,
    systemRole: node.systemRole,
    valuationMode: node.valuationMode,
    unitLabel: node.unitLabel,
  }
}

/**
 * One row of the list. A split is one entry however many transactions it is, shown whole: `legs` is every live member
 * of the group, including any the filter alone would not have matched, so `total` is always the sum of the legs below it.
 */
export type ListEntry =
  | {
      kind: "single"
      transaction: TransactionView
      /** Set when the row is a sale (a break-even sale is one plain leg): it is deleted and entered again, never edited. */
      sale?: true
    }
  | {
      kind: "group"
      groupId: string
      /** Set when the group is a sale (a DISPOSAL): no leg of it is edited or taken out; it is deleted whole. */
      sale?: true
      /** The day of the leg that brought the group into the page. A split's legs share one day. */
      occurredAt: CalendarDate
      /** The one source of every leg, or null if edits have since given the legs different sources. */
      fromNodeId: string | null
      /** The sum of `legs`, in paise. */
      totalPaise: string
      /** Every leg is deleted: the split was deleted whole and is listed so it can be restored. */
      deleted: boolean
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
  /** "income" or "spending": every reportable node of that kind, resolved on the server. "" for no flow filter. */
  flow: string
  from: string
  to: string
  min: string
  max: string
  tag: string
  q: string
  /** "1" to list deleted transactions too (so one can be restored), "" otherwise. */
  deleted: string
}

export const FILTER_KEYS = ["node", "kind", "flow", "from", "to", "min", "max", "tag", "q", "deleted"] as const satisfies readonly (keyof FilterValues)[]

export interface TransactionScreen {
  /** Today in the user's own timezone: what a new entry is dated and what "current balance" means. */
  today: CalendarDate
  /** Every node, archived included: history still names them. The form's pickers narrow this themselves. */
  nodes: PickerNode[]
  /**
   * Paise text by node id, as of today: future-dated transactions are not in it (EC-10). An investment held by lots is at
   * its value today, as on the ledger, or "0" when it is not valued, and then `unvalued` says why (EC-23).
   */
  balances: Record<string, string>
  /** The investments that could not be valued, by node id, with why. */
  unvalued: Record<string, NotValuedReason>
  /** For each investment valued at a price: the price's day and whether it is stale (EC-24). */
  priced: Record<string, PriceState>
  filter: FilterValues
  /** Problems with the filter, by field. When there are any, `page` is empty rather than a list the filter did not make. */
  problems: Record<string, string[]>
  page: TransactionPage
  /**
   * Net paise into the filtered ledgers (from `node` and/or `flow`) from outside them, over live entries that match every
   * other filter; null when neither is set or the filter did not parse.
   */
  netTotal: { paise: string } | null
}
