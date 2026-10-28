import { readdirSync } from "node:fs"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Prisma } from "@prisma/client"
import { calendarDate, toDbDate } from "@/domain/calendar-date"
import { prisma } from "@/server/db"
import { NotFoundError, UserNotFoundError } from "@/server/repositories/errors"
import * as lotRepo from "@/server/repositories/lot-repository"
import * as nodeRepo from "@/server/repositories/node-repository"
import * as priceRepo from "@/server/repositories/price-repository"
import * as recurringRepo from "@/server/repositories/recurring-repository"
import * as txRepo from "@/server/repositories/transaction-repository"
import * as reportRepo from "@/server/repositories/report-repository"
import { findFinancialYearStartMonth, findStalePriceDays, findUserTimezone } from "@/server/repositories/user-repository"
import { inTransaction } from "@/server/repositories/unit-of-work"
import { flowScenario, holdingsScenario } from "../reports/scenarios"
import { createRegistry } from "./fixtures"

// The highest-severity property of the application: one user must never see or change another's finances. The
// repositories enforce it, so it is tested here, per exported function, from the attacker's side: user A calls the
// function with user B's row id. Reads must come back empty, writes must fail as not-found (never "forbidden",
// which would confirm the row exists) and B's rows must be byte-for-byte unchanged afterwards.

const registry = createRegistry()
afterAll(registry.cleanup)

type World = Awaited<ReturnType<typeof registry.makeWorld>>
let a: World
let b: World

beforeAll(async () => {
  a = await registry.makeWorld()
  b = await registry.makeWorld()
})

// Each isolation test is registered under the exported function it covers, so the closing test can check that every
// export has at least one, rather than trusting a hand-kept list.
const covered = new Map<string, string[]>()
function isolation(method: string, title: string, body: () => Promise<void>) {
  covered.set(method, [...(covered.get(method) ?? []), title])
  it(`${method} ${title}`, body)
}

const day = calendarDate("2026-04-01")

const draftTo = (from: string, to: string): txRepo.InsertDraft => ({
  fromNodeId: from,
  toNodeId: to,
  amountPaise: 100n,
  occurredAt: day,
})

async function expectNotFound(promise: Promise<unknown>) {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  )
  expect(error, "expected NotFoundError").toBeInstanceOf(NotFoundError)
}

const snapshotNodes = (userId: string) => prisma.ledgerNode.findMany({ where: { userId }, orderBy: { id: "asc" } })
const snapshotTransactions = (userId: string) =>
  prisma.transaction.findMany({ where: { userId }, orderBy: { id: "asc" } })

describe("node repository", () => {
  isolation("findNodes", "never includes another user's nodes", async () => {
    const mine = await nodeRepo.findNodes(a.user.id, { includeArchived: true })
    expect(mine.length).toBeGreaterThan(0)
    expect(mine.every((n) => n.userId === a.user.id)).toBe(true)
    const bIds = new Set((await snapshotNodes(b.user.id)).map((n) => n.id))
    expect(mine.some((n) => bIds.has(n.id))).toBe(false)
    // and a kind filter does not widen the scope
    const banks = await nodeRepo.findNodes(a.user.id, { kinds: ["ASSET"] })
    expect(banks.map((n) => n.id)).toEqual([a.bank.id])
  })

  isolation("findNodeById", "returns null for another user's node", async () => {
    expect(await nodeRepo.findNodeById(a.user.id, b.bank.id)).toBeNull()
    expect(await inTransaction((uow) => nodeRepo.findNodeById(a.user.id, b.bank.id, uow))).toBeNull()
    expect(await nodeRepo.findNodeById(a.user.id, a.bank.id)).not.toBeNull()
  })

  isolation("createNode", "cannot be pointed at another user's node as its parent", async () => {
    const before = await snapshotNodes(a.user.id)
    await expectNotFound(nodeRepo.createNode(a.user.id, { kind: "ASSET", name: "Sub", parentId: b.bank.id }))
    expect(await snapshotNodes(a.user.id)).toEqual(before)
  })

  isolation("createNode", "creates the node for the caller even if the data names another user or a system role", async () => {
    const forged = { kind: "ASSET", name: "Forged", userId: b.user.id, systemRole: "OPENING_BALANCE" } as nodeRepo.CreateNodeData
    const node = await nodeRepo.createNode(a.user.id, forged)
    expect(node.userId).toBe(a.user.id)
    expect(node.systemRole).toBeNull()
    expect(await prisma.ledgerNode.count({ where: { userId: b.user.id, name: "Forged" } })).toBe(0)
  })

  isolation("updateNode", "does not modify another user's node", async () => {
    const before = await snapshotNodes(b.user.id)
    await expectNotFound(nodeRepo.updateNode(a.user.id, b.bank.id, { name: "pwned", archivedAt: new Date() }))
    expect(await snapshotNodes(b.user.id)).toEqual(before)
  })

  isolation("updateNode", "cannot re-parent the caller's node under another user's node", async () => {
    const before = await snapshotNodes(a.user.id)
    await expectNotFound(nodeRepo.updateNode(a.user.id, a.bank.id, { parentId: b.bank.id }))
    expect(await snapshotNodes(a.user.id)).toEqual(before)
  })

  isolation("deleteNode", "does not delete another user's node", async () => {
    const spare = await registry.makeNode(b.user.id, "EXPENSE", "Spare")
    await expectNotFound(nodeRepo.deleteNode(a.user.id, spare.id))
    await expectNotFound(inTransaction((uow) => nodeRepo.deleteNode(a.user.id, spare.id, uow)))
    expect(await prisma.ledgerNode.findUnique({ where: { id: spare.id } })).not.toBeNull()
  })

  isolation("countTransactionsForNode", "counts nothing for another user's node", async () => {
    expect(await nodeRepo.countTransactionsForNode(b.user.id, b.bank.id)).toBe(1)
    expect(await nodeRepo.countTransactionsForNode(a.user.id, b.bank.id)).toBe(0)
  })

  isolation("assertNodesOwned", "rejects another user's node, alone or among the caller's own", async () => {
    await expectNotFound(nodeRepo.assertNodesOwned(a.user.id, [b.bank.id]))
    await expectNotFound(nodeRepo.assertNodesOwned(a.user.id, [a.bank.id, b.bank.id]))
    await expect(nodeRepo.assertNodesOwned(a.user.id, [a.bank.id, a.food.id, a.bank.id])).resolves.toBeUndefined()
  })
})

describe("transaction repository", () => {
  isolation("findTransactions", "never includes another user's rows", async () => {
    const mine = await txRepo.findTransactions(a.user.id, {})
    expect(mine.items.map((t) => t.id)).toEqual([a.tx.id])
    // Naming B's nodes, B's dates or B's tags in the filter finds nothing of B's.
    const viaNodes = await txRepo.findTransactions(a.user.id, { nodeIds: [b.bank.id, b.food.id] })
    expect(viaNodes.items).toEqual([])
    const viaSearch = await txRepo.findTransactions(a.user.id, { search: "lunch", from: day, to: day })
    expect(viaSearch.items.every((t) => t.userId === a.user.id)).toBe(true)
  })

  isolation("findTransactions", "does not let a cursor from another user's listing leak rows", async () => {
    // B's rows, paged one at a time; the cursor B gets means nothing about A's data.
    await registry.makeTransaction(b.user.id, b.bank.id, b.food.id, { occurredAt: "2026-03-01" })
    const pageOfB = await txRepo.findTransactions(b.user.id, {}, undefined, 1)
    expect(pageOfB.nextCursor).not.toBeNull()
    const asA = await txRepo.findTransactions(a.user.id, {}, pageOfB.nextCursor ?? undefined, 10)
    expect(asA.items.every((t) => t.userId === a.user.id)).toBe(true)
  })

  isolation("sumNetIntoNodes", "never counts another user's rows, however their node ids are named", async () => {
    expect(await txRepo.sumNetIntoNodes(a.user.id, { nodeIds: [b.food.id] })).toBe(0n)
    expect(await txRepo.sumNetIntoNodes(a.user.id, { nodeIds: [b.bank.id, b.food.id] })).toBe(0n)
    // Mixed with A's own node, only A's row is in the figure: A's bank -> food of 500 is what came into food.
    expect(await txRepo.sumNetIntoNodes(a.user.id, { nodeIds: [a.food.id, b.food.id] })).toBe(500n)
  })

  isolation("findTransactions", "returns none of another user's rows for a multi-id node filter containing a foreign id", async () => {
    const mixed = await txRepo.findTransactions(a.user.id, { nodeIds: [a.food.id, b.food.id, b.bank.id] })
    expect(mixed.items.map((t) => t.id)).toEqual([a.tx.id])
  })

  isolation("findGroupMembers", "never returns another user's group, however it is named", async () => {
    // Worlds of their own: the legs written here must not change what the shared `a` and `b` show the tests below.
    const mine = await registry.makeWorld()
    const theirs = await registry.makeWorld()
    const [mineRow] = await txRepo.insertTransactions(mine.user.id, [draftTo(mine.bank.id, mine.food.id)], mine.group.id)
    const [theirRow] = await txRepo.insertTransactions(theirs.user.id, [draftTo(theirs.bank.id, theirs.food.id)], theirs.group.id)
    expect((await txRepo.findGroupMembers(mine.user.id, [mine.group.id, theirs.group.id])).map((row) => row.id)).toEqual([mineRow.id])
    expect(await txRepo.findGroupMembers(mine.user.id, [theirs.group.id])).toEqual([])
    expect((await txRepo.findGroupMembers(theirs.user.id, [theirs.group.id])).map((row) => row.id)).toEqual([theirRow.id])
  })

  isolation("findTransactionById", "returns null for another user's transaction", async () => {
    expect(await txRepo.findTransactionById(a.user.id, b.tx.id)).toBeNull()
    expect(await txRepo.findTransactionById(a.user.id, a.tx.id)).not.toBeNull()
  })

  isolation("insertTransactions", "refuses a transaction that points at another user's node", async () => {
    const aBefore = await snapshotTransactions(a.user.id)
    const bBefore = await snapshotTransactions(b.user.id)
    // The attack the schema cannot stop: a row owned by A, but whose from or to node is B's.
    await expectNotFound(txRepo.insertTransactions(a.user.id, [draftTo(a.bank.id, b.food.id)]))
    await expectNotFound(txRepo.insertTransactions(a.user.id, [draftTo(b.bank.id, a.food.id)]))
    await expectNotFound(txRepo.insertTransactions(a.user.id, [draftTo(b.bank.id, b.food.id)]))
    // One bad draft rejects the whole batch: the good one is not left behind.
    await expectNotFound(
      txRepo.insertTransactions(a.user.id, [draftTo(a.bank.id, a.food.id), draftTo(a.bank.id, b.food.id)]),
    )
    expect(await snapshotTransactions(a.user.id)).toEqual(aBefore)
    expect(await snapshotTransactions(b.user.id)).toEqual(bBefore)
  })

  isolation("insertTransactions", "refuses to attach rows to another user's group", async () => {
    const before = await snapshotTransactions(a.user.id)
    await expectNotFound(txRepo.insertTransactions(a.user.id, [draftTo(a.bank.id, a.food.id)], b.group.id))
    expect(await snapshotTransactions(a.user.id)).toEqual(before)
  })

  isolation("insertTransactions", "writes the caller's userId on every row", async () => {
    const [row] = await txRepo.insertTransactions(a.user.id, [draftTo(a.bank.id, a.food.id)], a.group.id)
    expect(row.userId).toBe(a.user.id)
    await prisma.transaction.delete({ where: { id: row.id } })
  })

  isolation("updateTransaction", "does not modify another user's transaction, and reports not-found rather than a version conflict", async () => {
    const before = await snapshotTransactions(b.user.id)
    // The current version is passed correctly, so a conflict (which would carry B's row) is the failure to avoid.
    await expectNotFound(txRepo.updateTransaction(a.user.id, b.tx.id, { amountPaise: 1n, note: "pwned" }, b.tx.version))
    await expectNotFound(txRepo.updateTransaction(a.user.id, b.tx.id, { amountPaise: 1n }, b.tx.version + 7))
    expect(await snapshotTransactions(b.user.id)).toEqual(before)
  })

  isolation("updateTransaction", "cannot re-point the caller's transaction at another user's node", async () => {
    const before = await snapshotTransactions(a.user.id)
    await expectNotFound(txRepo.updateTransaction(a.user.id, a.tx.id, { toNodeId: b.food.id }, a.tx.version))
    await expectNotFound(txRepo.updateTransaction(a.user.id, a.tx.id, { fromNodeId: b.bank.id }, a.tx.version))
    expect(await snapshotTransactions(a.user.id)).toEqual(before)
  })

  isolation("softDeleteTransaction", "does not delete another user's transaction", async () => {
    const before = await snapshotTransactions(b.user.id)
    await expectNotFound(txRepo.softDeleteTransaction(a.user.id, b.tx.id))
    expect(await snapshotTransactions(b.user.id)).toEqual(before)
    expect((await prisma.transaction.findUniqueOrThrow({ where: { id: b.tx.id } })).deletedAt).toBeNull()
  })

  isolation("undeleteTransaction", "does not restore another user's deleted transaction", async () => {
    const deleted = await registry.makeTransaction(b.user.id, b.bank.id, b.food.id, { deletedAt: new Date() })
    const before = await snapshotTransactions(b.user.id)
    await expectNotFound(txRepo.undeleteTransaction(a.user.id, deleted.id))
    expect(await snapshotTransactions(b.user.id)).toEqual(before)
    expect((await prisma.transaction.findUniqueOrThrow({ where: { id: deleted.id } })).deletedAt).not.toBeNull()
  })

  /** A group of B's with two rows in it, for an attacker to aim at. `deleted` makes the rows soft-deleted. */
  async function bGroupWithRows(deleted: boolean) {
    const group = await prisma.transactionGroup.create({ data: { userId: b.user.id, kind: "MANUAL_SPLIT" } })
    const rows = [
      await registry.makeTransaction(b.user.id, b.bank.id, b.food.id, { deletedAt: deleted ? new Date() : undefined }),
      await registry.makeTransaction(b.user.id, b.bank.id, b.food.id, { deletedAt: deleted ? new Date() : undefined }),
    ]
    await prisma.transaction.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { groupId: group.id } })
    const cleanup = async () => {
      await prisma.transaction.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } })
      await prisma.transactionGroup.deleteMany({ where: { id: group.id } })
    }
    return { group, rows, cleanup }
  }
  const snapshotGroups = (userId: string) => prisma.transactionGroup.findMany({ where: { userId }, orderBy: { id: "asc" } })

  isolation("findRestorable", "returns nothing of another user's deleted transaction or group", async () => {
    const theirs = await bGroupWithRows(true)
    try {
      expect(await inTransaction((uow) => txRepo.findRestorable(a.user.id, theirs.rows[0].id, uow))).toEqual([])
      const own = await inTransaction((uow) => txRepo.findRestorable(b.user.id, theirs.rows[0].id, uow))
      expect(own.map((row) => row.id).sort()).toEqual(theirs.rows.map((row) => row.id).sort())
    } finally {
      await theirs.cleanup()
    }
  })

  isolation("findTransactionsByIdempotencyKeys", "never returns another user's rows, even for their exact key", async () => {
    const theirs = await prisma.transaction.update({ where: { id: b.tx.id }, data: { idempotencyKey: "isolation-key-b-0000" } })
    try {
      expect(await txRepo.findTransactionsByIdempotencyKeys(a.user.id, ["isolation-key-b-0000"])).toEqual([])
      expect(await inTransaction((uow) => txRepo.findTransactionsByIdempotencyKeys(a.user.id, ["isolation-key-b-0000"], uow))).toEqual([])
      expect((await txRepo.findTransactionsByIdempotencyKeys(b.user.id, ["isolation-key-b-0000"])).map((r) => r.id)).toEqual([theirs.id])
    } finally {
      await prisma.transaction.update({ where: { id: b.tx.id }, data: { idempotencyKey: null } })
    }
  })

  isolation("findGroupById", "returns null for another user's group", async () => {
    expect(await txRepo.findGroupById(a.user.id, b.group.id)).toBeNull()
    expect((await txRepo.findGroupById(a.user.id, a.group.id))?.userId).toBe(a.user.id)
    expect(await inTransaction((uow) => txRepo.findGroupById(a.user.id, b.group.id, uow))).toBeNull()
  })

  isolation("createTransactionGroup", "creates the group for the caller and touches nobody else's", async () => {
    const bBefore = await snapshotGroups(b.user.id)
    const group = await inTransaction((uow) => txRepo.createTransactionGroup(a.user.id, "MANUAL_SPLIT", uow))
    try {
      expect(group.userId).toBe(a.user.id)
      expect(await snapshotGroups(b.user.id)).toEqual(bBefore)
    } finally {
      await prisma.transactionGroup.delete({ where: { id: group.id } })
    }
  })

  isolation("softDeleteGroup", "does not delete the members of another user's group", async () => {
    const theirs = await bGroupWithRows(false)
    try {
      const before = await snapshotTransactions(b.user.id)
      await expectNotFound(inTransaction((uow) => txRepo.softDeleteGroup(a.user.id, theirs.group.id, uow)))
      expect(await snapshotTransactions(b.user.id)).toEqual(before)
    } finally {
      await theirs.cleanup()
    }
  })

  isolation("undeleteGroup", "does not restore the members of another user's deleted group", async () => {
    const theirs = await bGroupWithRows(true)
    try {
      const before = await snapshotTransactions(b.user.id)
      expect(await inTransaction((uow) => txRepo.undeleteGroup(a.user.id, theirs.group.id, uow))).toEqual([])
      expect(await snapshotTransactions(b.user.id)).toEqual(before)
    } finally {
      await theirs.cleanup()
    }
  })

  isolation("detachFromGroup", "does not take another user's transaction out of their group, or dissolve it", async () => {
    const theirs = await bGroupWithRows(false)
    try {
      const txBefore = await snapshotTransactions(b.user.id)
      const groupsBefore = await snapshotGroups(b.user.id)
      await expectNotFound(inTransaction((uow) => txRepo.detachFromGroup(a.user.id, theirs.rows[0].id, uow)))
      expect(await snapshotTransactions(b.user.id)).toEqual(txBefore)
      expect(await snapshotGroups(b.user.id)).toEqual(groupsBefore)
    } finally {
      await theirs.cleanup()
    }
  })

  isolation("sumBalances", "excludes another user's transactions", async () => {
    const mine = await txRepo.sumBalances(a.user.id)
    const myNodeIds = new Set((await snapshotNodes(a.user.id)).map((n) => n.id))
    expect(mine.every((r) => myNodeIds.has(r.nodeId))).toBe(true)
    expect(mine.some((r) => [b.bank.id, b.food.id].includes(r.nodeId))).toBe(false)
    expect(mine.find((r) => r.nodeId === a.bank.id)?.balance).toBe(-500n)
    expect(mine.find((r) => r.nodeId === a.food.id)?.balance).toBe(500n)
  })

  isolation("sumBalances", "is not distorted by a row smuggled onto another user's node", async () => {
    // The repositories refuse to create this row, but nothing in the database does. If one ever existed (a bug, a
    // manual fix, an import), each user's figures must still count only their own rows against their own nodes.
    const bBefore = await txRepo.sumBalances(b.user.id)
    // One row names B's node as its destination, the other as its source: both halves of the balance query.
    const smuggled = await registry.makeTransaction(a.user.id, a.bank.id, b.food.id, { amountPaise: 9_999n })
    const smuggledFrom = await registry.makeTransaction(a.user.id, b.bank.id, a.food.id, { amountPaise: 7_777n })
    try {
      expect(await txRepo.sumBalances(b.user.id)).toEqual(bBefore)
      const mine = await txRepo.sumBalances(a.user.id)
      expect(mine.some((r) => r.nodeId === b.food.id)).toBe(false)
    } finally {
      await prisma.transaction.deleteMany({ where: { id: { in: [smuggled.id, smuggledFrom.id] } } })
    }
  })
})


// The investment tables tie a row to its user only through these repositories: the schema has no constraint that a
// lot's userId is its node's or its transaction's owner. So every lookup by a node or transaction id is aimed at B's.
interface Holdings {
  userId: string
  gold: { id: string }
  buy: { id: string }
  legacyBuy: { id: string }
  sale: { id: string }
  lot: { id: string }
}

/**
 * A world of its own (so the figures the tests above assert about `a` and `b` are untouched) with a QUANTITY node: a
 * purchase that has a lot, a legacy purchase that has none, a sale that consumed part of the lot, and a price.
 */
async function makeHoldings(): Promise<Holdings> {
  const world = await registry.makeWorld()
  const userId = world.user.id
  const gold = await registry.makeNode(userId, "INVESTMENT", "Gold", { valuationMode: "QUANTITY", unitLabel: "g" })
  const buy = await registry.makeTransaction(userId, world.bank.id, gold.id, { amountPaise: 7_000_000n })
  const legacyBuy = await registry.makeTransaction(userId, world.bank.id, gold.id, { amountPaise: 1_000n })
  const sale = await registry.makeTransaction(userId, gold.id, world.bank.id, { amountPaise: 800_000n, occurredAt: "2026-04-02" })
  const lot = await prisma.investmentLot.create({
    data: { userId, nodeId: gold.id, transactionId: buy.id, quantity: new Prisma.Decimal("10"), costBasisPaise: 7_000_000n, acquiredAt: toDbDate(day) },
  })
  await prisma.lotConsumption.create({
    data: { userId, lotId: lot.id, transactionId: sale.id, quantity: new Prisma.Decimal("1"), costBasisPaise: 700_000n },
  })
  await prisma.priceSnapshot.create({ data: { userId, nodeId: gold.id, asOf: toDbDate(day), pricePerUnitPaise: 710_000n } })
  return { userId, gold, buy, legacyBuy, sale, lot }
}

const snapshotLots = (userId: string) => prisma.investmentLot.findMany({ where: { userId }, orderBy: { id: "asc" } })
const snapshotConsumptions = (userId: string) => prisma.lotConsumption.findMany({ where: { userId }, orderBy: { id: "asc" } })
const snapshotPrices = (userId: string) => prisma.priceSnapshot.findMany({ where: { userId }, orderBy: { id: "asc" } })

describe("lot repository", () => {
  let mine: Holdings
  let theirs: Holdings
  beforeAll(async () => {
    mine = await makeHoldings()
    theirs = await makeHoldings()
  })

  const lotDraft = (nodeId: string, transactionId: string) => ({
    nodeId,
    transactionId,
    quantity: 1_000_000n,
    costBasisPaise: 1_000n,
    acquiredAt: day,
  })

  isolation("insertLot", "refuses a lot on another user's node or for another user's transaction", async () => {
    const aBefore = await snapshotLots(mine.userId)
    const bBefore = await snapshotLots(theirs.userId)
    await expectNotFound(inTransaction((uow) => lotRepo.insertLot(mine.userId, lotDraft(theirs.gold.id, mine.legacyBuy.id), uow)))
    await expectNotFound(inTransaction((uow) => lotRepo.insertLot(mine.userId, lotDraft(mine.gold.id, theirs.legacyBuy.id), uow)))
    expect(await snapshotLots(mine.userId)).toEqual(aBefore)
    expect(await snapshotLots(theirs.userId)).toEqual(bBefore)
  })

  isolation("updateLot", "does not change another user's lot, nor move the caller's onto another user's node", async () => {
    const aBefore = await snapshotLots(mine.userId)
    const bBefore = await snapshotLots(theirs.userId)
    await expectNotFound(inTransaction((uow) => lotRepo.updateLot(mine.userId, theirs.buy.id, { quantity: 1n, costBasisPaise: 1n }, uow)))
    await expectNotFound(inTransaction((uow) => lotRepo.updateLot(mine.userId, mine.buy.id, { nodeId: theirs.gold.id }, uow)))
    expect(await snapshotLots(mine.userId)).toEqual(aBefore)
    expect(await snapshotLots(theirs.userId)).toEqual(bBefore)
  })

  isolation("deleteLotOf", "does not delete another user's lot", async () => {
    const before = await snapshotLots(theirs.userId)
    await expectNotFound(inTransaction((uow) => lotRepo.deleteLotOf(mine.userId, theirs.buy.id, uow)))
    expect(await snapshotLots(theirs.userId)).toEqual(before)
  })

  isolation("findLiveLots", "returns nothing for another user's node", async () => {
    expect(await lotRepo.findLiveLots(mine.userId, theirs.gold.id)).toEqual([])
    expect(await inTransaction((uow) => lotRepo.findLiveLots(mine.userId, theirs.gold.id, uow))).toEqual([])
    expect((await lotRepo.findLiveLots(theirs.userId, theirs.gold.id)).map((lot) => lot.id)).toEqual([theirs.lot.id])
  })

  isolation("findLiveLots", "does not count another user's consumption smuggled onto the caller's lot", async () => {
    // The repositories refuse to write this row; nothing in the database does.
    const smuggled = await prisma.lotConsumption.create({
      data: { userId: theirs.userId, lotId: mine.lot.id, transactionId: theirs.legacyBuy.id, quantity: new Prisma.Decimal("5"), costBasisPaise: 1n },
    })
    try {
      const [lot] = await lotRepo.findLiveLots(mine.userId, mine.gold.id)
      expect(lot.consumptions.map((c) => c.quantity)).toEqual([1_000_000n])
    } finally {
      await prisma.lotConsumption.delete({ where: { id: smuggled.id } })
    }
  })

  isolation("findLotByTransaction", "returns null for another user's transaction", async () => {
    expect(await lotRepo.findLotByTransaction(mine.userId, theirs.buy.id)).toBeNull()
    expect(await inTransaction((uow) => lotRepo.findLotByTransaction(mine.userId, theirs.buy.id, uow))).toBeNull()
    expect((await lotRepo.findLotByTransaction(mine.userId, mine.buy.id))?.id).toBe(mine.lot.id)
  })

  isolation("insertConsumptions", "refuses to consume another user's lot or to attach to another user's disposal", async () => {
    const aBefore = await snapshotConsumptions(mine.userId)
    const bBefore = await snapshotConsumptions(theirs.userId)
    const row = (lotId: string, transactionId: string) => ({ lotId, transactionId, quantity: 1n, costBasisPaise: 0n })
    await expectNotFound(inTransaction((uow) => lotRepo.insertConsumptions(mine.userId, [row(theirs.lot.id, mine.legacyBuy.id)], uow)))
    await expectNotFound(inTransaction((uow) => lotRepo.insertConsumptions(mine.userId, [row(mine.lot.id, theirs.legacyBuy.id)], uow)))
    // one bad row refuses the batch
    await expectNotFound(
      inTransaction((uow) =>
        lotRepo.insertConsumptions(mine.userId, [row(mine.lot.id, mine.legacyBuy.id), row(theirs.lot.id, mine.legacyBuy.id)], uow),
      ),
    )
    expect(await snapshotConsumptions(mine.userId)).toEqual(aBefore)
    expect(await snapshotConsumptions(theirs.userId)).toEqual(bBefore)
  })

  isolation("findConsumptionsByTransaction", "returns nothing for another user's disposal", async () => {
    expect(await lotRepo.findConsumptionsByTransaction(mine.userId, theirs.sale.id)).toEqual([])
    expect(await inTransaction((uow) => lotRepo.findConsumptionsByTransaction(mine.userId, theirs.sale.id, uow))).toEqual([])
    expect(await lotRepo.findConsumptionsByTransaction(theirs.userId, theirs.sale.id)).toHaveLength(1)
  })

  isolation("lockHoldings", "refuses another user's node, and locks the caller's own", async () => {
    await expectNotFound(inTransaction((uow) => lotRepo.lockHoldings(mine.userId, theirs.gold.id, uow)))
    await inTransaction((uow) => lotRepo.lockHoldings(mine.userId, mine.gold.id, uow))
  })

  isolation("countConsumptionsOfLot", "counts nothing for another user's purchase", async () => {
    expect(await lotRepo.countConsumptionsOfLot(mine.userId, theirs.buy.id)).toBe(0)
    expect(await inTransaction((uow) => lotRepo.countConsumptionsOfLot(mine.userId, theirs.buy.id, uow))).toBe(0)
    expect(await lotRepo.countConsumptionsOfLot(theirs.userId, theirs.buy.id)).toBe(1)
  })

  isolation("findLotQuantities", "gives nothing for another user's purchase, even beside the caller's own", async () => {
    expect(await lotRepo.findLotQuantities(mine.userId, [theirs.buy.id])).toEqual(new Map())
    expect(await lotRepo.findLotQuantities(mine.userId, [mine.buy.id, theirs.buy.id])).toEqual(new Map([[mine.buy.id, 10_000_000n]]))
    expect(await lotRepo.findLotQuantities(theirs.userId, [theirs.buy.id])).toEqual(new Map([[theirs.buy.id, 10_000_000n]]))
  })

  isolation("findSaleTransactionIds", "finds nothing for another user's sale, even beside the caller's own", async () => {
    expect(await lotRepo.findSaleTransactionIds(mine.userId, [theirs.sale.id])).toEqual(new Set())
    expect(await inTransaction((uow) => lotRepo.findSaleTransactionIds(mine.userId, [theirs.sale.id], uow))).toEqual(new Set())
    expect(await lotRepo.findSaleTransactionIds(mine.userId, [mine.sale.id, theirs.sale.id])).toEqual(new Set([mine.sale.id]))
    expect(await lotRepo.findSaleTransactionIds(theirs.userId, [theirs.sale.id])).toEqual(new Set([theirs.sale.id]))
  })

  isolation("findSaleTransactionIds", "does not count another user's consumption smuggled onto the caller's transaction", async () => {
    // The repositories refuse to write this row; nothing in the database does.
    const smuggled = await prisma.lotConsumption.create({
      data: { userId: theirs.userId, lotId: theirs.lot.id, transactionId: mine.legacyBuy.id, quantity: new Prisma.Decimal("1"), costBasisPaise: 1n },
    })
    try {
      expect(await lotRepo.findSaleTransactionIds(mine.userId, [mine.legacyBuy.id])).toEqual(new Set())
    } finally {
      await prisma.lotConsumption.delete({ where: { id: smuggled.id } })
    }
  })

  isolation("findLotGaps", "counts nothing for another user's node", async () => {
    const none = { inflowsWithoutLot: 0, splitLegsWithoutLot: 0, outflowsWithoutConsumption: 0 }
    expect(await lotRepo.findLotGaps(mine.userId, theirs.gold.id)).toEqual(none)
    expect(await inTransaction((uow) => lotRepo.findLotGaps(mine.userId, theirs.gold.id, uow))).toEqual(none)
    expect(await lotRepo.findLotGaps(theirs.userId, theirs.gold.id)).toEqual({ inflowsWithoutLot: 1, splitLegsWithoutLot: 0, outflowsWithoutConsumption: 0 })
  })
})

describe("price repository", () => {
  let mine: Holdings
  let theirs: Holdings
  beforeAll(async () => {
    mine = await makeHoldings()
    theirs = await makeHoldings()
  })

  isolation("upsertPrice", "does not write a price on another user's node, nor overwrite theirs", async () => {
    const aBefore = await snapshotPrices(mine.userId)
    const bBefore = await snapshotPrices(theirs.userId)
    await expectNotFound(priceRepo.upsertPrice(mine.userId, { nodeId: theirs.gold.id, asOf: day, pricePerUnitPaise: 1n }))
    await expectNotFound(priceRepo.upsertPrice(mine.userId, { nodeId: theirs.gold.id, asOf: calendarDate("2026-04-02"), pricePerUnitPaise: 1n }))
    expect(await snapshotPrices(mine.userId)).toEqual(aBefore)
    expect(await snapshotPrices(theirs.userId)).toEqual(bBefore)
  })

  isolation("listPrices", "returns nothing for another user's node", async () => {
    expect(await priceRepo.listPrices(mine.userId, theirs.gold.id)).toEqual([])
    expect(await priceRepo.listPrices(theirs.userId, theirs.gold.id)).toEqual([{ asOf: day, pricePerUnitPaise: 710_000n }])
  })

  isolation("deletePrice", "does not delete another user's price", async () => {
    const before = await snapshotPrices(theirs.userId)
    await expectNotFound(priceRepo.deletePrice(mine.userId, theirs.gold.id, day))
    expect(await snapshotPrices(theirs.userId)).toEqual(before)
  })

  isolation("deletePricesOfNode", "deletes none of another user's prices", async () => {
    const before = await snapshotPrices(theirs.userId)
    await inTransaction((uow) => priceRepo.deletePricesOfNode(mine.userId, theirs.gold.id, uow))
    expect(await snapshotPrices(theirs.userId)).toEqual(before)
  })
})

describe("user repository", () => {
  isolation("findUserTimezone", "answers only for the id it is given, and null for an id that is not a user", async () => {
    await prisma.user.update({ where: { id: b.user.id }, data: { timezone: "America/New_York" } })
    try {
      expect(await findUserTimezone(a.user.id)).toBe("Asia/Kolkata")
      expect(await findUserTimezone(b.user.id)).toBe("America/New_York")
      expect(await findUserTimezone("no-such-user")).toBeNull()
    } finally {
      await prisma.user.update({ where: { id: b.user.id }, data: { timezone: "Asia/Kolkata" } })
    }
  })

  isolation("findStalePriceDays", "answers only for the id it is given, and refuses an id that is not a user", async () => {
    await prisma.user.update({ where: { id: b.user.id }, data: { stalePriceDays: 90 } })
    try {
      expect(await findStalePriceDays(a.user.id)).toBe(30)
      expect(await findStalePriceDays(b.user.id)).toBe(90)
      expect(await findStalePriceDays("no-such-user").catch((e: unknown) => e)).toBeInstanceOf(UserNotFoundError)
    } finally {
      await prisma.user.update({ where: { id: b.user.id }, data: { stalePriceDays: 30 } })
    }
  })

  isolation("findFinancialYearStartMonth", "answers only for the id it is given, and refuses an id that is not a user", async () => {
    await prisma.user.update({ where: { id: b.user.id }, data: { financialYearStartMonth: 1 } })
    try {
      expect(await findFinancialYearStartMonth(a.user.id)).toBe(4)
      expect(await findFinancialYearStartMonth(b.user.id)).toBe(1)
      expect(await findFinancialYearStartMonth("no-such-user").catch((e: unknown) => e)).toBeInstanceOf(UserNotFoundError)
    } finally {
      await prisma.user.update({ where: { id: b.user.id }, data: { financialYearStartMonth: 4 } })
    }
  })
})

describe("report repository", () => {
  const range = { from: calendarDate("2026-01-01"), to: calendarDate("2026-12-31") }
  let flow: Awaited<ReturnType<typeof flowScenario>>
  let holdings: Awaited<ReturnType<typeof holdingsScenario>>
  beforeAll(async () => {
    flow = await flowScenario(registry)
    holdings = await holdingsScenario(registry)
  })

  isolation("findMoves", "finds nothing for another user's nodes, however they are named, and none of theirs for the caller", async () => {
    const theirNodeIds = Object.values(flow.nodes).map((n) => n.id)
    const own = await registry.makeWorld() // one live entry, bank -> food, on 2026-04-01
    // A's own nodes, filtered or not: nothing of the scenario's user shows up
    expect(await reportRepo.findMoves(own.user.id, { ...range, bucket: "month", nodeIds: theirNodeIds })).toEqual([])
    expect(await reportRepo.findMoves(own.user.id, { ...range, bucket: "month", nodeIds: [flow.nodes.Bank.id, own.bank.id] })).toEqual([
      { nodeId: own.bank.id, bucket: "2026-04", inPaise: 0n, outPaise: 500n },
    ])
    expect(await reportRepo.findMoves(own.user.id, { ...range, bucket: "day", kinds: ["ASSET", "EXPENSE", "INCOME_SOURCE"] })).toEqual([
      { nodeId: own.bank.id, bucket: "2026-04-01", inPaise: 0n, outPaise: 500n },
      { nodeId: own.food.id, bucket: "2026-04-01", inPaise: 500n, outPaise: 0n },
    ])
    // and the scenario's own user still sees their rows, so the empty answers above are about scoping
    expect((await reportRepo.findMoves(flow.user.id, { ...range, bucket: "month", nodeIds: [flow.nodes.Bank.id] })).length).toBe(3)
  })

  isolation("findMoves", "does not count another user's transaction smuggled onto the caller's node", async () => {
    // The repositories refuse to write this row; nothing in the database does.
    const own = await registry.makeWorld()
    const smuggled = await registry.makeTransaction(flow.user.id, flow.nodes.Bank.id, own.food.id, { amountPaise: 777n, occurredAt: "2026-04-02" })
    try {
      const rows = await reportRepo.findMoves(own.user.id, { ...range, bucket: "month", nodeIds: [own.food.id] })
      expect(rows).toEqual([{ nodeId: own.food.id, bucket: "2026-04", inPaise: 500n, outPaise: 0n }])
    } finally {
      await prisma.transaction.delete({ where: { id: smuggled.id } })
    }
  })

  isolation("findMoves", "does not report another user's node that the caller's transaction was pointed at", async () => {
    const own = await registry.makeWorld()
    const smuggled = await registry.makeTransaction(own.user.id, own.bank.id, flow.nodes.Food.id, { amountPaise: 333n, occurredAt: "2026-04-03" })
    try {
      const rows = await reportRepo.findMoves(own.user.id, { ...range, bucket: "month" })
      expect(rows.some((r) => r.nodeId === flow.nodes.Food.id)).toBe(false)
      expect(await reportRepo.findMoves(own.user.id, { ...range, bucket: "month", nodeIds: [flow.nodes.Food.id] })).toEqual([])
    } finally {
      await prisma.transaction.delete({ where: { id: smuggled.id } })
    }
  })

  isolation("findRealisedByMonth", "finds nothing for a user other than the one who sold", async () => {
    const own = await registry.makeWorld()
    expect(await reportRepo.findRealisedByMonth(own.user.id, range)).toEqual([])
    expect(await reportRepo.findRealisedByMonth(holdings.user.id, range)).toEqual([
      { nodeId: holdings.nodes.Gold.id, bucket: "2026-03", gainPaise: 480_000n, lossPaise: 0n },
    ])
  })

  isolation("findRealisedByMonth", "does not count a sale whose group, sold investment or gain or loss node is another user's", async () => {
    // The repositories refuse to write these rows; nothing in the database does. Every leg is the caller's (its userId is
    // A's), so only the group and node joins keep them out: one attack per join, each in a month of its own, and one real
    // sale of A's in May so the answer is not empty by accident. Dropping any one of the four userId conditions
    // (g, n, fn, tn) adds a row.
    const own = await registry.makeWorld()
    const other = await registry.makeWorld()
    const node = (userId: string, kind: "INVESTMENT" | "INCOME_SOURCE" | "EXPENSE", name: string, systemRole?: "REALISED_GAIN" | "REALISED_LOSS") =>
      registry.makeNode(userId, kind, name, systemRole ? { systemRole } : {})
    const gold = await node(own.user.id, "INVESTMENT", "Gold")
    const gain = await node(own.user.id, "INCOME_SOURCE", "Realised Gain", "REALISED_GAIN")
    const theirGold = await node(other.user.id, "INVESTMENT", "Gold")
    const theirGain = await node(other.user.id, "INCOME_SOURCE", "Realised Gain", "REALISED_GAIN")
    const theirLoss = await node(other.user.id, "EXPENSE", "Realised Loss", "REALISED_LOSS")
    const disposal = (userId: string) => prisma.transactionGroup.create({ data: { userId, kind: "DISPOSAL" } })
    const leg = (groupId: string, fromNodeId: string, toNodeId: string, amountPaise: bigint, occurredAt: string) =>
      prisma.transaction.create({
        data: { userId: own.user.id, groupId, fromNodeId, toNodeId, amountPaise, occurredAt: toDbDate(calendarDate(occurredAt)) },
      })

    // May: A's own sale of A's gold, ₹1.00 of gain. The one row the caller should see.
    const real = await disposal(own.user.id)
    await leg(real.id, gold.id, own.bank.id, 10_000n, "2026-05-10")
    await leg(real.id, gain.id, own.bank.id, 100n, "2026-05-10")
    // June: A's legs in another user's DISPOSAL group (kept out by g."userId").
    const theirs = await disposal(other.user.id)
    await leg(theirs.id, gold.id, own.bank.id, 10_000n, "2026-06-10")
    await leg(theirs.id, gain.id, own.bank.id, 200n, "2026-06-10")
    // July: A's group, but the investment sold is another user's (kept out by n."userId").
    const soldTheirs = await disposal(own.user.id)
    await leg(soldTheirs.id, theirGold.id, own.bank.id, 10_000n, "2026-07-10")
    await leg(soldTheirs.id, gain.id, own.bank.id, 300n, "2026-07-10")
    // August: A's sale of A's gold, the gain leg drawn from another user's Realised Gain (kept out by fn."userId").
    const gainTheirs = await disposal(own.user.id)
    await leg(gainTheirs.id, gold.id, own.bank.id, 10_000n, "2026-08-10")
    await leg(gainTheirs.id, theirGain.id, own.bank.id, 400n, "2026-08-10")
    // September: A's sale of A's gold, the loss leg sent to another user's Realised Loss (kept out by tn."userId").
    const lossTheirs = await disposal(own.user.id)
    await leg(lossTheirs.id, gold.id, own.bank.id, 10_000n, "2026-09-10")
    await leg(lossTheirs.id, gold.id, theirLoss.id, 500n, "2026-09-10")

    expect(await reportRepo.findRealisedByMonth(own.user.id, range)).toEqual([{ nodeId: gold.id, bucket: "2026-05", gainPaise: 100n, lossPaise: 0n }])
    // The other user has no legs at all: their group and nodes are only pointed at.
    expect(await reportRepo.findRealisedByMonth(other.user.id, range)).toEqual([])
  })

  isolation("findFirstTransactionDate", "reads only the caller's own entries", async () => {
    const own = await registry.makeWorld()
    const none = await registry.makeUser()
    expect(await reportRepo.findFirstTransactionDate(own.user.id)).toBe("2026-04-01") // not the scenario's 2026-01-01
    expect(await reportRepo.findFirstTransactionDate(flow.user.id)).toBe("2026-01-01")
    expect(await reportRepo.findFirstTransactionDate(none.id)).toBeNull()
  })

  isolation("countLiveTransactionsAfter", "counts only the caller's own entries", async () => {
    const own = await registry.makeWorld()
    const none = await registry.makeUser()
    expect(await reportRepo.countLiveTransactionsAfter(own.user.id, calendarDate("2026-03-31"))).toBe(1)
    expect(await reportRepo.countLiveTransactionsAfter(none.id, calendarDate("2000-01-01"))).toBe(0)
    expect(await reportRepo.countLiveTransactionsAfter(flow.user.id, calendarDate("2026-03-31"))).toBe(0)
  })
})

describe("unit of work", () => {
  isolation("inTransaction", "keeps the ownership checks of every repository write made through it", async () => {
    const aNodes = await snapshotNodes(a.user.id)
    const bNodes = await snapshotNodes(b.user.id)
    const aTx = await snapshotTransactions(a.user.id)
    const bTx = await snapshotTransactions(b.user.id)
    // a parent that is B's, a destination that is B's: both refused as not-found, from inside the transaction
    await expectNotFound(
      inTransaction((uow) => nodeRepo.createNode(a.user.id, { kind: "EXPENSE", name: "Sub", parentId: b.food.id }, uow)),
    )
    await expectNotFound(
      inTransaction((uow) => txRepo.insertTransactions(a.user.id, [draftTo(a.bank.id, b.food.id)], undefined, uow)),
    )
    // and a write that did succeed earlier in the same unit of work is rolled back with the refusal
    await expectNotFound(
      inTransaction(async (uow) => {
        await nodeRepo.createNode(a.user.id, { kind: "EXPENSE", name: "Rolled back" }, uow)
        await txRepo.insertTransactions(a.user.id, [draftTo(a.bank.id, b.food.id)], undefined, uow)
      }),
    )
    expect(await snapshotNodes(a.user.id)).toEqual(aNodes)
    expect(await snapshotNodes(b.user.id)).toEqual(bNodes)
    expect(await snapshotTransactions(a.user.id)).toEqual(aTx)
    expect(await snapshotTransactions(b.user.id)).toEqual(bTx)
  })

  isolation("inTransaction", "keeps the user scoping of updateTransaction, undeleteTransaction and sumBalances made through it", async () => {
    const deleted = await registry.makeTransaction(b.user.id, b.bank.id, b.food.id, { deletedAt: new Date() })
    const bTx = await snapshotTransactions(b.user.id)
    // B's rows by id, from inside A's transaction: not-found, never a conflict that would confirm the row exists
    await expectNotFound(
      inTransaction((uow) => txRepo.updateTransaction(a.user.id, b.tx.id, { note: "pwned" }, b.tx.version, uow)),
    )
    await expectNotFound(inTransaction((uow) => txRepo.undeleteTransaction(a.user.id, deleted.id, uow)))
    // and A's balances, read inside the transaction, carry none of B's nodes
    const seen = await inTransaction((uow) => txRepo.sumBalances(a.user.id, undefined, uow))
    expect(seen.some((r) => [b.bank.id, b.food.id].includes(r.nodeId))).toBe(false)
    expect(await snapshotTransactions(b.user.id)).toEqual(bTx)
  })
})

describe("recurring repository", () => {
  const snapshotRules = (userId: string) => prisma.recurringRule.findMany({ where: { userId }, orderBy: { id: "asc" } })
  const snapshotOccurrences = (userId: string) =>
    prisma.recurringOccurrence.findMany({ where: { userId }, orderBy: { id: "asc" } })

  // B owns a rule due on 2026-04-01 with a pending, a posted and a dismissed occurrence, and a second, deleted rule.
  let bRule: Awaited<ReturnType<typeof registry.makeRule>>
  let bPending: Awaited<ReturnType<typeof registry.makeOccurrence>>
  let bPosted: Awaited<ReturnType<typeof registry.makeOccurrence>>
  let bDismissed: Awaited<ReturnType<typeof registry.makeOccurrence>>
  let aRule: Awaited<ReturnType<typeof registry.makeRule>>

  beforeAll(async () => {
    bRule = await registry.makeRule(b.user.id, b.bank.id, b.food.id, { name: "B rent", nextDueOn: "2026-04-01" })
    bPending = await registry.makeOccurrence(b.user.id, bRule.id, "2026-04-01")
    bPosted = await registry.makeOccurrence(b.user.id, bRule.id, "2026-03-01", {
      status: "POSTED",
      transactionId: b.tx.id,
      resolvedAt: new Date(),
    })
    bDismissed = await registry.makeOccurrence(b.user.id, bRule.id, "2026-02-01", { status: "DISMISSED", resolvedAt: new Date() })
    aRule = await registry.makeRule(a.user.id, a.bank.id, a.food.id, { name: "A rent", nextDueOn: "2026-04-01" })
  })

  const ruleData = (over: Partial<recurringRepo.RuleData> = {}): recurringRepo.RuleData => ({
    name: "Mine",
    fromNodeId: a.bank.id,
    toNodeId: a.food.id,
    amountPaise: 100n,
    note: null,
    tags: [],
    frequency: "MONTHLY",
    interval: 1,
    dayOfMonth: 1,
    dayOfWeek: null,
    startDate: day,
    endDate: null,
    occurrenceLimit: null,
    autoPost: false,
    ...over,
  })

  isolation("insertRule", "refuses a node that is another user's and writes nothing", async () => {
    const aRules = await snapshotRules(a.user.id)
    const bRules = await snapshotRules(b.user.id)
    await expectNotFound(recurringRepo.insertRule(a.user.id, { ...ruleData({ toNodeId: b.food.id }), nextDueOn: day }))
    await expectNotFound(recurringRepo.insertRule(a.user.id, { ...ruleData({ fromNodeId: b.bank.id }), nextDueOn: day }))
    await expectNotFound(
      inTransaction((uow) => recurringRepo.insertRule(a.user.id, { ...ruleData({ toNodeId: b.food.id }), nextDueOn: day }, uow)),
    )
    expect(await snapshotRules(a.user.id)).toEqual(aRules)
    expect(await snapshotRules(b.user.id)).toEqual(bRules)
  })

  isolation("insertRule", "does not let another user's idempotency key reveal or return their rule", async () => {
    const key = `shared-key-${bRule.id}`
    await prisma.recurringRule.update({ where: { id: bRule.id }, data: { idempotencyKey: key } })
    const mine = await recurringRepo.insertRule(a.user.id, { ...ruleData(), nextDueOn: day, idempotencyKey: key })
    expect(mine.userId).toBe(a.user.id)
    expect(mine.id).not.toBe(bRule.id)
  })

  isolation("countRulesNaming", "counts nothing for another user's node, and counts only the caller's own rules", async () => {
    // B's rule names B's nodes: A asking about them learns nothing.
    expect(await recurringRepo.countRulesNaming(a.user.id, b.bank.id)).toBe(0)
    expect(await recurringRepo.countRulesNaming(a.user.id, b.food.id)).toBe(0)
    expect(await recurringRepo.countRulesNaming(b.user.id, b.food.id)).toBeGreaterThan(0)
    // A node of A's that only B could (not) name is simply uncounted for B.
    expect(await recurringRepo.countRulesNaming(b.user.id, a.food.id)).toBe(0)
  })

  isolation("findRuleById", "returns null for another user's rule", async () => {
    expect(await recurringRepo.findRuleById(a.user.id, bRule.id)).toBeNull()
    expect(await inTransaction((uow) => recurringRepo.findRuleById(a.user.id, bRule.id, uow))).toBeNull()
    expect(await recurringRepo.findRuleById(a.user.id, aRule.id)).not.toBeNull()
  })

  isolation("findRules", "never includes another user's rules", async () => {
    const mine = await recurringRepo.findRules(a.user.id)
    expect(mine.length).toBeGreaterThan(0)
    expect(mine.every((r) => r.userId === a.user.id)).toBe(true)
    expect(mine.some((r) => r.id === bRule.id)).toBe(false)
  })

  isolation("updateRule", "is not-found for another user's rule, never a conflict, and changes nothing", async () => {
    const before = await snapshotRules(b.user.id)
    await expectNotFound(recurringRepo.updateRule(a.user.id, bRule.id, bRule.version, { name: "pwned" }))
    await expectNotFound(recurringRepo.updateRule(a.user.id, bRule.id, bRule.version + 7, { name: "pwned" }))
    await expectNotFound(inTransaction((uow) => recurringRepo.updateRule(a.user.id, bRule.id, bRule.version, { amountPaise: 1n }, uow)))
    // and pointing my own rule at B's node is refused too
    await expectNotFound(recurringRepo.updateRule(a.user.id, aRule.id, aRule.version, { toNodeId: b.food.id }))
    expect(await snapshotRules(b.user.id)).toEqual(before)
    expect((await prisma.recurringRule.findUniqueOrThrow({ where: { id: aRule.id } })).version).toBe(aRule.version)
  })

  isolation("softDeleteRule", "is not-found for another user's rule and keeps its occurrences", async () => {
    const rules = await snapshotRules(b.user.id)
    const occurrences = await snapshotOccurrences(b.user.id)
    await expectNotFound(inTransaction((uow) => recurringRepo.softDeleteRule(a.user.id, bRule.id, uow)))
    expect(await snapshotRules(b.user.id)).toEqual(rules)
    expect(await snapshotOccurrences(b.user.id)).toEqual(occurrences)
  })

  isolation("lockRule", "returns null for another user's rule", async () => {
    expect(await inTransaction((uow) => recurringRepo.lockRule(a.user.id, bRule.id, uow))).toBeNull()
    expect(await inTransaction((uow) => recurringRepo.lockRule(a.user.id, aRule.id, uow))).not.toBeNull()
  })

  isolation("findDueRules", "never includes another user's due rules", async () => {
    const due = await recurringRepo.findDueRules(a.user.id, calendarDate("2099-01-01"))
    expect(due.map((r) => r.id)).toContain(aRule.id)
    expect(due.every((r) => r.userId === a.user.id)).toBe(true)
    expect(await inTransaction((uow) => recurringRepo.findDueRules(a.user.id, calendarDate("2099-01-01"), uow))).toEqual(due)
  })

  isolation("findUsersWithRulesDueBy", "lists only user ids, and only users that really have a rule due", async () => {
    // The one deliberately cross-user query: it names users, never rows, and a user with nothing due is absent.
    const none = await registry.makeUser()
    const users = await recurringRepo.findUsersWithRulesDueBy(calendarDate("2026-04-01"))
    expect(users).toContain(a.user.id)
    expect(users).toContain(b.user.id)
    expect(users).not.toContain(none.id)
    expect(users.every((id) => typeof id === "string")).toBe(true)
    expect(await recurringRepo.findUsersWithRulesDueBy(calendarDate("2000-01-01"))).not.toContain(a.user.id)
  })

  isolation("insertOccurrences", "is not-found for another user's rule and inserts nothing", async () => {
    const before = await snapshotOccurrences(b.user.id)
    await expectNotFound(
      inTransaction((uow) => recurringRepo.insertOccurrences(a.user.id, bRule.id, [calendarDate("2030-01-01")], uow)),
    )
    expect(await snapshotOccurrences(b.user.id)).toEqual(before)
    expect(await prisma.recurringOccurrence.count({ where: { ruleId: bRule.id, userId: a.user.id } })).toBe(0)
  })

  isolation("countOccurrences", "counts nothing for another user's rule", async () => {
    expect(await recurringRepo.countOccurrences(a.user.id, bRule.id)).toBe(0)
    expect(await inTransaction((uow) => recurringRepo.countOccurrences(a.user.id, bRule.id, uow))).toBe(0)
    expect(await recurringRepo.countOccurrences(b.user.id, bRule.id)).toBe(3)
  })

  isolation("findOccurrenceById", "returns null for another user's occurrence, whatever its state", async () => {
    for (const o of [bPending, bPosted, bDismissed]) {
      expect(await recurringRepo.findOccurrenceById(a.user.id, o.id)).toBeNull()
      expect(await inTransaction((uow) => recurringRepo.findOccurrenceById(a.user.id, o.id, uow))).toBeNull()
    }
    expect(await recurringRepo.findOccurrenceById(b.user.id, bPending.id)).not.toBeNull()
  })

  isolation("findPending", "never includes another user's pending occurrences", async () => {
    const mine = await recurringRepo.findPending(a.user.id)
    expect(mine).toEqual([])
    expect((await recurringRepo.findPending(b.user.id)).map((o) => o.id)).toEqual([bPending.id])
  })

  isolation("countPending", "counts only the caller's own", async () => {
    expect(await recurringRepo.countPending(a.user.id)).toBe(0)
    expect(await recurringRepo.countPending(b.user.id)).toBe(1)
  })

  isolation("findRecentlyHandled", "never includes another user's posted or dismissed occurrences", async () => {
    expect(await recurringRepo.findRecentlyHandled(a.user.id, 50)).toEqual([])
    expect((await recurringRepo.findRecentlyHandled(b.user.id, 50)).map((o) => o.id).sort()).toEqual([bPosted.id, bDismissed.id].sort())
  })

  isolation("markPosted", "returns null for another user's occurrence and changes nothing", async () => {
    const before = await snapshotOccurrences(b.user.id)
    const mine = await registry.makeTransaction(a.user.id, a.bank.id, a.food.id)
    expect(await recurringRepo.markPosted(a.user.id, bPending.id, mine.id)).toBeNull()
    expect(await snapshotOccurrences(b.user.id)).toEqual(before)
    // linking my occurrence to B's transaction is refused too
    const own = await registry.makeOccurrence(a.user.id, aRule.id, "2026-09-01")
    await expectNotFound(recurringRepo.markPosted(a.user.id, own.id, b.tx.id))
    expect((await prisma.recurringOccurrence.findUniqueOrThrow({ where: { id: own.id } })).status).toBe("PENDING")
  })

  isolation("markDismissed", "returns null for another user's occurrence and changes nothing", async () => {
    const before = await snapshotOccurrences(b.user.id)
    expect(await recurringRepo.markDismissed(a.user.id, bPending.id)).toBeNull()
    expect(await snapshotOccurrences(b.user.id)).toEqual(before)
  })

  isolation("markPending", "returns null for another user's occurrence and changes nothing", async () => {
    const before = await snapshotOccurrences(b.user.id)
    expect(await recurringRepo.markPending(a.user.id, bDismissed.id)).toBeNull()
    expect(await snapshotOccurrences(b.user.id)).toEqual(before)
  })

  isolation("setPostFailure", "does not touch another user's occurrence", async () => {
    const before = await snapshotOccurrences(b.user.id)
    await recurringRepo.setPostFailure(a.user.id, bPending.id, "pwned")
    expect(await snapshotOccurrences(b.user.id)).toEqual(before)
  })
})

describe("coverage", () => {
  // Every module in src/server/repositories is read from the directory, not from a hand-kept import list.
  const files = readdirSync(new URL("../../../src/server/repositories/", import.meta.url)).filter((f) => f.endsWith(".ts")).map((f) => f.slice(0, -".ts".length))
  const exportedFunctions = (mod: Record<string, unknown>) =>
    Object.entries(mod)
      .filter(([name, value]) => typeof value === "function" && !name.endsWith("Error"))
      .map(([name]) => name)

  // Not isolation surface: `clientOf` only unwraps the token a repository was handed, it takes and returns no user data.
  const NOT_QUERIES = new Set(["clientOf"])

  it("every exported repository function has at least one isolation test, and none is registered for a non-export", async () => {
    const perModule = await Promise.all(
      files.map(async (file) => ({
        path: `${file}.ts`,
        fns: exportedFunctions((await import(`../../../src/server/repositories/${file}.ts`)) as Record<string, unknown>).filter(
          (name) => !NOT_QUERIES.has(name),
        ),
      })),
    )
    // The modules come from the directory, and their names are asserted: a repository file added later fails this line
    // until its functions get isolation cases below, instead of sitting outside the check unnoticed.
    expect(perModule.map((m) => m.path).sort()).toEqual([
      "errors.ts",
      "lot-repository.ts",
      "node-repository.ts",
      "price-repository.ts",
      "recurring-repository.ts",
      "report-repository.ts",
      "transaction-repository.ts",
      "unit-of-work.ts",
      "user-repository.ts",
    ])
    // Separate lists per module, so a name exported from two cannot be hidden by one shadowing the other.
    const all = perModule.flatMap((m) => m.fns)
    expect(all.filter((name, i) => all.indexOf(name) !== i), "exported from more than one repository").toEqual([])
    const exported = [...all].sort()
    expect(exported.length).toBeGreaterThan(0)
    expect(exported.filter((name) => !covered.has(name)), "exports with no isolation test").toEqual([])
    expect([...covered.keys()].filter((name) => !exported.includes(name)), "tests registered for no export").toEqual([])
  })
})
