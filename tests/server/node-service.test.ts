import { afterAll, afterEach, describe, expect, it, vi } from "vitest"
import { fromDbDate, todayIn } from "@/domain/calendar-date"
import { prisma } from "@/server/db"
import { NotFoundError } from "@/server/repositories/errors"
import { findNodeById } from "@/server/repositories/node-repository"
import * as transactionRepo from "@/server/repositories/transaction-repository"
import { sumBalances } from "@/server/repositories/transaction-repository"
import { seedAccountNodes } from "@/server/services/account-seed"
import {
  archiveLedgerNode,
  createLedgerNode,
  findDuplicateNodes,
  HierarchyDepthError,
  InvalidNodeError,
  listAllNodes,
  listNodesForPicker,
  NodeHasHistoryError,
  removeLedgerNode,
  renameLedgerNode,
  restoreLedgerNode,
  SystemNodeError,
} from "@/server/services/node-service"
import { createRegistry } from "./repositories/fixtures"

const registry = createRegistry()
afterAll(registry.cleanup)
afterEach(() => vi.restoreAllMocks())

/** A user as signup leaves them: the three system nodes and the starter expense ledgers exist. */
async function makeSeededUser() {
  const user = await registry.makeUser()
  await prisma.$transaction((tx) => seedAccountNodes(tx, user.id))
  const systemNode = async (role: "OPENING_BALANCE" | "REALISED_GAIN" | "REALISED_LOSS") =>
    prisma.ledgerNode.findFirstOrThrow({ where: { userId: user.id, systemRole: role } })
  return { user, systemNode }
}

const bankInput = { kind: "ASSET", name: "HDFC Savings", assetSubtype: "SAVINGS" } as const

describe("picker and listing", () => {
  it("omits archived nodes from the picker but keeps them in the full list", async () => {
    // EC-14, RF#5
    const user = await registry.makeUser()
    const bank = await createLedgerNode(user.id, bankInput)
    const old = await createLedgerNode(user.id, { kind: "ASSET", name: "Old", assetSubtype: "CASH" })
    const food = await createLedgerNode(user.id, { kind: "EXPENSE", name: "Food" })
    await archiveLedgerNode(user.id, old.id)

    expect((await listNodesForPicker(user.id)).map((n) => n.id)).toEqual([bank.id, food.id])
    expect((await listAllNodes(user.id)).map((n) => n.id)).toEqual([bank.id, old.id, food.id])
    expect((await listNodesForPicker(user.id, ["EXPENSE"])).map((n) => n.id)).toEqual([food.id])
    expect((await listAllNodes(user.id, ["ASSET"])).map((n) => n.id)).toEqual([bank.id, old.id])
    // an archived node is still reachable by id: historical transactions reference it
    expect(await findNodeById(user.id, old.id)).not.toBeNull()
  })

  it("never lists another user's nodes", async () => {
    const mine = await registry.makeUser()
    const theirs = await registry.makeUser()
    await createLedgerNode(theirs.id, bankInput)
    expect(await listNodesForPicker(mine.id)).toEqual([])
    expect(await listAllNodes(mine.id)).toEqual([])
  })
})

describe("createLedgerNode", () => {
  it("stores the kind-specific fields it is given and trims the name", async () => {
    const user = await registry.makeUser()
    const card = await createLedgerNode(user.id, {
      kind: "LIABILITY",
      name: "  Axis Card  ",
      liabilitySubtype: "CREDIT_CARD",
      institution: "Axis",
      lastFour: "4321",
      creditLimitPaise: 2_00_000_00n,
      statementDay: 5,
      dueDay: 25,
    })
    expect(card).toMatchObject({
      userId: user.id,
      kind: "LIABILITY",
      name: "Axis Card",
      liabilitySubtype: "CREDIT_CARD",
      creditLimitPaise: 2_00_000_00n,
      statementDay: 5,
      dueDay: 25,
      systemRole: null,
    })
  })

  it("creates an opening-balance transaction when an opening balance is given", async () => {
    // EC-36
    const { user, systemNode } = await makeSeededUser()
    const openingNode = await systemNode("OPENING_BALANCE")
    const before = todayIn("Asia/Kolkata")

    const bank = await createLedgerNode(user.id, { ...bankInput, openingBalance: 12_345_67n })

    const rows = await prisma.transaction.findMany({ where: { userId: user.id } })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      fromNodeId: openingNode.id,
      toNodeId: bank.id,
      amountPaise: 12_345_67n,
      deletedAt: null,
      groupId: null,
    })
    // dated "today" in the user's own timezone (the default, Asia/Kolkata, for this user)
    expect([before, todayIn("Asia/Kolkata")]).toContain(fromDbDate(rows[0].occurredAt))
    // and it is what the node's derived balance reads
    const balances = await sumBalances(user.id)
    expect(balances.find((b) => b.nodeId === bank.id)?.balance).toBe(12_345_67n)
  })

  it("posts a liability's opening balance from the same system node", async () => {
    const { user, systemNode } = await makeSeededUser()
    const openingNode = await systemNode("OPENING_BALANCE")
    const loan = await createLedgerNode(user.id, {
      kind: "LIABILITY",
      name: "Car loan",
      liabilitySubtype: "LOAN",
      openingBalance: 5_00_000_00n,
    })
    const row = await prisma.transaction.findFirstOrThrow({ where: { userId: user.id } })
    expect(row).toMatchObject({ fromNodeId: openingNode.id, toNodeId: loan.id, amountPaise: 5_00_000_00n })
  })

  it("writes no transaction when no opening balance is given", async () => {
    const { user } = await makeSeededUser()
    await createLedgerNode(user.id, bankInput)
    expect(await prisma.transaction.count({ where: { userId: user.id } })).toBe(0)
  })

  it("refuses an opening balance that is zero or negative, creating nothing", async () => {
    const { user } = await makeSeededUser()
    const nodesBefore = await prisma.ledgerNode.count({ where: { userId: user.id } })
    for (const openingBalance of [0n, -100n]) {
      await expect(createLedgerNode(user.id, { ...bankInput, openingBalance })).rejects.toThrow(InvalidNodeError)
    }
    expect(await prisma.ledgerNode.count({ where: { userId: user.id } })).toBe(nodesBefore)
    expect(await prisma.transaction.count({ where: { userId: user.id } })).toBe(0)
  })

  it("refuses an opening balance on a kind that does not hold a balance, creating nothing", async () => {
    const { user } = await makeSeededUser()
    const nodesBefore = await prisma.ledgerNode.count({ where: { userId: user.id } })
    // the type forbids it; a caller that got past the type must still be refused. EXPENSE is the dangerous one:
    // INCOME_SOURCE -> EXPENSE is a legal flow, so only the kind check stops it.
    const forged = { kind: "EXPENSE", name: "Food2", openingBalance: 100n } as unknown as Parameters<typeof createLedgerNode>[1]
    await expect(createLedgerNode(user.id, forged)).rejects.toThrow(InvalidNodeError)
    expect(await prisma.ledgerNode.count({ where: { userId: user.id } })).toBe(nodesBefore)
  })

  it("rolls the node back if the opening-balance transaction cannot be written", async () => {
    const { user } = await makeSeededUser()
    const nodesBefore = await prisma.ledgerNode.count({ where: { userId: user.id } })
    vi.spyOn(transactionRepo, "insertTransactions").mockRejectedValueOnce(new Error("connection reset"))
    await expect(createLedgerNode(user.id, { ...bankInput, openingBalance: 100n })).rejects.toThrow("connection reset")
    expect(await prisma.ledgerNode.count({ where: { userId: user.id } })).toBe(nodesBefore)
  })

  it("refuses an opening balance for an account that has no Opening Balance node", async () => {
    const user = await registry.makeUser() // not seeded
    await expect(createLedgerNode(user.id, { ...bankInput, openingBalance: 100n })).rejects.toThrow(SystemNodeError)
    expect(await prisma.ledgerNode.count({ where: { userId: user.id } })).toBe(0)
  })

  it("refuses a blank name", async () => {
    const user = await registry.makeUser()
    await expect(createLedgerNode(user.id, { ...bankInput, name: "   " })).rejects.toThrow(InvalidNodeError)
    expect(await prisma.ledgerNode.count({ where: { userId: user.id } })).toBe(0)
  })
})

describe("node hierarchy", () => {
  it("nests a node one level under an income or expense node", async () => {
    const user = await registry.makeUser()
    const food = await createLedgerNode(user.id, { kind: "EXPENSE", name: "Food" })
    const lunch = await createLedgerNode(user.id, { kind: "EXPENSE", name: "Lunch", parentId: food.id })
    expect(lunch.parentId).toBe(food.id)
  })

  it("refuses to nest a node under a node that already has a parent", async () => {
    const user = await registry.makeUser()
    const food = await createLedgerNode(user.id, { kind: "EXPENSE", name: "Food" })
    const lunch = await createLedgerNode(user.id, { kind: "EXPENSE", name: "Lunch", parentId: food.id })
    await expect(
      createLedgerNode(user.id, { kind: "EXPENSE", name: "Office lunch", parentId: lunch.id }),
    ).rejects.toThrow(HierarchyDepthError)
    expect(await prisma.ledgerNode.count({ where: { userId: user.id, name: "Office lunch" } })).toBe(0)
  })

  it("refuses a parent of a different kind, or of a kind that is not grouped", async () => {
    const user = await registry.makeUser()
    const salary = await createLedgerNode(user.id, { kind: "INCOME_SOURCE", name: "Salary" })
    const bank = await createLedgerNode(user.id, bankInput)
    await expect(createLedgerNode(user.id, { kind: "EXPENSE", name: "Misc", parentId: salary.id })).rejects.toThrow(
      InvalidNodeError,
    )
    const forged = { kind: "ASSET", name: "Sub", assetSubtype: "CASH", parentId: bank.id } as unknown as Parameters<
      typeof createLedgerNode
    >[1]
    await expect(createLedgerNode(user.id, forged)).rejects.toThrow(InvalidNodeError)
  })

  it("cannot be pointed at another user's node as a parent", async () => {
    const mine = await registry.makeUser()
    const theirs = await registry.makeUser()
    const theirFood = await createLedgerNode(theirs.id, { kind: "EXPENSE", name: "Food" })
    await expect(
      createLedgerNode(mine.id, { kind: "EXPENSE", name: "Lunch", parentId: theirFood.id }),
    ).rejects.toThrow(NotFoundError)
    expect(await prisma.ledgerNode.count({ where: { userId: mine.id } })).toBe(0)
  })
})

describe("renameLedgerNode", () => {
  it("renames a node and leaves its kind alone", async () => {
    // EC-34: there is no function in this module that changes a kind, and rename carries nothing but the name.
    const user = await registry.makeUser()
    const bank = await createLedgerNode(user.id, bankInput)
    const renamed = await renameLedgerNode(user.id, bank.id, "  Salary account ")
    expect(renamed).toMatchObject({ id: bank.id, name: "Salary account", kind: "ASSET", assetSubtype: "SAVINGS" })
    expect((await findNodeById(user.id, bank.id))?.kind).toBe("ASSET")
  })

  it("refuses a blank name", async () => {
    const user = await registry.makeUser()
    const bank = await createLedgerNode(user.id, bankInput)
    await expect(renameLedgerNode(user.id, bank.id, " ")).rejects.toThrow(InvalidNodeError)
    expect((await findNodeById(user.id, bank.id))?.name).toBe("HDFC Savings")
  })

  it("refuses to rename a system node", async () => {
    // EC-37
    const { user, systemNode } = await makeSeededUser()
    const opening = await systemNode("OPENING_BALANCE")
    await expect(renameLedgerNode(user.id, opening.id, "Mine now")).rejects.toThrow(SystemNodeError)
    expect((await findNodeById(user.id, opening.id))?.name).toBe("Opening Balance")
  })
})

describe("system nodes", () => {
  it("refuses to rename, archive or delete a system node", async () => {
    // EC-37, SystemNodeError
    const { user, systemNode } = await makeSeededUser()
    for (const role of ["OPENING_BALANCE", "REALISED_GAIN", "REALISED_LOSS"] as const) {
      const node = await systemNode(role)
      await expect(renameLedgerNode(user.id, node.id, "Other")).rejects.toThrow(SystemNodeError)
      await expect(archiveLedgerNode(user.id, node.id)).rejects.toThrow(SystemNodeError)
      await expect(removeLedgerNode(user.id, node.id)).rejects.toThrow(SystemNodeError)
      expect(await findNodeById(user.id, node.id)).toEqual(node)
    }
  })

  it("does let the user rename and delete the starter ledgers, which are ordinary nodes", async () => {
    const { user } = await makeSeededUser()
    const groceries = await prisma.ledgerNode.findFirstOrThrow({ where: { userId: user.id, name: "Groceries" } })
    expect((await renameLedgerNode(user.id, groceries.id, "Food")).name).toBe("Food")
    await removeLedgerNode(user.id, groceries.id)
    expect(await findNodeById(user.id, groceries.id)).toBeNull()
  })
})

describe("removeLedgerNode", () => {
  it("hard-deletes a node that has no transactions", async () => {
    // EC-33
    const user = await registry.makeUser()
    const bank = await createLedgerNode(user.id, bankInput)
    await removeLedgerNode(user.id, bank.id)
    expect(await findNodeById(user.id, bank.id)).toBeNull()
  })

  it("refuses to hard-delete a node that has transactions", async () => {
    // NodeHasHistoryError
    const { user, systemNode } = await makeSeededUser()
    const opening = await systemNode("OPENING_BALANCE")
    const bank = await createLedgerNode(user.id, bankInput)
    const food = await createLedgerNode(user.id, { kind: "EXPENSE", name: "Food" })
    await registry.makeTransaction(user.id, opening.id, bank.id)
    await registry.makeTransaction(user.id, bank.id, food.id)
    // as source, as destination
    await expect(removeLedgerNode(user.id, bank.id)).rejects.toThrow(NodeHasHistoryError)
    await expect(removeLedgerNode(user.id, food.id)).rejects.toThrow(NodeHasHistoryError)
    expect(await findNodeById(user.id, bank.id)).not.toBeNull()
    expect(await findNodeById(user.id, food.id)).not.toBeNull()
  })

  it("counts a soft-deleted transaction as history", async () => {
    // the database still refuses to delete a node a deleted row points at
    const user = await registry.makeUser()
    const bank = await createLedgerNode(user.id, bankInput)
    const food = await createLedgerNode(user.id, { kind: "EXPENSE", name: "Food" })
    await registry.makeTransaction(user.id, bank.id, food.id, { deletedAt: new Date() })
    await expect(removeLedgerNode(user.id, food.id)).rejects.toThrow(NodeHasHistoryError)
  })
})

describe("archiveLedgerNode and restoreLedgerNode", () => {
  it("archives a node with a balance and reports the residual", async () => {
    // EC-32: warned about by the UI, never blocked
    const { user } = await makeSeededUser()
    const bank = await createLedgerNode(user.id, { ...bankInput, openingBalance: 10_000_00n })
    const food = await createLedgerNode(user.id, { kind: "EXPENSE", name: "Food" })
    await registry.makeTransaction(user.id, bank.id, food.id, { amountPaise: 2_500_50n })

    const { node, residualBalance } = await archiveLedgerNode(user.id, bank.id)

    expect(residualBalance).toBe(7_499_50n)
    expect(node.id).toBe(bank.id)
    expect(node.archivedAt).toBeInstanceOf(Date)
    expect((await findNodeById(user.id, bank.id))?.archivedAt).not.toBeNull()
  })

  it("reports a zero residual for a node with no transactions", async () => {
    const user = await registry.makeUser()
    const bank = await createLedgerNode(user.id, bankInput)
    expect((await archiveLedgerNode(user.id, bank.id)).residualBalance).toBe(0n)
  })

  it("reports a negative residual as negative", async () => {
    const user = await registry.makeUser()
    const bank = await createLedgerNode(user.id, bankInput)
    const food = await createLedgerNode(user.id, { kind: "EXPENSE", name: "Food" })
    await registry.makeTransaction(user.id, bank.id, food.id, { amountPaise: 300n })
    expect((await archiveLedgerNode(user.id, bank.id)).residualBalance).toBe(-300n)
  })

  it("ignores soft-deleted transactions in the residual", async () => {
    const user = await registry.makeUser()
    const bank = await createLedgerNode(user.id, bankInput)
    const food = await createLedgerNode(user.id, { kind: "EXPENSE", name: "Food" })
    await registry.makeTransaction(user.id, bank.id, food.id, { amountPaise: 300n, deletedAt: new Date() })
    expect((await archiveLedgerNode(user.id, bank.id)).residualBalance).toBe(0n)
  })

  it("refuses to archive a node twice, because it can no longer report a residual", async () => {
    const user = await registry.makeUser()
    const bank = await createLedgerNode(user.id, bankInput)
    const { node } = await archiveLedgerNode(user.id, bank.id)
    await expect(archiveLedgerNode(user.id, bank.id)).rejects.toThrow(InvalidNodeError)
    expect((await findNodeById(user.id, bank.id))?.archivedAt).toEqual(node.archivedAt)
  })

  it("restores an archived node to the picker", async () => {
    const user = await registry.makeUser()
    const bank = await createLedgerNode(user.id, bankInput)
    await archiveLedgerNode(user.id, bank.id)
    expect(await listNodesForPicker(user.id)).toEqual([])
    const restored = await restoreLedgerNode(user.id, bank.id)
    expect(restored.archivedAt).toBeNull()
    expect((await listNodesForPicker(user.id)).map((n) => n.id)).toEqual([bank.id])
  })

  it("restoring a node that is not archived is a no-op", async () => {
    const user = await registry.makeUser()
    const bank = await createLedgerNode(user.id, bankInput)
    expect((await restoreLedgerNode(user.id, bank.id)).archivedAt).toBeNull()
  })
})

describe("duplicate names", () => {
  it("warns but does not block on a duplicate node name", async () => {
    // EC-35
    const user = await registry.makeUser()
    const first = await createLedgerNode(user.id, bankInput)
    const duplicates = await findDuplicateNodes(user.id, "ASSET", "  hdfc savings ")
    expect(duplicates.map((n) => n.id)).toEqual([first.id])

    const second = await createLedgerNode(user.id, bankInput)
    expect(second.id).not.toBe(first.id)
    expect(await prisma.ledgerNode.count({ where: { userId: user.id, name: "HDFC Savings" } })).toBe(2)
  })

  it("reports a duplicate only within the same kind, and not an archived or excluded node", async () => {
    const user = await registry.makeUser()
    const bank = await createLedgerNode(user.id, bankInput)
    await createLedgerNode(user.id, { kind: "EXPENSE", name: "HDFC Savings" })
    expect((await findDuplicateNodes(user.id, "ASSET", "HDFC Savings")).map((n) => n.id)).toEqual([bank.id])
    expect(await findDuplicateNodes(user.id, "ASSET", "HDFC Savings", bank.id)).toEqual([])
    await archiveLedgerNode(user.id, bank.id)
    expect(await findDuplicateNodes(user.id, "ASSET", "HDFC Savings")).toEqual([])
  })

  it("does not see another user's nodes", async () => {
    const mine = await registry.makeUser()
    const theirs = await registry.makeUser()
    await createLedgerNode(theirs.id, bankInput)
    expect(await findDuplicateNodes(mine.id, "ASSET", "HDFC Savings")).toEqual([])
  })
})

describe("ownership", () => {
  it("treats another user's node as not found for every operation, and leaves it untouched", async () => {
    const mine = await registry.makeUser()
    const theirs = await registry.makeUser()
    const theirBank = await createLedgerNode(theirs.id, bankInput)

    await expect(renameLedgerNode(mine.id, theirBank.id, "Mine")).rejects.toThrow(NotFoundError)
    await expect(archiveLedgerNode(mine.id, theirBank.id)).rejects.toThrow(NotFoundError)
    await expect(restoreLedgerNode(mine.id, theirBank.id)).rejects.toThrow(NotFoundError)
    await expect(removeLedgerNode(mine.id, theirBank.id)).rejects.toThrow(NotFoundError)
    expect(await findNodeById(theirs.id, theirBank.id)).toEqual(theirBank)
  })
})
