import { afterAll, describe, expect, it } from "vitest"
import { prisma } from "@/server/db"
import { NotFoundError } from "@/server/repositories/errors"
import {
  countTransactionsForNode,
  createNode,
  deleteNode,
  findNodeById,
  findNodes,
  updateNode,
} from "@/server/repositories/node-repository"
import { createRegistry } from "./fixtures"

const registry = createRegistry()
afterAll(registry.cleanup)

describe("node repository", () => {
  it("creates a node and reads it back", async () => {
    const user = await registry.makeUser()
    const node = await createNode(user.id, {
      kind: "ASSET",
      name: "HDFC Savings",
      assetSubtype: "SAVINGS",
      institution: "HDFC",
      lastFour: "1234",
      creditLimitPaise: 5_000_000n,
    })
    expect(node).toMatchObject({ userId: user.id, kind: "ASSET", name: "HDFC Savings", assetSubtype: "SAVINGS", systemRole: null })
    expect(await findNodeById(user.id, node.id)).toEqual(node)
  })

  it("lists live nodes by default and archived ones on request, filtered by kind", async () => {
    const user = await registry.makeUser()
    const bank = await createNode(user.id, { kind: "ASSET", name: "Bank" })
    const card = await createNode(user.id, { kind: "LIABILITY", name: "Card" })
    const old = await createNode(user.id, { kind: "ASSET", name: "Old" })
    await updateNode(user.id, old.id, { archivedAt: new Date() })
    expect((await findNodes(user.id)).map((n) => n.id)).toEqual([bank.id, card.id])
    expect((await findNodes(user.id, { includeArchived: true })).map((n) => n.id).sort()).toEqual([bank.id, card.id, old.id].sort())
    expect((await findNodes(user.id, { kinds: ["LIABILITY"] })).map((n) => n.id)).toEqual([card.id])
    expect((await findNodes(user.id, { kinds: ["ASSET"], includeArchived: true })).map((n) => n.id).sort()).toEqual([bank.id, old.id].sort())
    // an archived node is still reachable by id: historical transactions reference it
    expect(await findNodeById(user.id, old.id)).not.toBeNull()
  })

  it("updates only the fields given, and cannot change kind, owner or system role", async () => {
    const user = await registry.makeUser()
    const node = await createNode(user.id, { kind: "ASSET", name: "Bank", institution: "HDFC" })
    const forged = { name: "Renamed", kind: "EXPENSE", systemRole: "OPENING_BALANCE", userId: "someone-else" } as Parameters<typeof updateNode>[2]
    const updated = await updateNode(user.id, node.id, forged)
    expect(updated).toMatchObject({ name: "Renamed", institution: "HDFC", kind: "ASSET", systemRole: null, userId: user.id })
  })

  it("accepts a parent that belongs to the same user", async () => {
    const user = await registry.makeUser()
    const parent = await createNode(user.id, { kind: "INVESTMENT", name: "Portfolio" })
    const child = await createNode(user.id, { kind: "INVESTMENT", name: "Fund", parentId: parent.id })
    expect(child.parentId).toBe(parent.id)
    expect((await updateNode(user.id, child.id, { parentId: null })).parentId).toBeNull()
  })

  it("updateNode and deleteNode throw not-found for an id that does not exist", async () => {
    const user = await registry.makeUser()
    await expect(updateNode(user.id, "no-such-node", { name: "x" })).rejects.toBeInstanceOf(NotFoundError)
    await expect(deleteNode(user.id, "no-such-node")).rejects.toBeInstanceOf(NotFoundError)
  })

  it("deletes a node with no transactions", async () => {
    const user = await registry.makeUser()
    const node = await createNode(user.id, { kind: "EXPENSE", name: "Gym" })
    await deleteNode(user.id, node.id)
    expect(await findNodeById(user.id, node.id)).toBeNull()
  })

  it("counts transactions on either side, soft-deleted ones included", async () => {
    const user = await registry.makeUser()
    const bank = await registry.makeNode(user.id, "ASSET", "Bank")
    const food = await registry.makeNode(user.id, "EXPENSE", "Food")
    const salary = await registry.makeNode(user.id, "INCOME_SOURCE", "Salary")
    expect(await countTransactionsForNode(user.id, bank.id)).toBe(0)
    await registry.makeTransaction(user.id, bank.id, food.id)
    await registry.makeTransaction(user.id, salary.id, bank.id)
    await registry.makeTransaction(user.id, salary.id, bank.id, { deletedAt: new Date() })
    expect(await countTransactionsForNode(user.id, bank.id)).toBe(3)
    expect(await countTransactionsForNode(user.id, food.id)).toBe(1)
    // and the database indeed refuses to delete a node that any row references
    await expect(prisma.ledgerNode.delete({ where: { id: bank.id } })).rejects.toThrow()
  })
})
