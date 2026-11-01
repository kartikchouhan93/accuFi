import { randomUUID } from "node:crypto"
import { addDays, calendarDate, todayIn } from "@/domain/calendar-date"
import type { ImportMapping } from "@/domain/import-map"
import type { RecurrenceFrequency } from "@/domain/recurrence"
import { parseRupees } from "@/domain/money"
import { parseQuantity } from "@/domain/quantity"
import { prisma } from "@/server/db"
import { createLedgerNode, type CreateNodeInput } from "@/server/services/node-service"
import { createBudget } from "@/server/services/budget-service"
import { commitBatch, createBatch, loadReview, stageBatch, updateRow } from "@/server/services/import-service"
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

/**
 * Create a budget on an expense ledger named as it is on screen, through the service (so the same checks apply as for the
 * form). `startMonth` and `endMonth` are "YYYY-MM-DD" days in the month, normalised to the first by the service; the amount is
 * rupee text. Derive the months from `today(userId)`: a budget's months are never literals, so the test passes in any month.
 */
export async function budget(
  userId: string,
  opts: { ledger: string; rupees: string; startMonth: string; endMonth?: string; rollover?: boolean },
) {
  return createBudget(userId, {
    nodeId: await nodeId(userId, opts.ledger),
    amount: parseRupees(opts.rupees),
    startMonth: calendarDate(opts.startMonth),
    endMonth: opts.endMonth === undefined ? undefined : calendarDate(opts.endMonth),
    rollover: opts.rollover ?? false,
  })
}

export interface ImportSeedRow {
  description: string
  rupees: string
  direction: "OUT" | "IN"
  /** Days from `today`; defaults to 0. */
  dayOffset?: number
}

/**
 * An import batch straight through the services, with no browser and no real file format choices: the only e2e specs
 * that use this (isolation, and the recurring-link setup) need a batch and its rows to exist in a given state with
 * real ids to act on, not a proof that the upload form or the mapping screen work (import.spec.ts's own exit-criterion
 * scenario drives those for real). The file itself is a plain single-signed-amount CSV in YYYY-MM-DD, `rows` negative
 * for OUT and positive for IN, so the mapping needed to read it back is always the same regardless of account kind.
 * Staged by default; every row gets `counterpart` and is readied (`decision: "IMPORT"`) unless `decide` is false, and
 * the batch is committed if `commit` is true (which implies staging and deciding). Pass `stage: false` for a batch left
 * at UPLOADED, with no rows yet.
 */
export async function importBatch(
  userId: string,
  opts: {
    account: string
    counterpart: string
    rows: ImportSeedRow[]
    fileName?: string
    stage?: boolean
    decide?: boolean
    commit?: boolean
  },
) {
  const accountId = await nodeId(userId, opts.account)
  const day = await today(userId)
  const lines = opts.rows.map((r) => {
    const date = addDays(calendarDate(day), r.dayOffset ?? 0)
    const signed = r.direction === "OUT" ? `-${r.rupees}` : r.rupees
    return `${date},${r.description},${signed}`
  })
  const text = ["date,description,amount", ...lines].join("\n")
  const batch = await createBatch(userId, { nodeId: accountId, fileName: opts.fileName ?? "statement.csv", bytes: new TextEncoder().encode(text) })

  const shouldStage = (opts.stage ?? true) || opts.commit
  if (!shouldStage) return { batchId: batch.id, rowIds: [] as string[] }

  const mapping: ImportMapping = {
    delimiter: ",",
    encoding: "utf-8",
    skipRows: 1,
    dateFormat: "YYYY-MM-DD",
    decimalSeparator: ".",
    signConvention: "POSITIVE_IN",
    columns: { date: 0, description: 1, amount: 2 },
  }
  await stageBatch(userId, batch.id, mapping, { confirmedRepeat: false })
  const review = await loadReview(userId, batch.id, { filter: "all", page: 1 })
  const rowIds = review.rows.map((r) => r.id)

  const shouldDecide = (opts.decide ?? true) || opts.commit
  if (shouldDecide) {
    const counterpartId = await nodeId(userId, opts.counterpart)
    for (const rowId of rowIds) await updateRow(userId, rowId, { counterpartNodeId: counterpartId, decision: "IMPORT" })
  }

  if (opts.commit) await commitBatch(userId, batch.id)

  return { batchId: batch.id, rowIds }
}
