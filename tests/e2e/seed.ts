import { randomUUID } from "node:crypto"
import { calendarDate, todayIn } from "@/domain/calendar-date"
import { parseRupees } from "@/domain/money"
import { prisma } from "@/server/db"
import { createLedgerNode, type CreateNodeInput } from "@/server/services/node-service"
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
