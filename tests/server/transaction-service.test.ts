import { randomUUID } from "node:crypto"
import { afterAll, describe, expect, it } from "vitest"
import { calendarDate, fromDbDate, todayIn, toDbDate, type CalendarDate } from "@/domain/calendar-date"
import { prisma } from "@/server/db"
import { NotFoundError } from "@/server/repositories/errors"
import { sumBalances, VersionConflictError } from "@/server/repositories/transaction-repository"
import { archiveLedgerNode } from "@/server/services/node-service"
import {
  editTransaction,
  InvalidTransactionError,
  OverdraftBlockedError,
  recordTransaction,
  removeTransaction,
  restoreTransaction,
  type RecordTransactionInput,
} from "@/server/services/transaction-service"
import { createRegistry } from "./repositories/fixtures"

const registry = createRegistry()
afterAll(registry.cleanup)

// The default user timezone (prisma/schema.prisma) is Asia/Kolkata, which is what the service reads "today" in.
const today = () => todayIn("Asia/Kolkata")
const addDays = (date: CalendarDate, days: number) => fromDbDate(new Date(toDbDate(date).getTime() + days * 86_400_000))
const PAST = calendarDate("2026-03-01")

/**
 * A user with an income source, two bank accounts, a card with a Rs 50,000 limit, an expense node and an investment,
 * and a Rs 1,000.00 opening deposit into the main account long ago.
 */
async function setup(opening = 1_000_00n) {
  const user = await registry.makeUser()
  const income = await registry.makeNode(user.id, "INCOME_SOURCE", "Salary")
  const bank = await registry.makeNode(user.id, "ASSET", "Bank")
  const savings = await registry.makeNode(user.id, "ASSET", "Savings")
  const card = await prisma.ledgerNode.create({
    data: { userId: user.id, kind: "LIABILITY", name: "Card", liabilitySubtype: "CREDIT_CARD", creditLimitPaise: 50_000_00n },
  })
  const food = await registry.makeNode(user.id, "EXPENSE", "Food")
  const fund = await registry.makeNode(user.id, "INVESTMENT", "Fund")
  const deposit = await registry.makeTransaction(user.id, income.id, bank.id, { amountPaise: opening, occurredAt: "2026-01-01" })
  return { user, income, bank, savings, card, food, fund, deposit }
}

type Node = { id: string }
const record = (userId: string, from: Node, to: Node, amount: bigint, over: Partial<RecordTransactionInput> = {}) =>
  recordTransaction(userId, {
    fromNodeId: from.id,
    toNodeId: to.id,
    amount,
    occurredAt: PAST,
    idempotencyKey: randomUUID(),
    ...over,
  })

async function balanceOf(userId: string, node: Node, asOf?: CalendarDate): Promise<bigint> {
  const row = (await sumBalances(userId, asOf)).find((b) => b.nodeId === node.id)
  if (!row) throw new Error("no such node")
  return row.balance
}

const rowCount = (userId: string) => prisma.transaction.count({ where: { userId } })
const codes = (warnings: { code: string }[]) => warnings.map((w) => w.code)
const blockNegative = (nodeId: string) => prisma.ledgerNode.update({ where: { id: nodeId }, data: { blockNegative: true } })

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected a rejection")
    },
    (error: unknown) => error,
  )
}

describe("recordTransaction", () => {
  it("records a legal transaction and moves both balances", async () => {
    const { user, bank, food } = await setup()
    const view = await record(user.id, bank, food, 300_00n, { note: "  lunch  ", tags: ["food", "food", " social "] })
    expect(view).toMatchObject({
      fromNodeId: bank.id,
      toNodeId: food.id,
      amountPaise: "30000",
      occurredAt: PAST,
      note: "lunch",
      tags: ["food", "social"],
      groupId: null,
      version: 0,
      warnings: [],
    })
    expect(await balanceOf(user.id, bank)).toBe(700_00n)
    expect(await balanceOf(user.id, food)).toBe(300_00n)
  })

  it("rejects an illegal flow with the domain's message and writes nothing", async () => {
    // EC-7
    const { user, bank, income } = await setup()
    const before = await rowCount(user.id)
    const error = await rejection(record(user.id, bank, income, 100n))
    expect(error).toBeInstanceOf(InvalidTransactionError)
    expect((error as InvalidTransactionError).message).toBe("Money cannot flow from ASSET to INCOME_SOURCE.")
    expect((error as InvalidTransactionError).violations.map((v) => v.code)).toEqual(["ILLEGAL_FLOW"])
    expect((error as InvalidTransactionError).violations.map((v) => v.leg)).toEqual([undefined]) // a single transaction has no legs
    expect(await rowCount(user.id)).toBe(before)
  })

  it("rejects a transfer from a node to itself and a zero amount, reporting both rules at once", async () => {
    // EC-6, EC-2
    const { user, bank } = await setup()
    const error = await rejection(record(user.id, bank, bank, 0n))
    expect((error as InvalidTransactionError).violations.map((v) => v.code).sort()).toEqual(["NON_POSITIVE_AMOUNT", "SAME_NODE"])
  })

  it("does not let a new entry select an archived node", async () => {
    // EC-14, RF#5: allowArchived is false on create
    const { user, bank, savings, food } = await setup()
    await archiveLedgerNode(user.id, savings.id)
    const error = await rejection(record(user.id, savings, food, 100n))
    expect((error as InvalidTransactionError).violations.map((v) => v.code)).toEqual(["ARCHIVED_NODE"])
    const intoArchived = await rejection(record(user.id, bank, savings, 100n))
    expect((intoArchived as InvalidTransactionError).violations.map((v) => v.code)).toEqual(["ARCHIVED_NODE"])
  })

  it("answers not-found, writing nothing, for another user's node", async () => {
    // EC-8
    const { user, bank } = await setup()
    const other = await setup()
    const before = await rowCount(user.id)
    expect(await rejection(record(user.id, bank, other.food, 100n))).toBeInstanceOf(NotFoundError)
    expect(await rejection(record(user.id, other.bank, other.food, 100n))).toBeInstanceOf(NotFoundError)
    expect(await rowCount(user.id)).toBe(before)
    expect(await rowCount(other.user.id)).toBe(1)
  })

  it("rejects an empty idempotency key rather than leaking a database error", async () => {
    const { user, bank, food } = await setup()
    const before = await rowCount(user.id)
    expect(await rejection(record(user.id, bank, food, 100n, { idempotencyKey: "" }))).toBeInstanceOf(InvalidTransactionError)
    expect(await rowCount(user.id)).toBe(before)
  })

  describe("idempotency", () => {
    it("returns the first result for a replayed idempotency key", async () => {
      // EC-17, RF#4
      const { user, bank, food } = await setup()
      const key = randomUUID()
      const first = await record(user.id, bank, food, 300_00n, { idempotencyKey: key, note: "first" })
      // The replay differs in every field: the stored row wins, nothing is applied twice.
      const second = await record(user.id, bank, food, 999_00n, { idempotencyKey: key, note: "second" })
      expect(second.id).toBe(first.id)
      expect(second.amountPaise).toBe("30000")
      expect(second.note).toBe("first")
      expect(await rowCount(user.id)).toBe(2) // the opening deposit and the one spend
      expect(await balanceOf(user.id, bank)).toBe(700_00n)
    })

    it("creates only one row when the same key is submitted twice concurrently", async () => {
      // RF#4
      const { user, bank, food } = await setup()
      const key = randomUUID()
      const results = await Promise.all(Array.from({ length: 5 }, () => record(user.id, bank, food, 100_00n, { idempotencyKey: key })))
      expect(new Set(results.map((r) => r.id)).size).toBe(1)
      expect(await prisma.transaction.count({ where: { userId: user.id, idempotencyKey: key } })).toBe(1)
      expect(await balanceOf(user.id, bank)).toBe(900_00n)
    })

    it("still answers with the first result after one of its nodes was archived", async () => {
      const { user, bank, food } = await setup()
      const key = randomUUID()
      const first = await record(user.id, bank, food, 100n, { idempotencyKey: key })
      await archiveLedgerNode(user.id, food.id)
      const replay = await record(user.id, bank, food, 100n, { idempotencyKey: key })
      expect(replay.id).toBe(first.id)
    })

    it("does not mistake a replay for an overdraft: the first spend already used the balance", async () => {
      // The double-click case on a blockNegative account: balance 100.00, spend 80.00, the retry arrives after the
      // first has committed. Guarding before looking for the key would see 20.00 - 80.00 < 0 and refuse it.
      const { user, bank, food } = await setup(100_00n)
      await blockNegative(bank.id)
      const key = randomUUID()
      const first = await record(user.id, bank, food, 80_00n, { idempotencyKey: key })
      const replay = await record(user.id, bank, food, 80_00n, { idempotencyKey: key })
      expect(replay.id).toBe(first.id)
      expect(await balanceOf(user.id, bank)).toBe(20_00n)
    })

    it("keeps the same key under two users apart", async () => {
      const a = await setup()
      const b = await setup()
      const key = randomUUID()
      const first = await record(a.user.id, a.bank, a.food, 100n, { idempotencyKey: key })
      const second = await record(b.user.id, b.bank, b.food, 100n, { idempotencyKey: key })
      expect(second.id).not.toBe(first.id)
    })
  })

  describe("warnings", () => {
    it("warns but does not block when an asset would go negative", async () => {
      // EC-11
      const { user, bank, food } = await setup(100_00n)
      const view = await record(user.id, bank, food, 150_00n)
      expect(codes(view.warnings)).toEqual(["OVERDRAWN"])
      expect(view.warnings[0].message).toContain("Bank")
      expect(view.warnings[0].message).toContain("-₹50.00")
      expect(await balanceOf(user.id, bank)).toBe(-50_00n)
      expect(await rowCount(user.id)).toBe(2)
    })

    it("does not warn when the spend leaves the asset at exactly zero", async () => {
      const { user, bank, food } = await setup(100_00n)
      expect((await record(user.id, bank, food, 100_00n)).warnings).toEqual([])
    })

    it("blocks an overdraft when the account sets blockNegative", async () => {
      // EC-11
      const { user, bank, food } = await setup(100_00n)
      await blockNegative(bank.id)
      const before = await rowCount(user.id)
      const error = await rejection(record(user.id, bank, food, 150_00n))
      expect(error).toBeInstanceOf(OverdraftBlockedError)
      expect((error as OverdraftBlockedError).message).toContain("Bank")
      expect(await rowCount(user.id)).toBe(before)
      expect(await balanceOf(user.id, bank)).toBe(100_00n)
      // a spend that stays within the balance is unaffected
      expect(codes((await record(user.id, bank, food, 100_00n)).warnings)).toEqual([])
    })

    it("warns but does not block when a card exceeds its credit limit", async () => {
      // EC-12. A card you owe on is NEGATIVE (inflows - outflows), so owing 60,000 against a 50,000 limit is a
      // balance of -60,000: over the limit when the balance is below minus the limit.
      const { user, card, food } = await setup()
      const view = await record(user.id, card, food, 60_000_00n)
      expect(codes(view.warnings)).toEqual(["OVER_CREDIT_LIMIT"]) // and not OVERDRAWN: a liability owing money is normal
      expect(view.warnings[0].message).toContain("₹60,000.00")
      expect(view.warnings[0].message).toContain("₹50,000.00")
      expect(await balanceOf(user.id, card)).toBe(-60_000_00n)
    })

    it("does not warn while a card is within, or exactly at, its limit", async () => {
      const { user, card, food } = await setup()
      expect((await record(user.id, card, food, 10_000_00n)).warnings).toEqual([])
      expect((await record(user.id, card, food, 40_000_00n)).warnings).toEqual([]) // owed 50,000 of 50,000
      expect(codes((await record(user.id, card, food, 1n)).warnings)).toEqual(["OVER_CREDIT_LIMIT"]) // one paisa over
    })

    it("does not warn about a card limit when paying the card, or when the card has no limit", async () => {
      const { user, bank, card, food } = await setup(100_000_00n)
      await record(user.id, card, food, 60_000_00n) // over the limit
      // paying part of it from the bank is a movement INTO the card: still over the limit, but not this movement's doing
      expect((await record(user.id, bank, card, 5_000_00n)).warnings).toEqual([])
      const loan = await prisma.ledgerNode.create({ data: { userId: user.id, kind: "LIABILITY", name: "Loan", liabilitySubtype: "LOAN" } })
      expect((await record(user.id, loan, food, 90_000_00n)).warnings).toEqual([])
    })

    it("does not warn about an overdraft for a card that is in credit", async () => {
      const { user, bank, card, food } = await setup(100_000_00n)
      await record(user.id, bank, card, 5_000_00n) // overpaid: balance +5,000
      expect((await record(user.id, card, food, 1_000_00n)).warnings).toEqual([])
      expect(await balanceOf(user.id, card)).toBe(4_000_00n)
    })

    it("warns that a future-dated transaction is dated after today", async () => {
      // EC-10
      const { user, bank, food } = await setup()
      const later = addDays(today(), 10)
      const view = await record(user.id, bank, food, 100_00n, { occurredAt: later })
      expect(codes(view.warnings)).toEqual(["FUTURE_DATED"])
      expect(view.warnings[0].message).toContain(later)
      expect(view.occurredAt).toBe(later)
    })

    it("does not call today future-dated", async () => {
      const { user, bank, food } = await setup()
      expect((await record(user.id, bank, food, 100_00n, { occurredAt: today() })).warnings).toEqual([])
    })
  })

  it("accepts a backdated transaction and changes past balances", async () => {
    // EC-9
    const { user, bank, food } = await setup()
    const dayBefore = calendarDate("2026-01-31")
    const dayAfter = calendarDate("2026-03-15")
    expect(await balanceOf(user.id, bank, dayAfter)).toBe(1_000_00n)
    const view = await record(user.id, bank, food, 200_00n, { occurredAt: calendarDate("2026-02-01") })
    expect(view.warnings).toEqual([])
    expect(await balanceOf(user.id, bank, dayBefore)).toBe(1_000_00n) // before the spend: unchanged
    expect(await balanceOf(user.id, bank, dayAfter)).toBe(800_00n) // a balance that was already history has moved
    expect(await balanceOf(user.id, bank)).toBe(800_00n)
  })

  it("accepts a future-dated transaction and excludes it from the current balance", async () => {
    // EC-10
    const { user, bank, food } = await setup()
    await record(user.id, bank, food, 300_00n, { occurredAt: addDays(today(), 10) })
    expect(await balanceOf(user.id, bank, today())).toBe(1_000_00n) // current: the future row is not in it
    expect(await balanceOf(user.id, bank)).toBe(700_00n) // projected: it is
  })

  it("permits a refund larger than the original spend", async () => {
    // EC-20: no cap
    const { user, bank, food } = await setup()
    await record(user.id, bank, food, 100_00n)
    const refund = await record(user.id, food, bank, 150_00n)
    expect(refund.warnings).toEqual([])
    expect(await balanceOf(user.id, food)).toBe(-50_00n)
    expect(await balanceOf(user.id, bank)).toBe(1_050_00n)
  })
})

describe("editTransaction", () => {
  it("applies the changes, bumps the version and moves the balances", async () => {
    const { user, bank, savings, food } = await setup()
    const view = await record(user.id, bank, food, 300_00n, { note: "lunch", tags: ["a"] })
    const edited = await editTransaction(
      user.id,
      view.id,
      { amount: 400_00n, fromNodeId: savings.id, occurredAt: calendarDate("2026-03-02"), note: null, tags: ["b"] },
      view.version,
    )
    expect(edited).toMatchObject({
      id: view.id,
      fromNodeId: savings.id,
      toNodeId: food.id,
      amountPaise: "40000",
      occurredAt: "2026-03-02",
      note: null,
      tags: ["b"],
      version: 1,
    })
    expect(await balanceOf(user.id, bank)).toBe(1_000_00n)
    expect(await balanceOf(user.id, savings)).toBe(-400_00n)
    expect(await balanceOf(user.id, food)).toBe(400_00n)
  })

  it("leaves fields it is not given alone", async () => {
    const { user, bank, food } = await setup()
    const view = await record(user.id, bank, food, 300_00n, { note: "lunch", tags: ["a"] })
    const edited = await editTransaction(user.id, view.id, { amount: 100n }, view.version)
    expect(edited).toMatchObject({ fromNodeId: bank.id, toNodeId: food.id, occurredAt: PAST, note: "lunch", tags: ["a"] })
  })

  it("permits editing a transaction that references an archived node", async () => {
    // EC-14, RF#5: allowArchived is true on edit
    const { user, bank, food } = await setup()
    const view = await record(user.id, bank, food, 100_00n)
    await archiveLedgerNode(user.id, bank.id)
    const edited = await editTransaction(user.id, view.id, { amount: 200_00n, note: "corrected" }, view.version)
    expect(edited.amountPaise).toBe("20000")
    expect(edited.note).toBe("corrected")
    // while a new entry on the same archived node is still refused
    expect(await rejection(record(user.id, bank, food, 100n))).toBeInstanceOf(InvalidTransactionError)
  })

  it("revalidates the flow against the matrix when an end is changed", async () => {
    // EC-16
    const { user, bank, food, income } = await setup()
    const view = await record(user.id, bank, food, 100_00n)
    const error = await rejection(editTransaction(user.id, view.id, { toNodeId: income.id }, view.version))
    expect(error).toBeInstanceOf(InvalidTransactionError)
    expect((error as InvalidTransactionError).message).toBe("Money cannot flow from ASSET to INCOME_SOURCE.")
    expect(await balanceOf(user.id, food)).toBe(100_00n) // unchanged
    const same = await rejection(editTransaction(user.id, view.id, { toNodeId: bank.id }, view.version))
    expect((same as InvalidTransactionError).violations.map((v) => v.code)).toEqual(["SAME_NODE"])
  })

  it("throws VersionConflictError carrying the current row when the expected version is stale", async () => {
    // EC-18
    const { user, bank, food } = await setup()
    const view = await record(user.id, bank, food, 100_00n)
    await editTransaction(user.id, view.id, { note: "tab one" }, view.version)
    const error = await rejection(editTransaction(user.id, view.id, { note: "tab two" }, view.version))
    expect(error).toBeInstanceOf(VersionConflictError)
    expect((error as VersionConflictError).current).toMatchObject({ id: view.id, version: 1, note: "tab one" })
    expect((await prisma.transaction.findUniqueOrThrow({ where: { id: view.id } })).note).toBe("tab one")
  })

  it("lets exactly one of two concurrent edits at the same version win", async () => {
    const { user, bank, food } = await setup()
    const view = await record(user.id, bank, food, 100_00n)
    const results = await Promise.allSettled([
      editTransaction(user.id, view.id, { note: "one" }, view.version),
      editTransaction(user.id, view.id, { note: "two" }, view.version),
    ])
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
    const lost = results.find((r) => r.status === "rejected")
    expect(lost && lost.status === "rejected" && lost.reason).toBeInstanceOf(VersionConflictError)
  })

  it("answers not-found for another user's transaction, an unknown id and a deleted one", async () => {
    const a = await setup()
    const b = await setup()
    const theirs = await record(b.user.id, b.bank, b.food, 100n)
    expect(await rejection(editTransaction(a.user.id, theirs.id, { note: "x" }, theirs.version))).toBeInstanceOf(NotFoundError)
    expect(await rejection(editTransaction(a.user.id, "no-such-id", { note: "x" }, 0))).toBeInstanceOf(NotFoundError)
    await removeTransaction(b.user.id, theirs.id)
    expect(await rejection(editTransaction(b.user.id, theirs.id, { note: "x" }, theirs.version))).toBeInstanceOf(NotFoundError)
  })

  it("answers not-found, changing nothing, when re-pointed at another user's node", async () => {
    const a = await setup()
    const b = await setup()
    const mine = await record(a.user.id, a.bank, a.food, 100n)
    expect(await rejection(editTransaction(a.user.id, mine.id, { toNodeId: b.food.id }, mine.version))).toBeInstanceOf(NotFoundError)
    expect((await prisma.transaction.findUniqueOrThrow({ where: { id: mine.id } })).toNodeId).toBe(a.food.id)
  })

  it("warns, as on create, when the edit overdraws the account or dates it in the future", async () => {
    const { user, bank, food } = await setup(100_00n)
    const view = await record(user.id, bank, food, 50_00n)
    const overdrawn = await editTransaction(user.id, view.id, { amount: 150_00n }, view.version)
    expect(codes(overdrawn.warnings)).toEqual(["OVERDRAWN"])
    const later = await editTransaction(user.id, view.id, { occurredAt: addDays(today(), 5) }, overdrawn.version)
    // still overdrawn, now as a projection: the balance on the day it lands includes it
    expect(codes(later.warnings)).toEqual(["OVERDRAWN", "FUTURE_DATED"])
  })

  it("blocks an edit that overdraws a blockNegative account, and leaves the row as it was", async () => {
    const { user, bank, food } = await setup(100_00n)
    const view = await record(user.id, bank, food, 50_00n)
    await blockNegative(bank.id)
    expect(await rejection(editTransaction(user.id, view.id, { amount: 150_00n }, view.version))).toBeInstanceOf(OverdraftBlockedError)
    const row = await prisma.transaction.findUniqueOrThrow({ where: { id: view.id } })
    expect(row).toMatchObject({ amountPaise: 50_00n, version: view.version })
  })

  it("blocks an edit that lowers the deposit behind a blockNegative account", async () => {
    // The overdraft is caused at the destination end: nothing is spent, the money that was there is reduced.
    const { user, bank, food, deposit } = await setup(1_000_00n)
    await record(user.id, bank, food, 800_00n)
    await blockNegative(bank.id)
    const error = await rejection(editTransaction(user.id, deposit.id, { amount: 100_00n }, deposit.version))
    expect(error).toBeInstanceOf(OverdraftBlockedError)
    expect(await balanceOf(user.id, bank)).toBe(200_00n)
  })

  it("warns when an edit lowers the deposit behind an account and leaves it negative", async () => {
    // The unguarded, common case of the test above: the account that goes negative is the DESTINATION of the edited
    // row, not its source (an INCOME_SOURCE), so judging only the source would say nothing at all.
    const { user, bank, food, deposit } = await setup(1_000_00n)
    await record(user.id, bank, food, 800_00n)
    const edited = await editTransaction(user.id, deposit.id, { amount: 100_00n }, deposit.version)
    expect(codes(edited.warnings)).toEqual(["OVERDRAWN"])
    expect(edited.warnings[0].message).toContain("Bank")
    expect(edited.warnings[0].message).toContain("-₹700.00")
    expect(await balanceOf(user.id, bank)).toBe(-700_00n)
  })

  it("warns about the account an edit moved the row away from, if that is now negative", async () => {
    // Re-pointing a deposit from one account to another takes the money out of the old destination.
    const { user, bank, savings, food, deposit } = await setup(1_000_00n)
    await record(user.id, bank, food, 800_00n)
    const edited = await editTransaction(user.id, deposit.id, { toNodeId: savings.id }, deposit.version)
    expect(codes(edited.warnings)).toEqual(["OVERDRAWN"])
    expect(edited.warnings[0].message).toContain("Bank")
  })

  it("names each touched node once, however many ends of the row it is", async () => {
    const { user, bank, savings, food } = await setup(100_00n)
    const view = await record(user.id, bank, savings, 50_00n)
    // bank -> savings edited to bank -> food: bank is both the old and the new source; it is reported once
    const edited = await editTransaction(user.id, view.id, { toNodeId: food.id, amount: 150_00n }, view.version)
    expect(codes(edited.warnings)).toEqual(["OVERDRAWN"])
  })

  it("refuses to re-point an edit onto an archived node the row never referenced", async () => {
    // EC-14: archived nodes are never selectable for new entries, and choosing one in an edit is choosing it afresh
    const { user, bank, savings, food } = await setup()
    const view = await record(user.id, bank, food, 100_00n)
    await archiveLedgerNode(user.id, savings.id)
    const toArchived = await rejection(editTransaction(user.id, view.id, { toNodeId: savings.id }, view.version))
    expect(toArchived).toBeInstanceOf(InvalidTransactionError)
    expect((toArchived as InvalidTransactionError).violations.map((v) => v.code)).toEqual(["ARCHIVED_NODE"])
    const fromArchived = await rejection(editTransaction(user.id, view.id, { fromNodeId: savings.id }, view.version))
    expect((fromArchived as InvalidTransactionError).violations.map((v) => v.code)).toEqual(["ARCHIVED_NODE"])
    expect(await prisma.transaction.findUniqueOrThrow({ where: { id: view.id } })).toMatchObject({ fromNodeId: bank.id, toNodeId: food.id, version: 0 })
  })

  it("lets an edit name a node the row already references even though it is archived", async () => {
    // Swapping the two ends, or restating an end unchanged, introduces nothing new
    const { user, bank, food } = await setup()
    const view = await record(user.id, food, bank, 100_00n) // a refund: EXPENSE -> ASSET
    await archiveLedgerNode(user.id, food.id)
    const edited = await editTransaction(user.id, view.id, { fromNodeId: food.id, toNodeId: bank.id, amount: 120_00n }, view.version)
    expect(edited.amountPaise).toBe("12000")
  })

  it("does not block an edit that leaves an already-negative blockNegative account no worse", async () => {
    const { user, bank, food } = await setup(100_00n)
    const view = await record(user.id, bank, food, 150_00n) // overdrawn before the flag is set
    await blockNegative(bank.id)
    const edited = await editTransaction(user.id, view.id, { note: "tidy" }, view.version)
    expect(edited.note).toBe("tidy")
    expect(codes(edited.warnings)).toEqual(["OVERDRAWN"]) // still true, still reported
  })
})

describe("removeTransaction and restoreTransaction", () => {
  it("soft-deletes and restores, with balances following", async () => {
    // EC-13
    const { user, bank, food } = await setup()
    const view = await record(user.id, bank, food, 300_00n)
    expect(await balanceOf(user.id, bank)).toBe(700_00n)

    await removeTransaction(user.id, view.id)
    expect(await balanceOf(user.id, bank)).toBe(1_000_00n)
    expect(await balanceOf(user.id, food)).toBe(0n)
    expect((await prisma.transaction.findUniqueOrThrow({ where: { id: view.id } })).deletedAt).not.toBeNull()

    const restored = await restoreTransaction(user.id, view.id)
    expect(restored).toMatchObject({ id: view.id, amountPaise: "30000", warnings: [] })
    expect(restored.version).toBeGreaterThan(view.version)
    expect(await balanceOf(user.id, bank)).toBe(700_00n)
    expect(await balanceOf(user.id, food)).toBe(300_00n)
  })

  it("answers not-found for a second delete, a restore of a live row, an unknown id and another user's row", async () => {
    const a = await setup()
    const b = await setup()
    const mine = await record(a.user.id, a.bank, a.food, 100n)
    const theirs = await record(b.user.id, b.bank, b.food, 100n)
    expect(await rejection(restoreTransaction(a.user.id, mine.id))).toBeInstanceOf(NotFoundError)
    await removeTransaction(a.user.id, mine.id)
    expect(await rejection(removeTransaction(a.user.id, mine.id))).toBeInstanceOf(NotFoundError)
    expect(await rejection(removeTransaction(a.user.id, "no-such-id"))).toBeInstanceOf(NotFoundError)
    expect(await rejection(removeTransaction(a.user.id, theirs.id))).toBeInstanceOf(NotFoundError)
    expect(await rejection(restoreTransaction(a.user.id, theirs.id))).toBeInstanceOf(NotFoundError)
    expect((await prisma.transaction.findUniqueOrThrow({ where: { id: theirs.id } })).deletedAt).toBeNull()
  })

  it("restores a transaction whose node has since been archived", async () => {
    // history stays correctable (EC-14)
    const { user, bank, food } = await setup()
    const view = await record(user.id, bank, food, 100_00n)
    await removeTransaction(user.id, view.id)
    await archiveLedgerNode(user.id, food.id)
    expect((await restoreTransaction(user.id, view.id)).id).toBe(view.id)
  })

  it("warns when a restore overdraws the account, and blocks it on a blockNegative account", async () => {
    const { user, bank, food } = await setup(100_00n)
    const first = await record(user.id, bank, food, 60_00n)
    await removeTransaction(user.id, first.id)
    await record(user.id, bank, food, 80_00n) // 20.00 left

    expect(codes((await restoreTransaction(user.id, first.id)).warnings)).toEqual(["OVERDRAWN"])
    await removeTransaction(user.id, first.id)
    await blockNegative(bank.id)
    expect(await rejection(restoreTransaction(user.id, first.id))).toBeInstanceOf(OverdraftBlockedError)
    expect(await balanceOf(user.id, bank)).toBe(20_00n)
    expect((await prisma.transaction.findUniqueOrThrow({ where: { id: first.id } })).deletedAt).not.toBeNull()
  })

  it("keeps the idempotency key reserved after a delete, so a late retry of the create does not resurrect it", async () => {
    const { user, bank, food } = await setup()
    const key = randomUUID()
    const view = await record(user.id, bank, food, 100_00n, { idempotencyKey: key })
    await removeTransaction(user.id, view.id)
    const retry = await record(user.id, bank, food, 100_00n, { idempotencyKey: key })
    expect(retry.id).toBe(view.id)
    expect(await balanceOf(user.id, bank)).toBe(1_000_00n) // still deleted: the retry did not bring it back
  })
})
