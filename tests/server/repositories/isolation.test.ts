import { readdirSync } from "node:fs"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { calendarDate } from "@/domain/calendar-date"
import { prisma } from "@/server/db"
import { NotFoundError } from "@/server/repositories/errors"
import * as nodeRepo from "@/server/repositories/node-repository"
import * as txRepo from "@/server/repositories/transaction-repository"
import { findUserTimezone } from "@/server/repositories/user-repository"
import { inTransaction } from "@/server/repositories/unit-of-work"
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
      "node-repository.ts",
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
