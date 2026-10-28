import { afterAll, afterEach, describe, expect, it, vi } from "vitest"
import { calendarDate } from "@/domain/calendar-date"
import { prisma } from "@/server/db"
import { NotFoundError } from "@/server/repositories/errors"
import { softDeleteRule } from "@/server/repositories/recurring-repository"
import { sumBalances } from "@/server/repositories/transaction-repository"
import { inTransaction } from "@/server/repositories/unit-of-work"
import { findLiveLots } from "@/server/repositories/lot-repository"
import { getDashboard } from "@/server/services/balance-service"
import { archiveLedgerNode } from "@/server/services/node-service"
import {
  dismissOccurrence,
  OccurrenceStateError,
  postOccurrence,
  restoreOccurrence,
} from "@/server/services/occurrence-service"
import * as transactionService from "@/server/services/transaction-service"
import { InvalidTransactionError, OverdraftBlockedError } from "@/server/services/transaction-service"
import { createRegistry } from "../repositories/fixtures"

// Posting, skipping and putting back an occurrence, against the real database. Rows are made through the fixtures, not
// through generation, so each test starts from exactly the state it names.

const registry = createRegistry()
afterAll(registry.cleanup)
afterEach(() => vi.restoreAllMocks())

const UNIT = 1_000_000n

/** A user with Rs 1,000.00 in a bank, an expense node, an income source, and a gold investment valued by quantity. */
async function setup() {
  const user = await registry.makeUser()
  const income = await registry.makeNode(user.id, "INCOME_SOURCE", "Salary")
  const bank = await registry.makeNode(user.id, "ASSET", "Bank")
  const food = await registry.makeNode(user.id, "EXPENSE", "Food")
  const gold = await registry.makeNode(user.id, "INVESTMENT", "Gold", { valuationMode: "QUANTITY", unitLabel: "g" })
  await registry.makeTransaction(user.id, income.id, bank.id, { amountPaise: 1_000_00n, occurredAt: "2026-01-01" })
  return { user, income, bank, food, gold }
}

type World = Awaited<ReturnType<typeof setup>>

/** A rule bank -> food of Rs 100.00 with one PENDING occurrence due in the past; `over` sets other rule columns. */
async function pendingOccurrence(w: World, over: Parameters<typeof registry.makeRule>[3] = {}, dueOn = "2026-03-05") {
  const rule = await registry.makeRule(w.user.id, w.bank.id, w.food.id, {
    amountPaise: 100_00n,
    note: "monthly",
    tags: ["home", "fixed"],
    ...over,
  })
  const occurrence = await registry.makeOccurrence(w.user.id, rule.id, dueOn)
  return { rule, occurrence }
}

async function balanceOf(userId: string, nodeId: string): Promise<bigint> {
  const row = (await sumBalances(userId)).find((b) => b.nodeId === nodeId)
  if (!row) throw new Error("no such node")
  return row.balance
}

const stored = (id: string) => prisma.recurringOccurrence.findUniqueOrThrow({ where: { id } })
const transactionsFor = (id: string) => prisma.transaction.findMany({ where: { idempotencyKey: `recurring:${id}` } })

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected the call to reject")
    },
    (error: unknown) => error,
  )
}

async function expectNotFound(promise: Promise<unknown>) {
  const error = await rejection(promise)
  expect(error).toBeInstanceOf(NotFoundError)
  expect((error as NotFoundError).entity).toBe("occurrence")
}

describe("posting as proposed", () => {
  it("records the rule's template on the due day and marks the occurrence posted with its transaction", async () => {
    const w = await setup()
    const { rule, occurrence } = await pendingOccurrence(w)
    const bankBefore = await balanceOf(w.user.id, w.bank.id)
    const foodBefore = await balanceOf(w.user.id, w.food.id)

    const view = await postOccurrence(w.user.id, occurrence.id)

    const [tx] = await transactionsFor(occurrence.id)
    expect(tx).toMatchObject({ fromNodeId: w.bank.id, toNodeId: w.food.id, amountPaise: 100_00n, note: "monthly", tags: ["home", "fixed"] })
    expect(tx.occurredAt.toISOString().slice(0, 10)).toBe("2026-03-05")
    expect(view).toMatchObject({
      id: occurrence.id,
      ruleId: rule.id,
      ruleName: "Rent",
      dueOn: "2026-03-05",
      status: "POSTED",
      fromName: "Bank",
      toName: "Food",
      amountPaise: "10000",
      transactionId: tx.id,
      needsQuantity: false,
      nodeArchived: false,
    })
    const row = await stored(occurrence.id)
    expect(row).toMatchObject({ status: "POSTED", transactionId: tx.id, postFailure: null })
    expect(row.resolvedAt).not.toBeNull()
    expect(await balanceOf(w.user.id, w.bank.id)).toBe(bankBefore - 100_00n)
    expect(await balanceOf(w.user.id, w.food.id)).toBe(foodBefore + 100_00n)
  })

  it("records what the user typed when there are overrides", async () => {
    const w = await setup()
    const { occurrence } = await pendingOccurrence(w)

    await postOccurrence(w.user.id, occurrence.id, { amount: 123_45n, occurredAt: calendarDate("2026-03-07"), note: "paid late" })

    const [tx] = await transactionsFor(occurrence.id)
    expect(tx).toMatchObject({ amountPaise: 123_45n, note: "paid late", tags: ["home", "fixed"] })
    expect(tx.occurredAt.toISOString().slice(0, 10)).toBe("2026-03-07")
  })

  it("clears the note when the override is null", async () => {
    const w = await setup()
    const { occurrence } = await pendingOccurrence(w)
    await postOccurrence(w.user.id, occurrence.id, { note: null })
    const [tx] = await transactionsFor(occurrence.id)
    expect(tx.note).toBeNull()
  })
})

describe("a posted view shows what was posted, not the rule as it is now", () => {
  it("shows the typed amount, note and day of a post with overrides, against the stored transaction", async () => {
    const w = await setup()
    const { occurrence } = await pendingOccurrence(w)

    const view = await postOccurrence(w.user.id, occurrence.id, {
      amount: 123_45n,
      occurredAt: calendarDate("2026-03-07"),
      note: "paid late",
    })

    const [tx] = await transactionsFor(occurrence.id)
    expect(view.transactionId).toBe(tx.id)
    expect(view.amountPaise).toBe(tx.amountPaise.toString())
    expect(view.amountPaise).toBe("12345")
    expect(view.note).toBe(tx.note)
    expect(view.note).toBe("paid late")
    expect(view.tags).toEqual(tx.tags)
    expect(view.fromNodeId).toBe(tx.fromNodeId)
    expect(view.toNodeId).toBe(tx.toNodeId)
  })

  it("keeps showing the posted amount and note after the rule is edited, on a replay", async () => {
    const w = await setup()
    const { rule, occurrence } = await pendingOccurrence(w)
    await postOccurrence(w.user.id, occurrence.id)
    await prisma.recurringRule.update({ where: { id: rule.id }, data: { amountPaise: 150_00n, note: "raised", tags: ["new"] } })

    const view = await postOccurrence(w.user.id, occurrence.id)

    const [tx] = await transactionsFor(occurrence.id)
    expect(view.status).toBe("POSTED")
    expect(view.amountPaise).toBe(tx.amountPaise.toString())
    expect(view.amountPaise).toBe("10000")
    expect(view.note).toBe("monthly")
    expect(view.tags).toEqual(["home", "fixed"])
  })

  it("keeps naming the accounts it was posted to after the rule is pointed elsewhere", async () => {
    const w = await setup()
    const other = await registry.makeNode(w.user.id, "EXPENSE", "Travel")
    const { rule, occurrence } = await pendingOccurrence(w)
    await postOccurrence(w.user.id, occurrence.id)
    await prisma.recurringRule.update({ where: { id: rule.id }, data: { toNodeId: other.id } })

    const view = await postOccurrence(w.user.id, occurrence.id)

    expect(view).toMatchObject({ toNodeId: w.food.id, toName: "Food", fromNodeId: w.bank.id, fromName: "Bank" })
    expect(view.toNodeId).not.toBe(other.id)
  })

  it("still shows the rule's current template while pending or skipped", async () => {
    const w = await setup()
    const { rule, occurrence } = await pendingOccurrence(w)
    await prisma.recurringRule.update({ where: { id: rule.id }, data: { amountPaise: 150_00n } })
    expect((await dismissOccurrence(w.user.id, occurrence.id)).amountPaise).toBe("15000")
  })
})

describe("what is pending is not money (EC-47)", () => {
  it("leaves the balances and net worth alone until one is posted, then moves them by exactly that amount", async () => {
    const w = await setup()
    const balancesBefore = await sumBalances(w.user.id)
    const netWorthBefore = (await getDashboard(w.user.id)).netWorth.total

    const rule = await registry.makeRule(w.user.id, w.bank.id, w.food.id, { amountPaise: 100_00n })
    const [first] = await Promise.all(
      ["2026-03-05", "2026-04-05", "2026-05-05"].map((day) => registry.makeOccurrence(w.user.id, rule.id, day)),
    )

    expect(await sumBalances(w.user.id)).toEqual(balancesBefore)
    expect((await getDashboard(w.user.id)).netWorth.total).toBe(netWorthBefore)

    await postOccurrence(w.user.id, first.id)

    expect(await balanceOf(w.user.id, w.bank.id)).toBe(1_000_00n - 100_00n)
    expect(BigInt((await getDashboard(w.user.id)).netWorth.total)).toBe(BigInt(netWorthBefore) - 100_00n)
  })
})

describe("posting exactly once", () => {
  it("creates one transaction however many times it is posted, in sequence or at once", async () => {
    const w = await setup()
    const { occurrence } = await pendingOccurrence(w)

    const first = await postOccurrence(w.user.id, occurrence.id)
    const second = await postOccurrence(w.user.id, occurrence.id)
    expect(second.transactionId).toBe(first.transactionId)
    expect(second.status).toBe("POSTED")
    expect(await transactionsFor(occurrence.id)).toHaveLength(1)

    const racing = await pendingOccurrence(w, {}, "2026-04-05")
    const [a, b] = await Promise.all([postOccurrence(w.user.id, racing.occurrence.id), postOccurrence(w.user.id, racing.occurrence.id)])
    expect(a.transactionId).not.toBeNull()
    expect(a.transactionId).toBe(b.transactionId)
    expect(await transactionsFor(racing.occurrence.id)).toHaveLength(1)
    expect(await balanceOf(w.user.id, w.food.id)).toBe(200_00n)
  })
})

describe("skipping and putting back", () => {
  it("refuses to post a skipped occurrence until it is put back", async () => {
    const w = await setup()
    const { occurrence } = await pendingOccurrence(w)

    const skipped = await dismissOccurrence(w.user.id, occurrence.id)
    expect(skipped.status).toBe("DISMISSED")
    expect((await stored(occurrence.id)).resolvedAt).not.toBeNull()
    expect((await dismissOccurrence(w.user.id, occurrence.id)).status).toBe("DISMISSED")

    const error = await rejection(postOccurrence(w.user.id, occurrence.id))
    expect(error).toBeInstanceOf(OccurrenceStateError)
    expect((error as Error).message).toBe("Put it back before posting it.")
    expect(await transactionsFor(occurrence.id)).toHaveLength(0)

    const back = await restoreOccurrence(w.user.id, occurrence.id)
    expect(back.status).toBe("PENDING")
    expect((await stored(occurrence.id)).resolvedAt).toBeNull()
    expect((await restoreOccurrence(w.user.id, occurrence.id)).status).toBe("PENDING")

    expect((await postOccurrence(w.user.id, occurrence.id)).status).toBe("POSTED")
  })

  it("refuses to skip or put back a posted occurrence", async () => {
    const w = await setup()
    const { occurrence } = await pendingOccurrence(w)
    await postOccurrence(w.user.id, occurrence.id)

    expect(await rejection(dismissOccurrence(w.user.id, occurrence.id))).toBeInstanceOf(OccurrenceStateError)
    expect(await rejection(restoreOccurrence(w.user.id, occurrence.id))).toBeInstanceOf(OccurrenceStateError)
    expect((await stored(occurrence.id)).status).toBe("POSTED")
  })
})

describe("a quantity-valued destination", () => {
  it("needs a quantity to post, and the lot is made with it", async () => {
    const w = await setup()
    const rule = await registry.makeRule(w.user.id, w.bank.id, w.gold.id, { name: "Gold SIP", amountPaise: 500_00n })
    const occurrence = await registry.makeOccurrence(w.user.id, rule.id, "2026-03-05")

    const error = await rejection(postOccurrence(w.user.id, occurrence.id))
    expect(error).toBeInstanceOf(InvalidTransactionError)
    expect((error as InvalidTransactionError).violations.map((v) => v.code)).toEqual(["QUANTITY_REQUIRED"])
    expect((await stored(occurrence.id)).status).toBe("PENDING")
    expect(await transactionsFor(occurrence.id)).toHaveLength(0)

    const view = await postOccurrence(w.user.id, occurrence.id, { quantity: 2n * UNIT })
    expect(view).toMatchObject({ status: "POSTED", needsQuantity: true, unitLabel: "g", toName: "Gold" })
    const lots = await findLiveLots(w.user.id, w.gold.id)
    expect(lots).toHaveLength(1)
    expect(lots[0].quantity).toBe(2n * UNIT)
  })

  it("says so in the view while the occurrence is still pending, and not for a lump investment", async () => {
    const w = await setup()
    const lump = await registry.makeNode(w.user.id, "INVESTMENT", "Plot", { valuationMode: "LUMP" })
    const goldRule = await registry.makeRule(w.user.id, w.bank.id, w.gold.id, { amountPaise: 100n })
    const lumpRule = await registry.makeRule(w.user.id, w.bank.id, lump.id, { amountPaise: 100n })
    const goldOccurrence = await registry.makeOccurrence(w.user.id, goldRule.id, "2026-03-05")
    const lumpOccurrence = await registry.makeOccurrence(w.user.id, lumpRule.id, "2026-03-05")

    expect(await dismissOccurrence(w.user.id, goldOccurrence.id)).toMatchObject({ needsQuantity: true, unitLabel: "g" })
    expect(await dismissOccurrence(w.user.id, lumpOccurrence.id)).toMatchObject({ needsQuantity: false, unitLabel: null })
  })
})

describe("the existing write rules still hold", () => {
  it("throws OverdraftBlockedError for a blockNegative source and leaves the occurrence pending", async () => {
    const w = await setup()
    await prisma.ledgerNode.update({ where: { id: w.bank.id }, data: { blockNegative: true } })
    const { occurrence } = await pendingOccurrence(w, { amountPaise: 5_000_00n })

    expect(await rejection(postOccurrence(w.user.id, occurrence.id))).toBeInstanceOf(OverdraftBlockedError)

    expect((await stored(occurrence.id)).status).toBe("PENDING")
    expect(await transactionsFor(occurrence.id)).toHaveLength(0)
    expect(await balanceOf(w.user.id, w.bank.id)).toBe(1_000_00n)
  })

  it("lets an occurrence of an archived node be skipped, but not posted", async () => {
    const w = await setup()
    const { occurrence } = await pendingOccurrence(w)
    await archiveLedgerNode(w.user.id, w.food.id)

    const error = await rejection(postOccurrence(w.user.id, occurrence.id))
    expect(error).toBeInstanceOf(InvalidTransactionError)
    expect((error as Error).message).toContain("archived")
    expect((await stored(occurrence.id)).status).toBe("PENDING")
    expect(await transactionsFor(occurrence.id)).toHaveLength(0)

    const skipped = await dismissOccurrence(w.user.id, occurrence.id)
    expect(skipped).toMatchObject({ status: "DISMISSED", nodeArchived: true })
  })
})

describe("whose occurrence it is", () => {
  it("is not found for another user, from all three functions, and nothing changes", async () => {
    const owner = await setup()
    const stranger = await setup()
    const { occurrence } = await pendingOccurrence(owner)

    await expectNotFound(postOccurrence(stranger.user.id, occurrence.id))
    await expectNotFound(dismissOccurrence(stranger.user.id, occurrence.id))
    await expectNotFound(restoreOccurrence(stranger.user.id, occurrence.id))
    await expectNotFound(postOccurrence(stranger.user.id, "no-such-id"))
    expect((await stored(occurrence.id)).status).toBe("PENDING")
    expect(await transactionsFor(occurrence.id)).toHaveLength(0)
  })
})

describe("an occurrence of a deleted rule is gone", () => {
  const deleteRule = (userId: string, ruleId: string) => inTransaction((uow) => softDeleteRule(userId, ruleId, uow))

  it("cannot be posted, skipped or put back, including a pending one (purged) and a skipped one", async () => {
    const w = await setup()
    const { rule, occurrence: pending } = await pendingOccurrence(w)
    const skipped = await registry.makeOccurrence(w.user.id, rule.id, "2026-04-05", { status: "DISMISSED", resolvedAt: new Date() })
    const paid = await registry.makeTransaction(w.user.id, w.bank.id, w.food.id, { amountPaise: 100_00n })
    const posted = await registry.makeOccurrence(w.user.id, rule.id, "2026-05-05", {
      status: "POSTED",
      resolvedAt: new Date(),
      transactionId: paid.id,
    })
    await deleteRule(w.user.id, rule.id)

    await expectNotFound(postOccurrence(w.user.id, pending.id))
    for (const id of [skipped.id, posted.id]) {
      await expectNotFound(postOccurrence(w.user.id, id))
      await expectNotFound(dismissOccurrence(w.user.id, id))
      await expectNotFound(restoreOccurrence(w.user.id, id))
    }
    // the dismissed occurrence of the deleted rule was not revived
    expect((await stored(skipped.id)).status).toBe("DISMISSED")
    expect((await stored(posted.id)).status).toBe("POSTED")
    expect(await transactionsFor(skipped.id)).toHaveLength(0)
  })

  it("cannot be put back after the rule is deleted, though it could be before", async () => {
    const w = await setup()
    const { rule, occurrence } = await pendingOccurrence(w)
    await dismissOccurrence(w.user.id, occurrence.id)
    await deleteRule(w.user.id, rule.id)

    await expectNotFound(restoreOccurrence(w.user.id, occurrence.id))
    expect((await stored(occurrence.id)).status).toBe("DISMISSED")
  })
})

// The post is two writes: the transaction, then the mark on the occurrence. A skip or a delete that lands between them
// leaves a transaction that WAS recorded, so what the user is told must say so (not "skipped, put it back to post it",
// which reads as though nothing happened). The window is a few milliseconds wide, so it is opened on purpose: the real
// `recordTransaction` runs, and the other tab's write is made right after it commits.
describe("a post that loses a race with a skip or a delete", () => {
  const afterRecording = (then: () => Promise<unknown>) => {
    const record = transactionService.recordTransaction
    vi.spyOn(transactionService, "recordTransaction").mockImplementationOnce(async (...args) => {
      const recorded = await record(...args)
      await then()
      return recorded
    })
  }

  it("says the transaction was recorded when a skip landed first, and posting again after a put back does not record it twice", async () => {
    const w = await setup()
    const { occurrence } = await pendingOccurrence(w)
    afterRecording(() => dismissOccurrence(w.user.id, occurrence.id))

    const error = await rejection(postOccurrence(w.user.id, occurrence.id))
    expect(error).toBeInstanceOf(OccurrenceStateError)
    expect((error as Error).message).toBe(
      "It was recorded before the skip landed: check Transactions. Putting it back and posting again will not record it twice.",
    )
    expect((await stored(occurrence.id)).status).toBe("DISMISSED")
    expect(await transactionsFor(occurrence.id)).toHaveLength(1)
    expect(await balanceOf(w.user.id, w.food.id)).toBe(100_00n)

    // The promise in the message: the key replays the same transaction and the occurrence is linked to it.
    await restoreOccurrence(w.user.id, occurrence.id)
    const posted = await postOccurrence(w.user.id, occurrence.id)
    expect(posted.status).toBe("POSTED")
    expect(await transactionsFor(occurrence.id)).toHaveLength(1)
    expect(await balanceOf(w.user.id, w.food.id)).toBe(100_00n)
    expect((await stored(occurrence.id)).transactionId).toBe((await transactionsFor(occurrence.id))[0].id)
  })

  it("says the transaction was recorded when the rule was deleted first, not that the entry no longer exists", async () => {
    const w = await setup()
    const { rule, occurrence } = await pendingOccurrence(w)
    afterRecording(() => inTransaction((uow) => softDeleteRule(w.user.id, rule.id, uow)))

    const error = await rejection(postOccurrence(w.user.id, occurrence.id))
    expect(error).toBeInstanceOf(OccurrenceStateError)
    expect((error as Error).message).toBe(
      "It was recorded before the rule was deleted: check Transactions. The entry itself is gone.",
    )
    expect(await transactionsFor(occurrence.id)).toHaveLength(1)
  })

  it("still answers with the first result when the other tab posted it, however the race fell", async () => {
    const w = await setup()
    const { occurrence } = await pendingOccurrence(w)
    afterRecording(async () => {
      await postOccurrence(w.user.id, occurrence.id) // the other tab: the key replays this transaction
    })
    const view = await postOccurrence(w.user.id, occurrence.id)
    expect(view.status).toBe("POSTED")
    expect(await transactionsFor(occurrence.id)).toHaveLength(1)
  })
})
