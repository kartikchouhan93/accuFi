import { randomUUID } from "node:crypto"
import { afterAll, describe, expect, it, vi } from "vitest"
import { calendarDate, type CalendarDate } from "@/domain/calendar-date"
import { allocate } from "@/domain/money"
import { SPLIT_LEGS_MAX } from "@/lib/schemas/transaction"
import { prisma } from "@/server/db"
import { NotFoundError } from "@/server/repositories/errors"
import { findTransactionsByIdempotencyKeys, sumBalances } from "@/server/repositories/transaction-repository"
import { archiveLedgerNode } from "@/server/services/node-service"
import {
  InvalidTransactionError,
  OverdraftBlockedError,
  recordSplit,
  recordTransaction,
  removeTransaction,
  restoreTransaction,
  SplitTotalMismatchError,
  ungroupTransaction,
  type SplitLegInput,
} from "@/server/services/transaction-service"
import { createRegistry } from "./repositories/fixtures"

// Passes straight through to the real repository. It is wrapped only so one test can make the replay lookup come back
// empty once, which is the only deterministic way to reach the insert that a duplicate key then fails.
vi.mock("@/server/repositories/transaction-repository", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/repositories/transaction-repository")>()
  return { ...original, findTransactionsByIdempotencyKeys: vi.fn(original.findTransactionsByIdempotencyKeys) }
})

const registry = createRegistry()
afterAll(registry.cleanup)

const PAST = calendarDate("2026-03-01")

/** A user with income, a bank holding Rs 10,000.00, a second expense node, an investment and a Rs 50,000 card. */
async function setup(opening = 10_000_00n) {
  const user = await registry.makeUser()
  const income = await registry.makeNode(user.id, "INCOME_SOURCE", "Salary")
  const bank = await registry.makeNode(user.id, "ASSET", "Bank")
  const groceries = await registry.makeNode(user.id, "EXPENSE", "Groceries")
  const clothes = await registry.makeNode(user.id, "EXPENSE", "Clothes")
  const interest = await registry.makeNode(user.id, "EXPENSE", "Interest")
  const loan = await prisma.ledgerNode.create({
    data: { userId: user.id, kind: "LIABILITY", name: "Home loan", liabilitySubtype: "LOAN" },
  })
  await registry.makeTransaction(user.id, income.id, bank.id, { amountPaise: opening, occurredAt: "2026-01-01" })
  return { user, income, bank, groceries, clothes, interest, loan }
}

type Node = { id: string }
const leg = (to: Node, amount: bigint, note?: string): SplitLegInput => ({ toNodeId: to.id, amount, note })

const split = (
  userId: string,
  from: Node,
  legs: SplitLegInput[],
  over: { occurredAt?: CalendarDate; tags?: string[]; idempotencyKey?: string; total?: bigint } = {},
) => recordSplit(userId, { fromNodeId: from.id, occurredAt: PAST, legs, idempotencyKey: randomUUID(), ...over })

async function balanceOf(userId: string, node: Node): Promise<bigint> {
  const row = (await sumBalances(userId)).find((b) => b.nodeId === node.id)
  if (!row) throw new Error("no such node")
  return row.balance
}

const rowCount = (userId: string) => prisma.transaction.count({ where: { userId } })
const groupCount = (userId: string) => prisma.transactionGroup.count({ where: { userId } })
const blockNegative = (nodeId: string) => prisma.ledgerNode.update({ where: { id: nodeId }, data: { blockNegative: true } })

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected a rejection")
    },
    (error: unknown) => error,
  )
}

describe("recordSplit", () => {
  it("writes every leg with one shared groupId", async () => {
    // spec §4
    const { user, bank, groceries, clothes } = await setup()
    const key = randomUUID()
    const views = await split(user.id, bank, [leg(groceries, 2_000_00n, "veg"), leg(clothes, 1_000_00n)], {
      idempotencyKey: key,
      tags: ["trip", "trip"],
    })

    expect(views.map((v) => [v.fromNodeId, v.toNodeId, v.amountPaise, v.note, v.tags])).toEqual([
      [bank.id, groceries.id, "200000", "veg", ["trip"]],
      [bank.id, clothes.id, "100000", null, ["trip"]],
    ])
    const groupId = views[0].groupId
    expect(groupId).not.toBeNull()
    expect(views[1].groupId).toBe(groupId)
    const group = await prisma.transactionGroup.findUniqueOrThrow({ where: { id: groupId ?? "" } })
    expect(group).toMatchObject({ userId: user.id, kind: "MANUAL_SPLIT" })
    expect(await prisma.transaction.count({ where: { groupId } })).toBe(2)
    expect(await balanceOf(user.id, bank)).toBe(7_000_00n)
    expect(await balanceOf(user.id, groceries)).toBe(2_000_00n)
    expect(await balanceOf(user.id, clothes)).toBe(1_000_00n)
    // R7: each leg stores its own key, derived from the one the client sent
    const keys = (await prisma.transaction.findMany({ where: { groupId }, orderBy: { idempotencyKey: "asc" } })).map((r) => r.idempotencyKey)
    expect(keys).toEqual([`${key}:0`, `${key}:1`])
  })

  it("returns plain data: no bigint and no Date on any view", async () => {
    const { user, bank, groceries, clothes } = await setup()
    const views = await split(user.id, bank, [leg(groceries, 5n), leg(clothes, 7n)])
    expect(() => JSON.stringify(views)).not.toThrow()
    expect(JSON.parse(JSON.stringify(views))).toEqual(views)
  })

  it("writes all legs or none", async () => {
    // EC-57 pattern. The last leg is illegal; the earlier ones are legal and must not survive it.
    const { user, bank, income, groceries, clothes } = await setup()
    const rows = await rowCount(user.id)
    const groups = await groupCount(user.id)
    const error = await rejection(split(user.id, bank, [leg(groceries, 100n), leg(clothes, 200n), leg(income, 300n)]))
    expect(error).toBeInstanceOf(InvalidTransactionError)
    expect((error as InvalidTransactionError).message).toBe("Leg 3: Money cannot flow from ASSET to INCOME_SOURCE.")
    expect(await rowCount(user.id)).toBe(rows)
    expect(await groupCount(user.id)).toBe(groups)
  })

  it("rolls back legs already written when the guard refuses the group as a whole", async () => {
    // Every leg is legal and every leg is written; only the check afterwards, over the sum, fails. This is the path
    // where rows really are inserted and then undone, so it is the proof that the group is one database transaction.
    const { user, bank, groceries, clothes } = await setup(1_000_00n)
    await blockNegative(bank.id)
    const rows = await rowCount(user.id)
    const groups = await groupCount(user.id)
    const error = await rejection(split(user.id, bank, [leg(groceries, 600_00n), leg(clothes, 600_00n)]))
    expect(error).toBeInstanceOf(OverdraftBlockedError)
    expect(await rowCount(user.id)).toBe(rows)
    expect(await groupCount(user.id)).toBe(groups)
    expect(await balanceOf(user.id, bank)).toBe(1_000_00n)
  })

  it("judges blockNegative on the sum of the legs, not on each leg alone", async () => {
    const { user, bank, groceries, clothes } = await setup(1_000_00n)
    await blockNegative(bank.id)
    // each leg alone fits in the balance; together they do not
    expect(await rejection(split(user.id, bank, [leg(groceries, 700_00n), leg(clothes, 700_00n)]))).toBeInstanceOf(OverdraftBlockedError)
    // exactly emptying the account is not overdrawing it
    const views = await split(user.id, bank, [leg(groceries, 400_00n), leg(clothes, 600_00n)])
    expect(views).toHaveLength(2)
    expect(await balanceOf(user.id, bank)).toBe(0n)
  })

  it("warns about the source on every leg when the group overdraws it", async () => {
    const { user, bank, groceries, clothes } = await setup(1_000_00n)
    const views = await split(user.id, bank, [leg(groceries, 800_00n), leg(clothes, 800_00n)])
    // judged once, against the balance after the whole group: -600.00, not 200.00 after the first leg
    expect(views.map((v) => v.warnings.map((w) => w.code))).toEqual([["OVERDRAWN"], ["OVERDRAWN"]])
    expect(views[0].warnings).toEqual(views[1].warnings)
    expect(views[0].warnings[0].message).toBe("Bank is overdrawn: its balance is -₹600.00.")
  })

  it("carries the FUTURE_DATED warning on every leg", async () => {
    const { user, bank, groceries, clothes } = await setup()
    const views = await split(user.id, bank, [leg(groceries, 10n), leg(clothes, 10n)], { occurredAt: calendarDate("2099-01-01") })
    expect(views.map((v) => v.warnings.map((w) => w.code))).toEqual([["FUTURE_DATED"], ["FUTURE_DATED"]])
  })

  it("rejects legs that do not sum to a stated total", async () => {
    // EC-3
    const { user, bank, groceries, clothes } = await setup()
    const rows = await rowCount(user.id)
    const error = await rejection(split(user.id, bank, [leg(groceries, 2_000_00n), leg(clothes, 999_99n)], { total: 3_000_00n }))
    expect(error).toBeInstanceOf(SplitTotalMismatchError)
    expect((error as Error).message).toBe("The legs add up to ₹2,999.99 but the total is ₹3,000.00.")
    expect(await rowCount(user.id)).toBe(rows)
    expect(await groupCount(user.id)).toBe(0)
  })

  it("accepts legs that sum to the stated total", async () => {
    const { user, bank, groceries, clothes } = await setup()
    const views = await split(user.id, bank, [leg(groceries, 2_000_00n), leg(clothes, 1_000_00n)], { total: 3_000_00n })
    expect(views).toHaveLength(2)
  })

  it("splits 100.00 three ways so the legs sum exactly", async () => {
    // EC-5, via allocate()
    const amounts = allocate(100_00n, [1n, 1n, 1n])
    expect(amounts).toEqual([3334n, 3333n, 3333n])

    const { user, bank, groceries, clothes, interest } = await setup()
    const views = await split(user.id, bank, [leg(groceries, amounts[0]), leg(clothes, amounts[1]), leg(interest, amounts[2])], {
      total: 100_00n,
    })
    expect(views.map((v) => v.amountPaise)).toEqual(["3334", "3333", "3333"])
    expect(await balanceOf(user.id, bank)).toBe(9_900_00n)
  })

  it("validates each leg against the flow matrix independently", async () => {
    // EC-7: the first and last legs are legal, the middle one is not, and so is a fourth that moves money to its own source
    const { user, bank, income, groceries, clothes } = await setup()
    const error = await rejection(split(user.id, bank, [leg(groceries, 100n), leg(income, 200n), leg(clothes, 300n), leg(bank, 400n)]))
    expect(error).toBeInstanceOf(InvalidTransactionError)
    const violations = (error as InvalidTransactionError).violations
    expect(violations.map((v) => [v.code, v.message])).toEqual([
      ["ILLEGAL_FLOW", "Leg 2: Money cannot flow from ASSET to INCOME_SOURCE."],
      ["SAME_NODE", "Leg 4: A transaction cannot move money from a node to itself."],
    ])
    expect((error as InvalidTransactionError).message).toBe(violations.map((v) => v.message).join(" "))
    expect(await rowCount(user.id)).toBe(1) // the opening deposit
  })

  it("rejects a zero leg", async () => {
    const { user, bank, groceries, clothes } = await setup()
    const error = await rejection(split(user.id, bank, [leg(groceries, 100n), leg(clothes, 0n)]))
    expect((error as InvalidTransactionError).violations.map((v) => v.code)).toEqual(["NON_POSITIVE_AMOUNT"])
  })

  it("refuses an archived destination, as a new entry would (EC-14)", async () => {
    const { user, bank, groceries, clothes } = await setup()
    await archiveLedgerNode(user.id, clothes.id)
    const error = await rejection(split(user.id, bank, [leg(groceries, 100n), leg(clothes, 200n)]))
    expect((error as InvalidTransactionError).violations.map((v) => v.code)).toEqual(["ARCHIVED_NODE"])
    expect(await groupCount(user.id)).toBe(0)
  })

  it("needs at least two legs and a request key", async () => {
    const { user, bank, groceries } = await setup()
    expect(await rejection(split(user.id, bank, [leg(groceries, 100n)]))).toBeInstanceOf(InvalidTransactionError)
    expect(await rejection(split(user.id, bank, []))).toBeInstanceOf(InvalidTransactionError)
    expect(await rejection(split(user.id, bank, [leg(groceries, 1n), leg(groceries, 2n)], { idempotencyKey: "" }))).toBeInstanceOf(
      InvalidTransactionError,
    )
    expect(await rowCount(user.id)).toBe(1)
  })

  it("answers not-found, and leaves no group behind, when a leg names another user's node", async () => {
    // EC-8
    const a = await setup()
    const b = await setup()
    const error = await rejection(split(a.user.id, a.bank, [leg(a.groceries, 100n), leg(b.groceries, 200n)]))
    expect(error).toBeInstanceOf(NotFoundError)
    expect(await groupCount(a.user.id)).toBe(0)
    expect(await rowCount(a.user.id)).toBe(1)
  })

  it("returns the first result for a replayed key, writing nothing new", async () => {
    // EC-17, R7
    const { user, bank, groceries, clothes } = await setup()
    const key = randomUUID()
    const legs = [leg(groceries, 100n), leg(clothes, 200n)]
    const first = await split(user.id, bank, legs, { idempotencyKey: key })
    const rows = await rowCount(user.id)
    const second = await split(user.id, bank, legs, { idempotencyKey: key })
    expect(second.map((v) => v.id)).toEqual(first.map((v) => v.id))
    expect(second.map((v) => v.groupId)).toEqual(first.map((v) => v.groupId))
    expect(await rowCount(user.id)).toBe(rows)
    expect(await groupCount(user.id)).toBe(1)
  })

  it("returns the first result for a replay even if a node was archived since", async () => {
    const { user, bank, groceries, clothes } = await setup()
    const key = randomUUID()
    const legs = [leg(groceries, 100n), leg(clothes, 200n)]
    const first = await split(user.id, bank, legs, { idempotencyKey: key })
    await archiveLedgerNode(user.id, clothes.id)
    const second = await split(user.id, bank, legs, { idempotencyKey: key })
    expect(second.map((v) => v.id)).toEqual(first.map((v) => v.id))
  })

  it("settles concurrent submissions of one key into one group", async () => {
    // Timing decides how many of these reach the insert, so this proves the outcome only; the rollback of a failing
    // insert is proved deterministically below.
    const { user, bank, groceries, clothes } = await setup()
    const key = randomUUID()
    const legs = [leg(groceries, 100n), leg(clothes, 200n)]
    const results = await Promise.all([1, 2, 3].map(() => split(user.id, bank, legs, { idempotencyKey: key })))
    expect(new Set(results.flatMap((views) => views.map((v) => v.id))).size).toBe(2)
    expect(await groupCount(user.id)).toBe(1)
    expect(await rowCount(user.id)).toBe(3) // opening deposit + two legs
  })

  it("does not mistake an unrelated transaction that holds a leg's key for a replay", async () => {
    // A single transaction already stored under "<K>:1". The split under base key K is a new request, not a replay of
    // that row: it must fail loudly, not return one view as success while recording nothing.
    const { user, bank, groceries, clothes } = await setup()
    const key = randomUUID()
    const unrelated = await recordTransaction(user.id, {
      fromNodeId: bank.id,
      toNodeId: groceries.id,
      amount: 50n,
      occurredAt: PAST,
      idempotencyKey: `${key}:1`,
    })
    const rows = await rowCount(user.id)
    const error = await rejection(split(user.id, bank, [leg(groceries, 100n), leg(clothes, 200n)], { idempotencyKey: key }))
    expect(error).toBeInstanceOf(InvalidTransactionError)
    expect((error as Error).message).toBe("This request key was already used for a different request.")
    expect(await rowCount(user.id)).toBe(rows)
    expect(await groupCount(user.id)).toBe(0)
    expect((await prisma.transaction.findUniqueOrThrow({ where: { id: unrelated.id } })).version).toBe(unrelated.version)
  })

  it("does not treat a replay with a different number of legs as a replay of the original", async () => {
    const { user, bank, groceries, clothes, interest } = await setup()
    const key = randomUUID()
    const three = [leg(groceries, 100n), leg(clothes, 200n), leg(interest, 300n)]
    await split(user.id, bank, three, { idempotencyKey: key })
    const rows = await rowCount(user.id)
    // fewer legs: its keys all exist, but the original had more
    expect(await rejection(split(user.id, bank, three.slice(0, 2), { idempotencyKey: key }))).toBeInstanceOf(InvalidTransactionError)
    // more legs: the extra key does not exist
    expect(await rejection(split(user.id, bank, [...three, leg(groceries, 1n)], { idempotencyKey: key }))).toBeInstanceOf(
      InvalidTransactionError,
    )
    expect(await rowCount(user.id)).toBe(rows)
    expect(await groupCount(user.id)).toBe(1)
  })

  it("rolls back the group row and the legs already written when a later leg's key is taken", async () => {
    // Deterministic: the replay lookup is made to miss once while a row genuinely holds "<K>:1", so the group row and
    // leg 0 are written and then leg 1's insert hits the unique key. Everything written before it must go.
    const { user, bank, groceries, clothes } = await setup()
    const key = randomUUID()
    await recordTransaction(user.id, {
      fromNodeId: bank.id,
      toNodeId: groceries.id,
      amount: 50n,
      occurredAt: PAST,
      idempotencyKey: `${key}:1`,
    })
    const rows = await rowCount(user.id)
    const lookups = vi.mocked(findTransactionsByIdempotencyKeys)
    lookups.mockClear()
    lookups.mockImplementationOnce(() => Promise.resolve([]))

    const error = await rejection(split(user.id, bank, [leg(groceries, 100n), leg(clothes, 200n)], { idempotencyKey: key }))

    expect(lookups).toHaveBeenCalledTimes(2) // the shortcut that missed, then the lookup after the insert failed
    expect(error).toBeInstanceOf(InvalidTransactionError)
    expect(await groupCount(user.id)).toBe(0)
    expect(await rowCount(user.id)).toBe(rows)
    expect(await prisma.transaction.count({ where: { userId: user.id, idempotencyKey: `${key}:0` } })).toBe(0)
    expect(await balanceOf(user.id, bank)).toBe(10_000_00n - 50n)
  })

  it("refuses more legs than the cap, whatever called it", async () => {
    const { user, bank, groceries } = await setup()
    const legs = Array.from({ length: SPLIT_LEGS_MAX + 1 }, () => leg(groceries, 1n))
    expect(await rejection(split(user.id, bank, legs))).toBeInstanceOf(InvalidTransactionError)
    expect(await split(user.id, bank, legs.slice(0, SPLIT_LEGS_MAX))).toHaveLength(SPLIT_LEGS_MAX)
    expect(await groupCount(user.id)).toBe(1)
  })

  it("records an EMI as principal to the loan and interest to an expense", async () => {
    // spec §4.1. The loan is owed, so its balance is negative; paying principal moves it toward zero.
    const { user, bank, loan, interest } = await setup(50_000_00n)
    await recordTransaction(user.id, {
      fromNodeId: loan.id,
      toNodeId: bank.id,
      amount: 1_00_000_00n,
      occurredAt: PAST,
      idempotencyKey: randomUUID(),
    })
    expect(await balanceOf(user.id, loan)).toBe(-1_00_000_00n)

    const views = await split(user.id, bank, [leg(loan, 8_000_00n, "principal"), leg(interest, 2_000_00n, "interest")], {
      total: 10_000_00n,
    })
    expect(views.map((v) => v.toNodeId)).toEqual([loan.id, interest.id])
    expect(await balanceOf(user.id, loan)).toBe(-92_000_00n)
    expect(await balanceOf(user.id, interest)).toBe(2_000_00n)
    expect(await balanceOf(user.id, bank)).toBe(1_40_000_00n)
  })
})

describe("ungroupTransaction", () => {
  it("collapses a two-leg group to a plain transaction when one leg is removed", async () => {
    // EC-19
    const { user, bank, groceries, clothes } = await setup()
    const [first, second] = await split(user.id, bank, [leg(groceries, 100n), leg(clothes, 200n)])
    const view = await ungroupTransaction(user.id, first.id)

    expect(view).toMatchObject({ id: first.id, groupId: null, version: first.version + 1, warnings: [] })
    const survivor = await prisma.transaction.findUniqueOrThrow({ where: { id: second.id } })
    expect(survivor.groupId).toBeNull() // a group of one is not a group
    expect(survivor.version).toBe(second.version + 1)
    expect(await groupCount(user.id)).toBe(0) // and the empty group row is gone
    // the money is untouched
    expect(await balanceOf(user.id, groceries)).toBe(100n)
    expect(await balanceOf(user.id, clothes)).toBe(200n)
  })

  it("leaves a group of two or more intact when one of three legs is removed", async () => {
    const { user, bank, groceries, clothes, interest } = await setup()
    const [first, second, third] = await split(user.id, bank, [leg(groceries, 1n), leg(clothes, 2n), leg(interest, 3n)])
    await ungroupTransaction(user.id, second.id)
    expect((await prisma.transaction.findUniqueOrThrow({ where: { id: second.id } })).groupId).toBeNull()
    expect((await prisma.transaction.findUniqueOrThrow({ where: { id: first.id } })).groupId).toBe(first.groupId)
    expect((await prisma.transaction.findUniqueOrThrow({ where: { id: third.id } })).groupId).toBe(first.groupId)
    expect(await groupCount(user.id)).toBe(1)
  })

  it("does nothing to a transaction that is not in a group", async () => {
    const { user, bank, groceries } = await setup()
    const plain = await recordTransaction(user.id, {
      fromNodeId: bank.id,
      toNodeId: groceries.id,
      amount: 100n,
      occurredAt: PAST,
      idempotencyKey: randomUUID(),
    })
    expect(await ungroupTransaction(user.id, plain.id)).toMatchObject({ id: plain.id, groupId: null, version: plain.version })
  })

  it("refuses to break a leg out of a disposal group, which is edited as a unit (EC-19)", async () => {
    const { user, bank, groceries, clothes } = await setup()
    const [first, second] = await split(user.id, bank, [leg(groceries, 100n), leg(clothes, 200n)])
    await prisma.transactionGroup.update({ where: { id: first.groupId ?? "" }, data: { kind: "DISPOSAL" } })
    const error = await rejection(ungroupTransaction(user.id, first.id))
    expect(error).toBeInstanceOf(InvalidTransactionError)
    expect((error as Error).message).toBe("A disposal is edited as a unit, so one leg cannot be taken out of it.")
    const rows = await prisma.transaction.findMany({ where: { id: { in: [first.id, second.id] } }, orderBy: { idempotencyKey: "asc" } })
    expect(rows.map((r) => [r.groupId, r.version])).toEqual([
      [first.groupId, first.version],
      [first.groupId, second.version],
    ])
    expect(await groupCount(user.id)).toBe(1)
  })

  it("answers not-found for an unknown, deleted or other user's transaction", async () => {
    const a = await setup()
    const b = await setup()
    const [bFirst] = await split(b.user.id, b.bank, [leg(b.groceries, 1n), leg(b.clothes, 2n)])
    expect(await rejection(ungroupTransaction(a.user.id, bFirst.id))).toBeInstanceOf(NotFoundError)
    expect(await rejection(ungroupTransaction(a.user.id, "no-such-id"))).toBeInstanceOf(NotFoundError)
    expect((await prisma.transaction.findUniqueOrThrow({ where: { id: bFirst.id } })).groupId).toBe(bFirst.groupId)

    const [aFirst] = await split(a.user.id, a.bank, [leg(a.groceries, 1n), leg(a.clothes, 2n)])
    await removeTransaction(a.user.id, aFirst.id)
    expect(await rejection(ungroupTransaction(a.user.id, aFirst.id))).toBeInstanceOf(NotFoundError)
  })
})

describe("deleting and restoring a group member", () => {
  it("deletes the whole group when a group member is deleted", async () => {
    // EC-13
    const { user, bank, groceries, clothes, interest } = await setup()
    const [first, second, third] = await split(user.id, bank, [leg(groceries, 1_000n), leg(clothes, 2_000n), leg(interest, 3_000n)])
    await removeTransaction(user.id, second.id)

    const rows = await prisma.transaction.findMany({ where: { id: { in: [first.id, second.id, third.id] } } })
    expect(rows.map((r) => r.deletedAt !== null)).toEqual([true, true, true])
    expect(rows.every((r) => r.groupId === first.groupId)).toBe(true) // still one group, so a restore can find it
    expect(await balanceOf(user.id, bank)).toBe(10_000_00n)
    expect(await balanceOf(user.id, groceries)).toBe(0n)
    // a second delete of any member finds nothing to delete
    expect(await rejection(removeTransaction(user.id, first.id))).toBeInstanceOf(NotFoundError)
  })

  it("leaves other groups and plain transactions alone", async () => {
    const { user, bank, groceries, clothes } = await setup()
    const [a1] = await split(user.id, bank, [leg(groceries, 1n), leg(clothes, 2n)])
    const [b1, b2] = await split(user.id, bank, [leg(groceries, 3n), leg(clothes, 4n)])
    await removeTransaction(user.id, a1.id)
    const others = await prisma.transaction.findMany({ where: { id: { in: [b1.id, b2.id] } } })
    expect(others.every((r) => r.deletedAt === null)).toBe(true)
  })

  it("restores the whole group when one member is restored", async () => {
    const { user, bank, groceries, clothes } = await setup()
    const [first, second] = await split(user.id, bank, [leg(groceries, 1_000n), leg(clothes, 2_000n)])
    await removeTransaction(user.id, first.id)
    const view = await restoreTransaction(user.id, second.id)
    expect(view.id).toBe(second.id)
    const rows = await prisma.transaction.findMany({ where: { groupId: first.groupId } })
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.deletedAt === null)).toBe(true)
    expect(await balanceOf(user.id, bank)).toBe(10_000_00n - 3_000n)
  })

  it("refuses to restore a group that would overdraw a guarded source, restoring none of it", async () => {
    const { user, bank, groceries, clothes } = await setup(1_000_00n)
    const [first] = await split(user.id, bank, [leg(groceries, 600_00n), leg(clothes, 300_00n)])
    await removeTransaction(user.id, first.id)
    await blockNegative(bank.id)
    // spend the money while the group is deleted
    await recordTransaction(user.id, {
      fromNodeId: bank.id,
      toNodeId: groceries.id,
      amount: 900_00n,
      occurredAt: PAST,
      idempotencyKey: randomUUID(),
    })
    expect(await rejection(restoreTransaction(user.id, first.id))).toBeInstanceOf(OverdraftBlockedError)
    const rows = await prisma.transaction.findMany({ where: { groupId: first.groupId } })
    expect(rows.every((r) => r.deletedAt !== null)).toBe(true)
  })
})
