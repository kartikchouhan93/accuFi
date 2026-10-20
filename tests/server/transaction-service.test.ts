import { randomUUID } from "node:crypto"
import { afterAll, describe, expect, it } from "vitest"
import { calendarDate, fromDbDate, todayIn, toDbDate, type CalendarDate } from "@/domain/calendar-date"
import { prisma } from "@/server/db"
import { NotFoundError } from "@/server/repositories/errors"
import { findLiveLots, findLotByTransaction, insertConsumptions } from "@/server/repositories/lot-repository"
import {
  createTransactionGroup,
  insertTransactions,
  sumBalances,
  VersionConflictError,
} from "@/server/repositories/transaction-repository"
import { inTransaction } from "@/server/repositories/unit-of-work"
import { archiveLedgerNode } from "@/server/services/node-service"
import {
  editTransaction,
  InvalidTransactionError,
  LotInUseError,
  OverdraftBlockedError,
  recordSplit,
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
 * and a Rs 1,000.00 opening deposit into the main account long ago. Investments with each valuation mode are in
 * `investments` below.
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
    expect((error as InvalidTransactionError).message).toBe("Money cannot flow from an account to an income source.")
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
    expect((error as InvalidTransactionError).violations.map((v) => v.code)).toEqual(["ARCHIVED_SOURCE"])
    const intoArchived = await rejection(record(user.id, bank, savings, 100n))
    expect((intoArchived as InvalidTransactionError).violations.map((v) => v.code)).toEqual(["ARCHIVED_TARGET"])
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
    expect((error as InvalidTransactionError).message).toBe("Money cannot flow from an account to an income source.")
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
    expect((toArchived as InvalidTransactionError).violations.map((v) => v.code)).toEqual(["ARCHIVED_TARGET"])
    const fromArchived = await rejection(editTransaction(user.id, view.id, { fromNodeId: savings.id }, view.version))
    expect((fromArchived as InvalidTransactionError).violations.map((v) => v.code)).toEqual(["ARCHIVED_SOURCE"])
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

const UNIT = 1_000_000n

/** `setup`, plus an investment of each valuation mode: gold and silver by quantity, a plot as a lump, an SIP by contribution. */
async function investments(opening = 10_00_000_00n) {
  const world = await setup(opening)
  const { user } = world
  const gold = await registry.makeNode(user.id, "INVESTMENT", "Gold", { valuationMode: "QUANTITY", unitLabel: "g" })
  const silver = await registry.makeNode(user.id, "INVESTMENT", "Silver", { valuationMode: "QUANTITY", unitLabel: "g" })
  const plot = await registry.makeNode(user.id, "INVESTMENT", "Plot", { valuationMode: "LUMP", unitLabel: "plot" })
  const sip = await registry.makeNode(user.id, "INVESTMENT", "Index SIP", { valuationMode: "CONTRIBUTION_ONLY", unitLabel: "unit" })
  return { ...world, gold, silver, plot, sip }
}

/**
 * A sale of `quantity` from the lot `buyId` acquired, written straight through the repositories the way a disposal is
 * (the sale service posts them): a cost-basis leg gold -> bank and its consumption row, in a DISPOSAL group when `grouped`.
 */
async function sellFrom(
  userId: string,
  investment: Node,
  account: Node,
  buyId: string,
  quantity: bigint,
  costBasisPaise: bigint,
  { occurredAt = "2026-03-10", grouped = false } = {},
) {
  return inTransaction(async (uow) => {
    const group = grouped ? await createTransactionGroup(userId, "DISPOSAL", uow) : undefined
    const [leg] = await insertTransactions(
      userId,
      [{ fromNodeId: investment.id, toNodeId: account.id, amountPaise: costBasisPaise, occurredAt: calendarDate(occurredAt) }],
      group?.id,
      uow,
    )
    const lot = await findLotByTransaction(userId, buyId, uow)
    if (!lot) throw new Error("no lot to sell from")
    await insertConsumptions(userId, [{ lotId: lot.id, transactionId: leg.id, quantity, costBasisPaise }], uow)
    return leg
  })
}

const lotCount = (userId: string) => prisma.investmentLot.count({ where: { userId } })
const violationCodes = (error: unknown) => (error as InvalidTransactionError).violations.map((v) => v.code)

describe("purchases into an investment valued by quantity", () => {
  it("refuses a purchase with no quantity, writing nothing", async () => {
    const { user, bank, gold } = await investments()
    const before = await rowCount(user.id)
    const error = await rejection(record(user.id, bank, gold, 70_000_00n))
    expect(error).toBeInstanceOf(InvalidTransactionError)
    expect((error as InvalidTransactionError).message).toBe("Enter the quantity bought.")
    expect(violationCodes(error)).toEqual(["QUANTITY_REQUIRED"])
    expect(await rowCount(user.id)).toBe(before)
    expect(await lotCount(user.id)).toBe(0)
  })

  it("creates one lot holding the quantity, with the amount as its cost basis and the transaction's day", async () => {
    const { user, bank, gold } = await investments()
    const view = await record(user.id, bank, gold, 70_000_00n, { quantity: 10n * UNIT })
    expect(await findLotByTransaction(user.id, view.id)).toMatchObject({
      quantity: 10n * UNIT,
      costBasisPaise: 70_000_00n,
      acquiredAt: PAST,
      consumptions: [],
      live: true,
    })
    expect(await findLiveLots(user.id, gold.id)).toHaveLength(1)
    expect(await balanceOf(user.id, gold)).toBe(70_000_00n) // the money moves as for any transaction
  })

  it("creates the lot once for a replayed request", async () => {
    // EC-17
    const { user, bank, gold } = await investments()
    const key = randomUUID()
    const first = await record(user.id, bank, gold, 70_000_00n, { quantity: 10n * UNIT, idempotencyKey: key })
    const replay = await record(user.id, bank, gold, 70_000_00n, { quantity: 10n * UNIT, idempotencyKey: key })
    expect(replay.id).toBe(first.id)
    expect(await lotCount(user.id)).toBe(1)
  })

  it("refuses a quantity of zero or one too large to store, writing nothing", async () => {
    // The schema refuses these; the service is also called by code that never saw the schema.
    const { user, bank, gold } = await investments()
    for (const quantity of [0n, -UNIT, 10n ** 18n]) {
      const error = await rejection(record(user.id, bank, gold, 100n, { quantity }))
      expect(violationCodes(error)).toEqual(["QUANTITY_OUT_OF_RANGE"])
    }
    expect(await lotCount(user.id)).toBe(0)
  })
})

describe("purchases into an investment valued as a lump", () => {
  it("creates a lot of exactly one unit, with or without the quantity stated", async () => {
    const { user, bank, plot } = await investments()
    const unstated = await record(user.id, bank, plot, 25_00_000_00n)
    const stated = await record(user.id, bank, plot, 1_00_000_00n, { quantity: UNIT })
    expect(await findLotByTransaction(user.id, unstated.id)).toMatchObject({ quantity: UNIT, costBasisPaise: 25_00_000_00n })
    expect(await findLotByTransaction(user.id, stated.id)).toMatchObject({ quantity: UNIT, costBasisPaise: 1_00_000_00n })
  })

  it("refuses any other quantity, writing nothing", async () => {
    const { user, bank, plot } = await investments()
    const before = await rowCount(user.id)
    const error = await rejection(record(user.id, bank, plot, 100n, { quantity: 2n * UNIT }))
    expect(error).toBeInstanceOf(InvalidTransactionError)
    expect(violationCodes(error)).toEqual(["LUMP_QUANTITY"])
    expect((error as InvalidTransactionError).message).toBe("Plot is valued as one lump sum, so its quantity is always 1.")
    expect(await rowCount(user.id)).toBe(before)
    expect(await lotCount(user.id)).toBe(0)
  })
})

describe("quantity anywhere else", () => {
  it("is refused on an investment valued by contribution and on any other destination, writing nothing", async () => {
    const { user, bank, sip, food, savings } = await investments()
    const before = await rowCount(user.id)
    for (const to of [sip, food, savings]) {
      const error = await rejection(record(user.id, bank, to, 100n, { quantity: UNIT }))
      expect(error).toBeInstanceOf(InvalidTransactionError)
      expect((error as InvalidTransactionError).message).toBe("Quantity applies only to investments valued by quantity.")
      expect(violationCodes(error)).toEqual(["QUANTITY_NOT_APPLICABLE"])
    }
    expect(await rowCount(user.id)).toBe(before)
    expect(await lotCount(user.id)).toBe(0)
  })

  it("leaves a contribution-valued investment exactly as before: no quantity, no lot (EC-28)", async () => {
    const { user, bank, sip } = await investments()
    await record(user.id, bank, sip, 10_000_00n)
    expect(await balanceOf(user.id, sip)).toBe(10_000_00n)
    expect(await lotCount(user.id)).toBe(0)
  })
})

describe("splits and lot-mode investments", () => {
  const legOf = (to: Node, amount: bigint) => ({ toNodeId: to.id, amount })
  const split = (userId: string, from: Node, legs: { toNodeId: string; amount: bigint }[]) =>
    recordSplit(userId, { fromNodeId: from.id, occurredAt: PAST, legs, idempotencyKey: randomUUID() })

  it("refuses a leg into a lot-mode investment, naming the leg, and writes nothing", async () => {
    const { user, bank, food, gold, plot } = await investments()
    const before = await rowCount(user.id)
    for (const target of [gold, plot]) {
      const error = await rejection(split(user.id, bank, [legOf(food, 100n), legOf(target, 200n)]))
      expect(error).toBeInstanceOf(InvalidTransactionError)
      expect((error as InvalidTransactionError).violations).toMatchObject([{ code: "LOT_SPLIT_LEG", leg: 1 }])
      expect((error as InvalidTransactionError).message).toContain("Leg 2")
      expect((error as InvalidTransactionError).message).toContain("record an investment purchase on its own")
    }
    expect(await rowCount(user.id)).toBe(before)
  })

  it("refuses a split out of a lot-mode investment once, on the source", async () => {
    const { user, bank, savings, gold } = await investments()
    const error = await rejection(split(user.id, gold, [legOf(bank, 100n), legOf(savings, 200n)]))
    expect((error as InvalidTransactionError).violations.map((v) => [v.code, v.leg])).toEqual([["LOT_SOURCE", undefined]])
  })

  it("still takes a leg into a contribution-valued investment", async () => {
    const { user, bank, food, sip } = await investments()
    expect(await split(user.id, bank, [legOf(food, 100n), legOf(sip, 200n)])).toHaveLength(2)
  })
})

describe("money out of a lot-mode investment through the generic path", () => {
  it("is refused with a pointer to Sell, writing nothing (call 3)", async () => {
    const { user, bank, food, gold, plot, card } = await investments()
    await record(user.id, bank, gold, 70_000_00n, { quantity: 10n * UNIT })
    const before = await rowCount(user.id)
    // a redemption to an account, a fee to an expense, a payment of a card
    for (const [from, to] of [
      [gold, bank],
      [gold, food],
      [plot, card],
    ] as const) {
      const error = await rejection(record(user.id, from, to, 100n))
      expect(error).toBeInstanceOf(InvalidTransactionError)
      expect((error as InvalidTransactionError).message).toContain("Use Sell on the Investments screen")
      expect(violationCodes(error)).toEqual(["LOT_SOURCE"])
    }
    expect(await rowCount(user.id)).toBe(before)
  })

  it("refuses a switch between investments when either end is lot-mode", async () => {
    const { user, bank, gold, silver, sip } = await investments()
    await record(user.id, bank, sip, 10_000_00n)
    const before = await rowCount(user.id)
    const out = await rejection(record(user.id, gold, sip, 100n))
    expect(violationCodes(out)).toEqual(["LOT_SWITCH"])
    expect((out as InvalidTransactionError).message).toContain("Use Sell on the Investments screen")
    expect(violationCodes(await rejection(record(user.id, gold, silver, 100n, { quantity: UNIT })))).toEqual(["LOT_SWITCH"])
    const into = await rejection(record(user.id, sip, gold, 100n, { quantity: UNIT }))
    expect(violationCodes(into)).toEqual(["LOT_SWITCH"])
    expect((into as InvalidTransactionError).message).toContain("then buy Gold")
    expect(await rowCount(user.id)).toBe(before)
  })

  it("still records a redemption out of a contribution-valued investment (EC-28)", async () => {
    const { user, bank, sip } = await investments()
    await record(user.id, bank, sip, 10_000_00n)
    await record(user.id, sip, bank, 4_000_00n)
    expect(await balanceOf(user.id, sip)).toBe(6_000_00n)
  })
})

describe("editing a purchase that created a lot", () => {
  it("moves the lot in lockstep with the amount, the quantity and the day (EC-15)", async () => {
    const { user, bank, gold } = await investments()
    const view = await record(user.id, bank, gold, 70_000_00n, { quantity: 10n * UNIT })
    const edited = await editTransaction(
      user.id,
      view.id,
      { amount: 80_000_00n, quantity: 12_500_000n, occurredAt: calendarDate("2026-03-05") },
      view.version,
    )
    expect(await findLotByTransaction(user.id, view.id)).toMatchObject({
      quantity: 12_500_000n,
      costBasisPaise: 80_000_00n,
      acquiredAt: "2026-03-05",
    })
    // an edit that names none of them leaves the lot alone, and the amount alone carries the basis with it
    const noted = await editTransaction(user.id, view.id, { note: "coins" }, edited.version)
    await editTransaction(user.id, view.id, { amount: 81_000_00n }, noted.version)
    expect(await findLotByTransaction(user.id, view.id)).toMatchObject({ quantity: 12_500_000n, costBasisPaise: 81_000_00n })
  })

  it("refuses a quantity below what has been sold, changing nothing (EC-15)", async () => {
    const { user, bank, gold } = await investments()
    const view = await record(user.id, bank, gold, 500_00n, { quantity: 5n * UNIT })
    await sellFrom(user.id, gold, bank, view.id, 3n * UNIT, 300_00n)
    const error = await rejection(editTransaction(user.id, view.id, { quantity: 2n * UNIT }, view.version))
    expect(error).toBeInstanceOf(InvalidTransactionError)
    expect((error as InvalidTransactionError).message).toContain("Already sold: 3 of the 5")
    expect(violationCodes(error)).toEqual(["QUANTITY_BELOW_SOLD"])
    expect(await findLotByTransaction(user.id, view.id)).toMatchObject({ quantity: 5n * UNIT })
    expect(await prisma.transaction.findUniqueOrThrow({ where: { id: view.id } })).toMatchObject({ version: view.version })
    // above what was sold is fine
    await editTransaction(user.id, view.id, { quantity: 4n * UNIT }, view.version)
    expect(await findLotByTransaction(user.id, view.id)).toMatchObject({ quantity: 4n * UNIT })
  })

  it("refuses an amount below the cost already sold, which would leave the lot a negative cost", async () => {
    const { user, bank, gold } = await investments()
    const view = await record(user.id, bank, gold, 500_00n, { quantity: 5n * UNIT })
    await sellFrom(user.id, gold, bank, view.id, 3n * UNIT, 300_00n)
    const error = await rejection(editTransaction(user.id, view.id, { amount: 299_99n }, view.version))
    expect(violationCodes(error)).toEqual(["AMOUNT_BELOW_SOLD"])
    expect(await findLotByTransaction(user.id, view.id)).toMatchObject({ costBasisPaise: 500_00n })
    await editTransaction(user.id, view.id, { amount: 300_00n }, view.version) // the 2 g left now cost nothing: allowed
  })

  it("refuses to change the cost of a purchase that has been sold in full", async () => {
    // Nothing is left to carry the difference: the whole cost went into the sale.
    const { user, bank, gold } = await investments()
    const view = await record(user.id, bank, gold, 500_00n, { quantity: 5n * UNIT })
    await sellFrom(user.id, gold, bank, view.id, 3n * UNIT, 300_00n)
    expect(violationCodes(await rejection(editTransaction(user.id, view.id, { quantity: 3n * UNIT }, view.version)))).toEqual([
      "SOLD_COST_CHANGED",
    ])
    await editTransaction(user.id, view.id, { quantity: 3n * UNIT, amount: 300_00n }, view.version)
  })

  it("refuses a day after a sale that took from it, and accepts the sale's own day", async () => {
    const { user, bank, gold } = await investments()
    const view = await record(user.id, bank, gold, 500_00n, { quantity: 5n * UNIT })
    await sellFrom(user.id, gold, bank, view.id, UNIT, 100_00n, { occurredAt: "2026-03-10" })
    const error = await rejection(editTransaction(user.id, view.id, { occurredAt: calendarDate("2026-03-11") }, view.version))
    expect(violationCodes(error)).toEqual(["DATE_AFTER_SALE"])
    expect((error as InvalidTransactionError).message).toContain("2026-03-10")
    expect(await findLotByTransaction(user.id, view.id)).toMatchObject({ acquiredAt: PAST })
    await editTransaction(user.id, view.id, { occurredAt: calendarDate("2026-03-10") }, view.version)
    expect(await findLotByTransaction(user.id, view.id)).toMatchObject({ acquiredAt: "2026-03-10" })
  })

  it("does not hold a deleted sale against the quantity or the day", async () => {
    // A deleted sale is not counted (call 1); restoring the sale is what re-checks the lots.
    const { user, bank, gold } = await investments()
    const view = await record(user.id, bank, gold, 500_00n, { quantity: 5n * UNIT })
    const sale = await sellFrom(user.id, gold, bank, view.id, 3n * UNIT, 300_00n)
    await removeTransaction(user.id, sale.id)
    await editTransaction(user.id, view.id, { quantity: UNIT, occurredAt: calendarDate("2026-03-20") }, view.version)
    expect(await findLotByTransaction(user.id, view.id)).toMatchObject({ quantity: UNIT, acquiredAt: "2026-03-20" })
  })

  it("deletes the lot when the target moves away from a lot-mode investment (EC-16)", async () => {
    const { user, bank, gold, sip, food } = await investments()
    for (const target of [sip, food]) {
      const view = await record(user.id, bank, gold, 500_00n, { quantity: 5n * UNIT })
      await editTransaction(user.id, view.id, { toNodeId: target.id }, view.version)
      expect(await findLotByTransaction(user.id, view.id)).toBeNull()
    }
    expect(await findLiveLots(user.id, gold.id)).toEqual([])
  })

  it("refuses to move a purchase that has been sold from, changing nothing", async () => {
    const { user, bank, gold, silver, sip } = await investments()
    const view = await record(user.id, bank, gold, 500_00n, { quantity: 5n * UNIT })
    await sellFrom(user.id, gold, bank, view.id, 3n * UNIT, 300_00n)
    for (const target of [sip, silver]) {
      const error = await rejection(editTransaction(user.id, view.id, { toNodeId: target.id }, view.version))
      expect(error).toBeInstanceOf(LotInUseError)
      expect((error as LotInUseError).message).toContain("Already sold: 3 of the 5")
      expect((error as LotInUseError).message).toContain("Delete the sale first")
    }
    expect(await findLiveLots(user.id, gold.id)).toHaveLength(1)
    expect((await prisma.transaction.findUniqueOrThrow({ where: { id: view.id } })).toNodeId).toBe(gold.id)
  })

  it("refuses to move a purchase a deleted sale still takes from, which restoring the sale would need", async () => {
    const { user, bank, gold, sip } = await investments()
    const view = await record(user.id, bank, gold, 500_00n, { quantity: 5n * UNIT })
    const sale = await sellFrom(user.id, gold, bank, view.id, 3n * UNIT, 300_00n)
    await removeTransaction(user.id, sale.id)
    const error = await rejection(editTransaction(user.id, view.id, { toNodeId: sip.id }, view.version))
    expect(error).toBeInstanceOf(LotInUseError)
    expect(violationCodes(error)).toEqual(["LOT_SOLD"])
    expect(await findLotByTransaction(user.id, view.id)).not.toBeNull()
  })

  it("moves the lot with a purchase re-pointed at another investment valued by quantity, keeping its quantity", async () => {
    const { user, bank, gold, silver } = await investments()
    const view = await record(user.id, bank, gold, 500_00n, { quantity: 5n * UNIT })
    await editTransaction(user.id, view.id, { toNodeId: silver.id }, view.version)
    expect(await findLiveLots(user.id, gold.id)).toEqual([])
    expect(await findLiveLots(user.id, silver.id)).toMatchObject([{ quantity: 5n * UNIT, costBasisPaise: 500_00n }])
  })

  it("asks for the quantity when an edit points a purchase at a lot-mode investment it was not in", async () => {
    const { user, bank, gold, plot, sip } = await investments()
    const view = await record(user.id, bank, sip, 500_00n)
    const error = await rejection(editTransaction(user.id, view.id, { toNodeId: gold.id }, view.version))
    expect(violationCodes(error)).toEqual(["QUANTITY_REQUIRED"])
    expect((await prisma.transaction.findUniqueOrThrow({ where: { id: view.id } })).toNodeId).toBe(sip.id)
    // given it, the lot is created; a lump needs none
    const moved = await editTransaction(user.id, view.id, { toNodeId: gold.id, quantity: 2n * UNIT }, view.version)
    expect(await findLotByTransaction(user.id, view.id)).toMatchObject({ quantity: 2n * UNIT, costBasisPaise: 500_00n })
    await editTransaction(user.id, view.id, { toNodeId: plot.id }, moved.version)
    expect(await findLiveLots(user.id, plot.id)).toMatchObject([{ quantity: UNIT }])
    expect(await findLiveLots(user.id, gold.id)).toEqual([])
  })

  it("refuses a quantity on an edit whose target is not a lot-mode investment", async () => {
    const { user, bank, sip } = await investments()
    const view = await record(user.id, bank, sip, 500_00n)
    expect(violationCodes(await rejection(editTransaction(user.id, view.id, { quantity: UNIT }, view.version)))).toEqual([
      "QUANTITY_NOT_APPLICABLE",
    ])
  })

  it("refuses an edit that turns an entry into money out of a lot-mode investment", async () => {
    const { user, bank, food, gold } = await investments()
    await record(user.id, bank, gold, 500_00n, { quantity: 5n * UNIT })
    const view = await record(user.id, bank, food, 100n)
    expect(violationCodes(await rejection(editTransaction(user.id, view.id, { fromNodeId: gold.id }, view.version)))).toEqual([
      "LOT_SOURCE",
    ])
  })

  it("refuses to point a leg of a split at a lot-mode investment", async () => {
    const { user, bank, food, savings, gold } = await investments()
    const [first] = await recordSplit(user.id, {
      fromNodeId: bank.id,
      occurredAt: PAST,
      legs: [
        { toNodeId: food.id, amount: 100n },
        { toNodeId: savings.id, amount: 200n },
      ],
      idempotencyKey: randomUUID(),
    })
    const error = await rejection(editTransaction(user.id, first.id, { toNodeId: gold.id, quantity: UNIT }, first.version))
    expect(violationCodes(error)).toEqual(["LOT_SPLIT_LEG"])
    expect((error as InvalidTransactionError).message).toContain("record an investment purchase on its own")
  })
})

describe("editing a sale", () => {
  it("is refused for a leg of a disposal and for a transaction that consumed lots", async () => {
    const { user, bank, gold } = await investments()
    const buy = await record(user.id, bank, gold, 1_000_00n, { quantity: 10n * UNIT })
    const grouped = await sellFrom(user.id, gold, bank, buy.id, UNIT, 100_00n, { grouped: true })
    const plain = await sellFrom(user.id, gold, bank, buy.id, UNIT, 100_00n) // a break-even sale has no group
    for (const sale of [grouped, plain]) {
      const error = await rejection(editTransaction(user.id, sale.id, { note: "typo" }, sale.version))
      expect(error).toBeInstanceOf(InvalidTransactionError)
      expect((error as InvalidTransactionError).message).toBe("A sale is deleted and entered again, not edited.")
      expect(await prisma.transaction.findUniqueOrThrow({ where: { id: sale.id } })).toMatchObject({ note: null, version: sale.version })
    }
  })
})

describe("legacy investment entries", () => {
  // Entries made before lots existed have none (call 7): nothing is guessed, and the user supplies the quantity.
  it("creates the lot when an edit supplies the quantity of a legacy purchase", async () => {
    const { user, bank, gold } = await investments()
    const legacy = await registry.makeTransaction(user.id, bank.id, gold.id, { amountPaise: 70_000_00n, occurredAt: "2026-02-01" })
    await editTransaction(user.id, legacy.id, { quantity: 10n * UNIT }, legacy.version)
    expect(await findLotByTransaction(user.id, legacy.id)).toMatchObject({
      quantity: 10n * UNIT,
      costBasisPaise: 70_000_00n,
      acquiredAt: "2026-02-01",
    })
  })

  it("lets a legacy purchase be corrected without a quantity, leaving it without a lot", async () => {
    const { user, bank, gold, plot } = await investments()
    for (const target of [gold, plot]) {
      const legacy = await registry.makeTransaction(user.id, bank.id, target.id, { amountPaise: 1_000_00n })
      const edited = await editTransaction(user.id, legacy.id, { note: "from before lots", amount: 1_100_00n }, legacy.version)
      expect(edited.note).toBe("from before lots")
      expect(await findLotByTransaction(user.id, legacy.id)).toBeNull()
    }
  })
})

describe("deleting a purchase", () => {
  it("is refused while a sale takes from its lot, and allowed once the sale is deleted (EC-13)", async () => {
    const { user, bank, gold } = await investments()
    const buy = await record(user.id, bank, gold, 500_00n, { quantity: 5n * UNIT })
    const sale = await sellFrom(user.id, gold, bank, buy.id, 3n * UNIT, 300_00n)
    const error = await rejection(removeTransaction(user.id, buy.id))
    expect(error).toBeInstanceOf(LotInUseError)
    expect(error).toBeInstanceOf(InvalidTransactionError)
    expect((error as LotInUseError).message).toContain("Delete the sale first")
    expect((await prisma.transaction.findUniqueOrThrow({ where: { id: buy.id } })).deletedAt).toBeNull()
    expect(await findLiveLots(user.id, gold.id)).toHaveLength(1)

    await removeTransaction(user.id, sale.id)
    await removeTransaction(user.id, buy.id)
    expect(await findLiveLots(user.id, gold.id)).toEqual([])
    // and the lot comes back with the purchase
    await restoreTransaction(user.id, buy.id)
    expect(await findLiveLots(user.id, gold.id)).toMatchObject([{ quantity: 5n * UNIT, consumptions: [] }])
  })
})
