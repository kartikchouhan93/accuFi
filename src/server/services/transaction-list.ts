import type { Transaction } from "@prisma/client"
import { fromDbDate, monthRange, todayIn } from "@/domain/calendar-date"
import { fieldErrorsOf } from "@/lib/field-errors"
import { serialisePaise } from "@/lib/serialise"
import { transactionQuerySchema } from "@/lib/schemas/transaction"
import {
  FILTER_KEYS,
  toPickerNode,
  type FilterValues,
  type ListEntry,
  type TransactionPage,
  type TransactionScreen,
} from "@/lib/transaction-list-view"
import { toTransactionView } from "@/lib/transaction-view"
import { NotFoundError } from "@/server/repositories/errors"
import {
  DEFAULT_PAGE_SIZE,
  findGroupMembers,
  findTransactions,
  sumBalances,
  type TransactionFilter,
} from "@/server/repositories/transaction-repository"
import { findUserTimezone } from "@/server/repositories/user-repository"
import { listAllNodes } from "@/server/services/node-service"
import type { z } from "zod"

// What the transaction screen reads. Everything it returns can cross to the browser: money is paise text and days are
// CalendarDate (src/lib/transaction-list-view.ts).

/** The filters after parsing: typed values, any of them absent. */
export type ListFilter = z.output<typeof transactionQuerySchema>

function toRepositoryFilter(filter: ListFilter): TransactionFilter {
  return {
    ...(filter.node !== undefined && { nodeIds: [filter.node] }),
    ...(filter.kind !== undefined && { kinds: [filter.kind] }),
    from: filter.from,
    to: filter.to,
    minAmount: filter.min,
    maxAmount: filter.max,
    tags: filter.tag,
    search: filter.q,
  }
}

function groupEntry(anchor: Transaction, groupId: string, legs: Transaction[]): ListEntry {
  const sources = new Set(legs.map((leg) => leg.fromNodeId))
  return {
    kind: "group",
    groupId,
    occurredAt: fromDbDate(anchor.occurredAt),
    fromNodeId: sources.size === 1 ? anchor.fromNodeId : null,
    totalPaise: serialisePaise(legs.reduce((sum, leg) => sum + leg.amountPaise, 0n)),
    legs: legs.map((leg) => toTransactionView(leg)),
  }
}

/**
 * One page of the list, newest first, as entries: a transaction that is in no group is one entry, and a split is one
 * entry carrying all of its legs. The page is cut by keyset (`cursor`, never an offset) on the transactions, so a
 * split can straddle the cut: the legs on this side bring the whole group in (`findGroupMembers`, whatever the filter),
 * and the legs on the other side bring it in again on the next page. The server keeps no memory of what it has sent, so
 * a caller that appends pages must drop an entry whose `groupId` it already holds (the list component does).
 *
 * A group shows once per page, at the position of its first leg, and its legs are every live member of it: if the
 * members cannot be read (they were deleted a moment ago) the leg that matched is shown as an ordinary row.
 */
export async function loadTransactionPage(userId: string, filter: ListFilter, cursor?: string): Promise<TransactionPage> {
  const page = await findTransactions(userId, toRepositoryFilter(filter), cursor, DEFAULT_PAGE_SIZE)
  const members = await findGroupMembers(
    userId,
    page.items.flatMap((row) => (row.groupId === null ? [] : [row.groupId])),
  )
  const legsOf = new Map<string, Transaction[]>()
  for (const member of members) {
    if (member.groupId !== null) legsOf.set(member.groupId, [...(legsOf.get(member.groupId) ?? []), member])
  }

  const entries: ListEntry[] = []
  const emitted = new Set<string>()
  for (const row of page.items) {
    const legs = row.groupId === null ? undefined : legsOf.get(row.groupId)
    if (row.groupId === null || legs === undefined || legs.length < 2) {
      entries.push({ kind: "single", transaction: toTransactionView(row) })
    } else if (!emitted.has(row.groupId)) {
      emitted.add(row.groupId)
      entries.push(groupEntry(row, row.groupId, legs))
    }
  }
  return { entries, nextCursor: page.nextCursor }
}

/**
 * Everything the screen shows at once. `query` is the page's URL parameters. With no date in them the list is the
 * current month (the user's own, by their timezone); a date field that is present but blank means no bound on that
 * side, which is how a user asks for every month. A filter that does not parse leaves the list empty with the reasons
 * in `problems`.
 */
export async function loadTransactionScreen(userId: string, query: Record<string, string | undefined>): Promise<TransactionScreen> {
  const timezone = await findUserTimezone(userId)
  if (timezone === null) throw new NotFoundError("user")
  const today = todayIn(timezone)
  const month = monthRange(Number(today.slice(0, 4)), Number(today.slice(5, 7)))
  const asked = "from" in query || "to" in query ? query : { ...query, from: month.start, to: month.end }

  const filter = Object.fromEntries(FILTER_KEYS.map((key) => [key, (asked[key] ?? "").trim()])) as unknown as FilterValues
  const parsed = transactionQuerySchema.safeParse(filter)
  const [nodes, balances, page] = await Promise.all([
    listAllNodes(userId),
    sumBalances(userId, today),
    parsed.success ? loadTransactionPage(userId, parsed.data) : { entries: [], nextCursor: null },
  ])
  return {
    today,
    nodes: nodes.map(toPickerNode),
    balances: Object.fromEntries(balances.map((row) => [row.nodeId, serialisePaise(row.balance)])),
    filter,
    problems: parsed.success ? {} : fieldErrorsOf(parsed.error),
    page,
  }
}
