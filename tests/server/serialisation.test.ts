import { randomUUID } from "node:crypto"
import { afterAll, describe, expect, it } from "vitest"
import { calendarDate, fromDbDate, todayIn, toDbDate } from "@/domain/calendar-date"
import { toTransactionView, type TransactionView } from "@/lib/transaction-view"
import { prisma } from "@/server/db"
import { VersionConflictError } from "@/server/repositories/transaction-repository"
import {
  editTransaction,
  recordTransaction,
  removeTransaction,
  restoreTransaction,
  type RecordTransactionInput,
} from "@/server/services/transaction-service"
import { createRegistry } from "./repositories/fixtures"

// RF#1: JSON.stringify throws on a bigint, so a Paise that reached a Server Action's result or a component's props would
// crash the request at runtime. TransactionView is the boundary type; these tests walk what the service actually
// returns, on every path that returns one.

const registry = createRegistry()
afterAll(registry.cleanup)

/** Every leaf of `value`, failing at the first bigint or Date, or any object that is not plain data. */
function assertPlainData(value: unknown, path = "view"): void {
  expect(typeof value, path).not.toBe("bigint")
  expect(value instanceof Date, path).toBe(false)
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertPlainData(item, `${path}[${index}]`))
  } else if (value !== null && typeof value === "object") {
    expect(Object.getPrototypeOf(value), `${path} is a class instance`).toBe(Object.prototype)
    for (const [key, item] of Object.entries(value)) assertPlainData(item, `${path}.${key}`)
  } else {
    expect(["string", "number", "boolean", "undefined"].includes(typeof value) || value === null, `${path} is ${typeof value}`).toBe(true)
  }
}

function assertCrossesTheBoundary(view: TransactionView) {
  assertPlainData(view)
  expect(() => JSON.stringify(view)).not.toThrow()
  expect(JSON.parse(JSON.stringify(view))).toEqual(view) // nothing is lost or reshaped by the trip
  expect(typeof view.amountPaise).toBe("string")
  expect(view.occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}$/)
}

async function setup(opening = 1_000_00n) {
  const user = await registry.makeUser()
  const income = await registry.makeNode(user.id, "INCOME_SOURCE", "Salary")
  const bank = await registry.makeNode(user.id, "ASSET", "Bank")
  const card = await prisma.ledgerNode.create({
    data: { userId: user.id, kind: "LIABILITY", name: "Card", liabilitySubtype: "CREDIT_CARD", creditLimitPaise: 1_000n },
  })
  const food = await registry.makeNode(user.id, "EXPENSE", "Food")
  await registry.makeTransaction(user.id, income.id, bank.id, { amountPaise: opening, occurredAt: "2026-01-01" })
  const record = (from: { id: string }, to: { id: string }, amount: bigint, over: Partial<RecordTransactionInput> = {}) =>
    recordTransaction(user.id, {
      fromNodeId: from.id,
      toNodeId: to.id,
      amount,
      occurredAt: calendarDate("2026-04-01"),
      idempotencyKey: randomUUID(),
      ...over,
    })
  return { user, income, bank, card, food, record }
}

describe("TransactionView", () => {
  it("returns no bigint anywhere in a TransactionView", async () => {
    const { bank, food, record } = await setup()
    assertPlainData(await record(bank, food, 123_45n, { note: "n", tags: ["a", "b"] }))
  })

  it("survives JSON.stringify", async () => {
    // RF#1
    const { bank, food, record } = await setup()
    const view = await record(bank, food, 123_45n)
    expect(() => JSON.stringify(view)).not.toThrow()
    expect(JSON.parse(JSON.stringify(view)).amountPaise).toBe("12345")
  })

  it("holds an amount beyond 2^53 exactly, as a string", async () => {
    // EC-4
    const { income, bank, record } = await setup()
    const view = await record(income, bank, 9_007_199_254_740_993n)
    expect(view.amountPaise).toBe("9007199254740993")
    assertCrossesTheBoundary(view)
  })

  it("is plain data on every path that returns one, warnings included", async () => {
    const { user, bank, card, food, record } = await setup(100_00n)
    const key = randomUUID()
    const created = await record(bank, food, 150_00n, { idempotencyKey: key }) // OVERDRAWN
    expect(created.warnings.length).toBeGreaterThan(0)
    assertCrossesTheBoundary(created)

    assertCrossesTheBoundary(await record(bank, food, 150_00n, { idempotencyKey: key })) // replay

    const overLimit = await record(card, food, 5_000n) // OVER_CREDIT_LIMIT
    expect(overLimit.warnings.map((w) => w.code)).toEqual(["OVER_CREDIT_LIMIT"])
    assertCrossesTheBoundary(overLimit)

    const future = await record(bank, food, 1n, { occurredAt: fromDbDate(new Date(toDbDate(todayIn("Asia/Kolkata")).getTime() + 3 * 86_400_000)) })
    expect(future.warnings.map((w) => w.code)).toContain("FUTURE_DATED")
    assertCrossesTheBoundary(future)

    const edited = await editTransaction(user.id, created.id, { amount: 1n, note: "n" }, created.version)
    assertCrossesTheBoundary(edited)

    await removeTransaction(user.id, created.id)
    // a replay of a deleted row's key still answers with a view
    assertCrossesTheBoundary(await record(bank, food, 1n, { idempotencyKey: key }))
    assertCrossesTheBoundary(await restoreTransaction(user.id, created.id))
  })

  it("converts the row a VersionConflictError carries into plain data too", async () => {
    // The error is thrown by the repository with the Prisma row (a bigint amount, Date fields); whatever shows it to a
    // user converts it through toTransactionView, and that result must be as safe as any other view.
    const { user, bank, food, record } = await setup()
    const view = await record(bank, food, 100_00n)
    await editTransaction(user.id, view.id, { note: "tab one" }, view.version)
    const error = await editTransaction(user.id, view.id, { note: "tab two" }, view.version).then(
      () => null,
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(VersionConflictError)
    const current = toTransactionView((error as VersionConflictError).current)
    assertCrossesTheBoundary(current)
    expect(current).toMatchObject({ note: "tab one", version: 1, amountPaise: "10000" })
  })

  it("reads a day back as the day it was saved, in whatever zone the process runs", async () => {
    // RF#2: this file runs under Asia/Kolkata and America/New_York
    const { bank, food, record } = await setup()
    for (const day of ["2026-04-01", "2026-03-29", "2026-12-31", "2028-02-29"]) {
      expect((await record(bank, food, 1n, { occurredAt: calendarDate(day) })).occurredAt).toBe(day)
    }
  })
})
