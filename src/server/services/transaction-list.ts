import type { Transaction } from "@prisma/client"
import { fromDbDate, monthRange } from "@/domain/calendar-date"
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
import {
  DEFAULT_PAGE_SIZE,
  findGroupMembers,
  findTransactions,
  sumBalances,
  type TransactionFilter,
} from "@/server/repositories/transaction-repository"
import { findLotQuantities, findSaleTransactionIds } from "@/server/repositories/lot-repository"
import { buildNodeOverview } from "@/lib/node-overview"
import { todayFor } from "@/server/services/clock"
import { loadValuationStates } from "@/server/services/investment-service"
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
    includeDeleted: filter.deleted === true,
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
    deleted: legs.every((leg) => leg.deletedAt !== null),
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
 * A group shows once per page, at the position of its first leg, and its legs are every member of it in the same state
 * as that leg (live, or deleted when `filter.deleted` asked for deleted rows too): if the members cannot be read (they
 * were deleted a moment ago) the leg that matched is shown as an ordinary row.
 */
export async function loadTransactionPage(userId: string, filter: ListFilter, cursor?: string): Promise<TransactionPage> {
  const includeDeleted = filter.deleted === true
  const page = await findTransactions(userId, toRepositoryFilter(filter), cursor, DEFAULT_PAGE_SIZE)
  const members = await findGroupMembers(
    userId,
    page.items.flatMap((row) => (row.groupId === null ? [] : [row.groupId])),
    includeDeleted,
  )
  // A split is deleted and restored whole, so its legs normally all share one state. Keyed by state as well as group,
  // a row only ever brings in the legs in its own state: a live leg never shows a deleted one as part of the split.
  const legKey = (groupId: string, row: Transaction) => `${groupId}:${row.deletedAt === null ? "live" : "deleted"}`
  const legsOf = new Map<string, Transaction[]>()
  for (const member of members) {
    if (member.groupId === null) continue
    const key = legKey(member.groupId, member)
    legsOf.set(key, [...(legsOf.get(key) ?? []), member])
  }

  // What each purchase on the page bought, so the edit form opens on it. A split's legs never have a lot.
  const quantities = await findLotQuantities(userId, page.items.map((row) => row.id))
  // Which rows are legs of a sale, which the list offers no edit for (a sale is deleted and entered again).
  const sales = await findSaleTransactionIds(userId, [...page.items, ...members].map((row) => row.id))
  const saleFlag = (rows: readonly Transaction[]) => (rows.some((row) => sales.has(row.id)) ? { sale: true as const } : {})

  const entries: ListEntry[] = []
  const emitted = new Set<string>()
  for (const row of page.items) {
    const key = row.groupId === null ? null : legKey(row.groupId, row)
    const legs = key === null ? undefined : legsOf.get(key)
    if (key === null || row.groupId === null || legs === undefined || legs.length < 2) {
      entries.push({ kind: "single", transaction: toTransactionView(row, [], quantities.get(row.id) ?? null), ...saleFlag([row]) })
    } else if (!emitted.has(key)) {
      emitted.add(key)
      entries.push({ ...groupEntry(row, row.groupId, legs), ...saleFlag(legs) })
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
  const today = await todayFor(userId)
  const month = monthRange(Number(today.slice(0, 4)), Number(today.slice(5, 7)))
  const asked = "from" in query || "to" in query ? query : { ...query, from: month.start, to: month.end }

  const filter = Object.fromEntries(FILTER_KEYS.map((key) => [key, (asked[key] ?? "").trim()])) as unknown as FilterValues
  const parsed = transactionQuerySchema.safeParse(filter)
  const [nodes, balances, states, page] = await Promise.all([
    listAllNodes(userId),
    sumBalances(userId, today),
    loadValuationStates(userId, today),
    parsed.success ? loadTransactionPage(userId, parsed.data) : { entries: [], nextCursor: null },
  ])
  // The figures the ledger and the dashboard show, from the same calculation: an investment held by lots at its value
  // today, or not valued (EC-23), never at what it cost.
  const overview = buildNodeOverview(nodes, balances, states.valuations, { unvalued: states.unvalued, priced: states.priced })
  return {
    today,
    nodes: nodes.map(toPickerNode),
    balances: overview.balances,
    unvalued: overview.unvalued,
    priced: overview.priced,
    filter,
    problems: parsed.success ? {} : fieldErrorsOf(parsed.error),
    page,
  }
}
