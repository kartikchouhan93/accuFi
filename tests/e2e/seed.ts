import { randomUUID } from "node:crypto"
import { calendarDate, todayIn } from "@/domain/calendar-date"
import type { RecurrenceFrequency } from "@/domain/recurrence"
import { parseRupees } from "@/domain/money"
import { parseQuantity } from "@/domain/quantity"
import { prisma } from "@/server/db"
import { createLedgerNode, type CreateNodeInput } from "@/server/services/node-service"
import { recordPrice } from "@/server/services/price-service"
import { createRule } from "@/server/services/recurring-service"
import { recordTransaction } from "@/server/services/transaction-service"

// Puts a user's ledger into a known state through the same services the application uses, so a test can start from
// "an account holding ₹1,000" without driving the forms that Task 10 already tests. Amounts are rupee text, as typed.

export const addNode = (userId: string, input: CreateNodeInput) => createLedgerNode(userId, input)

export const account = (userId: string, name: string, openingRupees?: string) =>
  addNode(userId, {
    kind: "ASSET",
    name,
    assetSubtype: "SAVINGS",
    ...(openingRupees === undefined ? {} : { openingBalance: parseRupees(openingRupees) }),
  })

export const addExpense = (userId: string, name: string) => addNode(userId, { kind: "EXPENSE", name })
export const incomeSource = (userId: string, name: string) => addNode(userId, { kind: "INCOME_SOURCE", name })
/** A credit card, optionally with a limit and an amount already owed on it (opening balance, entered as a positive rupee amount owed). */
export const card = (userId: string, name: string, over: { limit?: string; owed?: string } = {}) =>
  addNode(userId, {
    kind: "LIABILITY",
    name,
    liabilitySubtype: "CREDIT_CARD",
    ...(over.limit === undefined ? {} : { creditLimitPaise: parseRupees(over.limit) }),
    ...(over.owed === undefined ? {} : { openingBalance: -parseRupees(over.owed) }),
  })

/** A loan, optionally with an amount already owed on it (opening balance, entered as a positive rupee amount owed). */
export const loan = (userId: string, name: string, owed?: string) =>
  addNode(userId, {
    kind: "LIABILITY",
    name,
    liabilitySubtype: "LOAN",
    ...(owed === undefined ? {} : { openingBalance: -parseRupees(owed) }),
  })

/** An investment: by default one valued by quantity, in grams, sold first in first out. */
export const investment = (
  userId: string,
  name: string,
  over: { valuation?: "QUANTITY" | "LUMP" | "CONTRIBUTION_ONLY"; unit?: string } = {},
) => addNode(userId, { kind: "INVESTMENT", name, valuationMode: over.valuation ?? "QUANTITY", unitLabel: over.unit ?? "gram", lotMethod: "FIFO" })

/** Buy `quantity` (unit text, as typed) of an investment valued by quantity for `rupees` from an account, named as on screen. */
export async function buy(userId: string, from: string, to: string, rupees: string, quantity: string, date: string) {
  return recordTransaction(userId, {
    fromNodeId: await nodeId(userId, from),
    toNodeId: await nodeId(userId, to),
    amount: parseRupees(rupees),
    quantity: parseQuantity(quantity),
    occurredAt: calendarDate(date),
    idempotencyKey: randomUUID(),
  })
}

/** Record the price of one unit of an investment, named as on screen, on a day. */
export async function price(userId: string, name: string, rupees: string, date: string) {
  await recordPrice(userId, { nodeId: await nodeId(userId, name), asOf: calendarDate(date), pricePerUnit: parseRupees(rupees) })
}

/** The id of a node of this user by name (the starter expense ledgers included). */
export async function nodeId(userId: string, name: string): Promise<string> {
  const node = await prisma.ledgerNode.findFirstOrThrow({ where: { userId, name } })
  return node.id
}

/** Record one transaction between two nodes named as they are on screen. `date` defaults to today in the user's zone. */
export async function post(
  userId: string,
  from: string,
  to: string,
  rupees: string,
  over: { date?: string; note?: string; tags?: string[] } = {},
) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } })
  return recordTransaction(userId, {
    fromNodeId: await nodeId(userId, from),
    toNodeId: await nodeId(userId, to),
    amount: parseRupees(rupees),
    occurredAt: over.date === undefined ? todayIn(user.timezone) : calendarDate(over.date),
    note: over.note,
    tags: over.tags,
    idempotencyKey: randomUUID(),
  })
}

/** Today, in the zone the application will use for this user. */
export async function today(userId: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } })
  return todayIn(user.timezone)
}

/**
 * Create a recurring rule between two nodes named as they are on screen. Through `createRule`, which also generates what is
 * already due: a start date in the past therefore leaves entries in the inbox straight away. `startDate` and `endDate` are
 * "YYYY-MM-DD" days; the rest defaults to a monthly rule that waits for confirmation.
 */
export async function recurringRule(
  userId: string,
  opts: {
    name: string
    from: string
    to: string
    rupees: string
    startDate: string
    frequency?: RecurrenceFrequency
    interval?: number
    dayOfMonth?: number
    dayOfWeek?: number
    endDate?: string
    occurrenceLimit?: number
    autoPost?: boolean
    note?: string
    tags?: string[]
  },
) {
  return createRule(userId, {
    name: opts.name,
    fromNodeId: await nodeId(userId, opts.from),
    toNodeId: await nodeId(userId, opts.to),
    amount: parseRupees(opts.rupees),
    note: opts.note,
    tags: opts.tags,
    frequency: opts.frequency ?? "MONTHLY",
    interval: opts.interval ?? 1,
    dayOfMonth: opts.dayOfMonth,
    dayOfWeek: opts.dayOfWeek,
    startDate: calendarDate(opts.startDate),
    endDate: opts.endDate === undefined ? undefined : calendarDate(opts.endDate),
    occurrenceLimit: opts.occurrenceLimit,
    autoPost: opts.autoPost ?? false,
    idempotencyKey: randomUUID(),
  })
}
