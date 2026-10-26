import type { Transaction } from "@prisma/client"
import { fromDbDate, type CalendarDate } from "../domain/calendar-date"
import { formatQuantity, type Quantity } from "../domain/quantity"
import { serialisePaise } from "./serialise"

// A transaction as it crosses to the browser: into a Server Action's result, a Server Component's props, a client
// component. Not the Prisma row, whose `amountPaise` is a bigint (JSON.stringify throws on it, and the failure surfaces
// at runtime in the response) and whose `occurredAt` is a Date. Here every amount is a decimal string of paise and the
// day is a CalendarDate, so the type holds no bigint and no Date and survives JSON.stringify unchanged.
// `userId` is left off (the client has no use for it) and so are the audit timestamps (nothing displays them yet).

export interface Warning {
  code: "OVERDRAWN" | "OVER_CREDIT_LIMIT" | "FUTURE_DATED"
  message: string
}

export interface TransactionView {
  id: string
  fromNodeId: string
  toNodeId: string
  /** Paise, as a decimal string. Always positive: direction carries the sign. */
  amountPaise: string
  occurredAt: CalendarDate
  note: string | null
  tags: string[]
  groupId: string | null
  /** Soft-deleted: it counts toward no balance. Only a listing that asked for deleted rows ever contains one. */
  deleted: boolean
  /** The optimistic-locking token: pass it back as `expectedVersion` when editing. */
  version: number
  /**
   * What the user should know about the state this write left behind. Returned with a successful result, never thrown:
   * the transaction is recorded either way. Empty for a row that was merely read.
   */
  warnings: Warning[]
  /**
   * What the purchase's lot holds, as decimal text ("10.5"), or null when it has no lot (any row that is not a purchase
   * into an investment valued by quantity or as a lump, and a purchase from before lots existed). Present only where the
   * lot was read: the list the edit form opens from, and a version conflict. Left out everywhere else.
   */
  quantity?: string | null
}

/** `quantity` is the row's lot's (null for none); leave it out where the lot was not read. */
export function toTransactionView(row: Transaction, warnings: Warning[] = [], quantity?: Quantity | null): TransactionView {
  return {
    id: row.id,
    fromNodeId: row.fromNodeId,
    toNodeId: row.toNodeId,
    amountPaise: serialisePaise(row.amountPaise),
    occurredAt: fromDbDate(row.occurredAt),
    note: row.note,
    tags: [...row.tags],
    groupId: row.groupId,
    deleted: row.deletedAt !== null,
    version: row.version,
    warnings,
    ...(quantity === undefined ? {} : { quantity: quantity === null ? null : formatQuantity(quantity) }),
  }
}
