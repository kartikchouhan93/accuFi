import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { prisma } from "@/server/db"
import { createRegistry } from "../repositories/fixtures"

// A ledger a budget names is not deleted (design §6): the refusal comes before the delete, and archiving is the way out.

const { requireUserId, UnauthenticatedError } = vi.hoisted(() => {
  class UnauthenticatedError extends Error {}
  return { requireUserId: vi.fn(), UnauthenticatedError }
})
vi.mock("@/server/auth", () => ({ requireUserId, UnauthenticatedError }))
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))

const actions = await import("@/app/nodes/actions")
const { archiveLedgerNode, NodeInBudgetError, removeLedgerNode } = await import("@/server/services/node-service")

const registry = createRegistry()
afterAll(registry.cleanup)
beforeEach(() => requireUserId.mockReset())
afterEach(() => vi.restoreAllMocks())

const MESSAGE = "A budget uses this ledger. Delete the budget, or archive the ledger instead."

async function world() {
  const user = await registry.makeUser()
  requireUserId.mockResolvedValue(user.id)
  const food = await registry.makeNode(user.id, "EXPENSE", "Food")
  return { user, food }
}

describe("deleting a ledger a budget names", () => {
  it("is refused by the service with the exact message, and the budget stays", async () => {
    const { user, food } = await world()
    const budget = await registry.makeBudget(user.id, food.id)
    await expect(removeLedgerNode(user.id, food.id)).rejects.toThrow(NodeInBudgetError)
    await expect(removeLedgerNode(user.id, food.id)).rejects.toThrow(MESSAGE)
    expect(await prisma.budget.count({ where: { id: budget.id } })).toBe(1)
    expect(await prisma.ledgerNode.count({ where: { id: food.id } })).toBe(1)
  })

  it("answers a refusal, not an exception, through the node action", async () => {
    const { user, food } = await world()
    const budget = await registry.makeBudget(user.id, food.id)
    const result = await actions.removeNodeAction({ nodeId: food.id })
    expect(result).toEqual({ ok: false, error: { code: "invalid", message: MESSAGE } })
    expect(await prisma.budget.count({ where: { id: budget.id } })).toBe(1)
  })

  it("still refuses when the budget has ended", async () => {
    const { user, food } = await world()
    await registry.makeBudget(user.id, food.id, { startMonth: "2025-01-01", endMonth: "2025-03-01" })
    await expect(removeLedgerNode(user.id, food.id)).rejects.toThrow(NodeInBudgetError)
  })

  it("is allowed once the budget is deleted", async () => {
    const { user, food } = await world()
    const budget = await registry.makeBudget(user.id, food.id)
    await prisma.budget.delete({ where: { id: budget.id } })
    await removeLedgerNode(user.id, food.id)
    expect(await prisma.ledgerNode.count({ where: { id: food.id } })).toBe(0)
  })

  it("is allowed for a ledger with no budget", async () => {
    const { user, food } = await world()
    await registry.makeBudget(user.id, (await registry.makeNode(user.id, "EXPENSE", "Fun")).id)
    await removeLedgerNode(user.id, food.id)
    expect(await prisma.ledgerNode.count({ where: { id: food.id } })).toBe(0)
  })

  it("is not blocked by another user's budget on a same-named ledger", async () => {
    const { user, food } = await world()
    const other = await registry.makeUser()
    const theirFood = await registry.makeNode(other.id, "EXPENSE", "Food")
    await registry.makeBudget(other.id, theirFood.id)
    await removeLedgerNode(user.id, food.id)
    expect(await prisma.ledgerNode.count({ where: { id: food.id } })).toBe(0)
    expect(await prisma.ledgerNode.count({ where: { id: theirFood.id } })).toBe(1)
  })

  it("checks history and recurring rules first, so their refusals keep their own wording", async () => {
    const { user, food } = await world()
    const bank = await registry.makeNode(user.id, "ASSET", "Bank")
    await registry.makeBudget(user.id, food.id)
    await registry.makeTransaction(user.id, bank.id, food.id, { amountPaise: 100n })
    await expect(removeLedgerNode(user.id, food.id)).rejects.toThrow(/has transactions/)
  })

  it("leaves archiving a budgeted ledger working", async () => {
    const { user, food } = await world()
    const budget = await registry.makeBudget(user.id, food.id)
    await archiveLedgerNode(user.id, food.id)
    expect((await prisma.ledgerNode.findUniqueOrThrow({ where: { id: food.id } })).archivedAt).not.toBeNull()
    expect(await prisma.budget.count({ where: { id: budget.id } })).toBe(1)
  })
})
