import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { prisma } from "@/server/db"
import { seedAccountNodes } from "@/server/services/account-seed"
import { createRegistry } from "./repositories/fixtures"

// Replace the session: what these tests care about is what each action does with the answer requireUserId gives
// (a user id, or UnauthenticatedError), not Auth.js itself.
const { requireUserId, UnauthenticatedError } = vi.hoisted(() => {
  class UnauthenticatedError extends Error {}
  return { requireUserId: vi.fn(), UnauthenticatedError }
})
vi.mock("@/server/auth", () => ({ requireUserId, UnauthenticatedError }))
// revalidatePath needs a request to belong to; here it is replaced by a spy so a test can say which pages a write invalidates.
const { revalidatePath } = vi.hoisted(() => ({ revalidatePath: vi.fn() }))
vi.mock("next/cache", () => ({ revalidatePath }))

const actions = await import("@/app/nodes/actions")
const nodeService = await import("@/server/services/node-service")

const registry = createRegistry()
afterAll(registry.cleanup)
beforeEach(() => {
  requireUserId.mockReset()
  revalidatePath.mockReset()
})
afterEach(() => vi.restoreAllMocks())

async function signedInSeededUser() {
  const user = await registry.makeUser()
  await prisma.$transaction((tx) => seedAccountNodes(tx, user.id))
  requireUserId.mockResolvedValue(user.id)
  return user
}

async function signedInUser() {
  const user = await registry.makeUser()
  requireUserId.mockResolvedValue(user.id)
  return user
}

const bankInput = { kind: "ASSET", name: "HDFC Savings", assetSubtype: "SAVINGS" }

// Server Actions are the boundary: their return value is serialised to the browser, and JSON.stringify throws on bigint.
function expectNoBigint(value: unknown) {
  expect(() => JSON.stringify(value)).not.toThrow()
}

async function redirectTarget(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run()
  } catch (error) {
    const digest = (error as { digest?: unknown }).digest
    if (typeof digest === "string" && digest.startsWith("NEXT_REDIRECT;")) return digest.split(";")[2]
    throw error
  }
  return null
}

describe("every Server Action", () => {
  it("sends the user to /login, before reading its input, when the session is gone", async () => {
    const exported = Object.entries(actions)
    expect(exported.length).toBeGreaterThan(0)
    for (const [name, action] of exported) {
      requireUserId.mockReset()
      requireUserId.mockImplementation(async () => {
        throw new UnauthenticatedError()
      })
      // Garbage on purpose: if an action parsed its input before asking who is calling, it would answer "invalid
      // input" instead of redirecting.
      const target = await redirectTarget(() => (action as (input: unknown) => Promise<unknown>)(undefined))
      expect(target, name).toBe("/login")
      expect(requireUserId, name).toHaveBeenCalledTimes(1)
    }
  })

  it("does not swallow an error that is not an authentication failure", async () => {
    requireUserId.mockImplementation(async () => {
      throw new Error("auth backend down")
    })
    for (const [name, action] of Object.entries(actions)) {
      await expect((action as (input: unknown) => Promise<unknown>)({}), name).rejects.toThrow("auth backend down")
    }
  })
})

describe("createNodeAction", () => {
  it("creates a node for the signed-in user and returns a result with no bigint in it", async () => {
    const user = await signedInSeededUser()
    const result = await actions.createNodeAction({ ...bankInput, openingBalance: "1,234.50" })
    expect(result).toMatchObject({ ok: true, data: { duplicateName: false, node: { kind: "ASSET", name: "HDFC Savings" } } })
    expectNoBigint(result)
    const row = await prisma.transaction.findFirstOrThrow({ where: { userId: user.id } })
    expect(row.amountPaise).toBe(123_450n)
  })

  it("stores the overdraft guard when it is asked for, and leaves it off otherwise", async () => {
    await signedInSeededUser()
    const guarded = await actions.createNodeAction({ ...bankInput, blockNegative: true })
    expect(guarded).toMatchObject({ ok: true, data: { node: { blockNegative: true } } })
    const plain = await actions.createNodeAction({ ...bankInput, name: "Plain" })
    expect(plain).toMatchObject({ ok: true, data: { node: { blockNegative: false } } })
    const stored = await prisma.ledgerNode.findFirstOrThrow({ where: { id: guarded.ok ? guarded.data.node.id : "" } })
    expect(stored.blockNegative).toBe(true)
  })

  it("refuses the guard on a kind that cannot be overdrawn", async () => {
    await signedInSeededUser()
    expect(await actions.createNodeAction({ kind: "EXPENSE", name: "Food", blockNegative: true })).toMatchObject({
      ok: false,
      error: { code: "invalid_input" },
    })
  })

  it("posts a negative opening balance as node -> contra, so a card you owe on starts negative", async () => {
    const user = await signedInSeededUser()
    const result = await actions.createNodeAction({
      kind: "LIABILITY",
      name: "Card",
      liabilitySubtype: "CREDIT_CARD",
      openingBalance: "-5,000",
    })
    expect(result.ok).toBe(true)
    const contra = await prisma.ledgerNode.findFirstOrThrow({ where: { userId: user.id, systemRole: "OPENING_BALANCE_CONTRA" } })
    const row = await prisma.transaction.findFirstOrThrow({ where: { userId: user.id } })
    expect(row).toMatchObject({ toNodeId: contra.id, amountPaise: 500_000n })
  })

  it("serialises a liability's credit limit as a paise string", async () => {
    await signedInUser()
    const result = await actions.createNodeAction({
      kind: "LIABILITY",
      name: "Card",
      liabilitySubtype: "CREDIT_CARD",
      creditLimit: "2,00,000",
    })
    expect(result).toMatchObject({ ok: true, data: { node: { creditLimitPaise: "20000000" } } })
    expectNoBigint(result)
  })

  it("takes the owner from the session, never from the input", async () => {
    const user = await signedInUser()
    const other = await registry.makeUser()
    const result = await actions.createNodeAction({ ...bankInput, userId: other.id })
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_input" } })
    expect(await prisma.ledgerNode.count({ where: { userId: { in: [user.id, other.id] } } })).toBe(0)
  })

  it("returns field errors for invalid input and writes nothing", async () => {
    const user = await signedInUser()
    const result = await actions.createNodeAction({ kind: "ASSET", name: "Bank", openingBalance: "12.345" })
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_input" } })
    expect(result.ok === false && result.error.fieldErrors).toHaveProperty("assetSubtype")
    expect(result.ok === false && result.error.fieldErrors).toHaveProperty("openingBalance")
    expect(await prisma.ledgerNode.count({ where: { userId: user.id } })).toBe(0)
  })

  it("warns about a duplicate name without blocking it", async () => {
    // EC-35
    const user = await signedInUser()
    await actions.createNodeAction(bankInput)
    const second = await actions.createNodeAction(bankInput)
    expect(second).toMatchObject({ ok: true, data: { duplicateName: true } })
    expect(await prisma.ledgerNode.count({ where: { userId: user.id } })).toBe(2)
  })

  it("reports a hierarchy violation as a result, not an exception", async () => {
    await signedInUser()
    const food = await actions.createNodeAction({ kind: "EXPENSE", name: "Food" })
    const lunch = await actions.createNodeAction({
      kind: "EXPENSE",
      name: "Lunch",
      parentId: food.ok ? food.data.node.id : "",
    })
    const nested = await actions.createNodeAction({
      kind: "EXPENSE",
      name: "Office lunch",
      parentId: lunch.ok ? lunch.data.node.id : "",
    })
    expect(nested).toMatchObject({ ok: false, error: { code: "hierarchy_depth" } })
  })
})

describe("renameNodeAction", () => {
  it("renames and warns about a duplicate, not counting the node itself", async () => {
    await signedInUser()
    const created = await actions.createNodeAction(bankInput)
    const id = created.ok ? created.data.node.id : ""
    expect(await actions.renameNodeAction({ nodeId: id, name: "HDFC Savings" })).toMatchObject({
      ok: true,
      data: { duplicateName: false },
    })
    await actions.createNodeAction({ ...bankInput, name: "ICICI" })
    const renamed = await actions.renameNodeAction({ nodeId: id, name: "icici" })
    expect(renamed).toMatchObject({ ok: true, data: { duplicateName: true, node: { name: "icici" } } })
    expectNoBigint(renamed)
  })

  it("refuses to rename a system node", async () => {
    const user = await signedInSeededUser()
    const opening = await prisma.ledgerNode.findFirstOrThrow({ where: { userId: user.id, systemRole: "OPENING_BALANCE" } })
    expect(await actions.renameNodeAction({ nodeId: opening.id, name: "Mine" })).toMatchObject({
      ok: false,
      error: { code: "system_node" },
    })
  })

  it("answers kind_immutable, not an unmasked error, if the service refuses a kind change", async () => {
    // Unreachable through this action today (the schema is strict); reachable once an edit form exists.
    await signedInUser()
    const created = await actions.createNodeAction(bankInput)
    vi.spyOn(nodeService, "renameLedgerNode").mockRejectedValueOnce(new nodeService.NodeKindChangeError())
    expect(await actions.renameNodeAction({ nodeId: created.ok ? created.data.node.id : "", name: "X" })).toMatchObject({
      ok: false,
      error: { code: "kind_immutable" },
    })
  })

  it("rejects a payload that tries to carry a kind", async () => {
    await signedInUser()
    const created = await actions.createNodeAction(bankInput)
    const result = await actions.renameNodeAction({ nodeId: created.ok ? created.data.node.id : "", name: "X", kind: "EXPENSE" })
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_input" } })
  })

  it("answers not_found for another user's node", async () => {
    await signedInUser()
    const theirs = await registry.makeUser()
    const node = await prisma.ledgerNode.create({ data: { userId: theirs.id, kind: "ASSET", name: "Theirs" } })
    expect(await actions.renameNodeAction({ nodeId: node.id, name: "Mine" })).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    })
    expect((await prisma.ledgerNode.findUniqueOrThrow({ where: { id: node.id } })).name).toBe("Theirs")
  })
})

describe("archiveNodeAction, restoreNodeAction and removeNodeAction", () => {
  it("archives with the residual as a string, restores, and removes", async () => {
    await signedInSeededUser()
    const created = await actions.createNodeAction({ ...bankInput, openingBalance: "500" })
    const id = created.ok ? created.data.node.id : ""

    const archived = await actions.archiveNodeAction({ nodeId: id })
    expect(archived).toMatchObject({ ok: true, data: { residualBalance: "50000", node: { id } } })
    expect(archived.ok && archived.data.node.archivedAt).toEqual(expect.any(String))
    expectNoBigint(archived)

    const restored = await actions.restoreNodeAction({ nodeId: id })
    expect(restored).toMatchObject({ ok: true, data: { node: { id, archivedAt: null } } })
    expectNoBigint(restored)

    const empty = await actions.createNodeAction({ kind: "EXPENSE", name: "Scratch" })
    const removed = await actions.removeNodeAction({ nodeId: empty.ok ? empty.data.node.id : "" })
    expect(removed).toEqual({ ok: true, data: null })
    expectNoBigint(removed)
  })

  it("tells the screen what archiving would leave behind, as of today, without archiving", async () => {
    const user = await signedInSeededUser()
    const created = await actions.createNodeAction({ ...bankInput, openingBalance: "500" })
    const id = created.ok ? created.data.node.id : ""
    const salary = await registry.makeNode(user.id, "INCOME_SOURCE", "Salary")
    await registry.makeTransaction(user.id, salary.id, id, { amountPaise: 9_999_00n, occurredAt: "2099-01-01" })

    const residual = await actions.archiveResidualAction({ nodeId: id })
    expect(residual).toEqual({ ok: true, data: { residualBalance: "50000" } })
    expectNoBigint(residual)
    expect((await prisma.ledgerNode.findUniqueOrThrow({ where: { id } })).archivedAt).toBeNull()
    // The figure it gives is the figure archiving reports.
    expect(await actions.archiveNodeAction({ nodeId: id })).toMatchObject({ ok: true, data: { residualBalance: "50000" } })
  })

  it("answers has_history, not an exception, for a node with transactions", async () => {
    // NodeHasHistoryError, EC-33
    await signedInSeededUser()
    const created = await actions.createNodeAction({ ...bankInput, openingBalance: "500" })
    const result = await actions.removeNodeAction({ nodeId: created.ok ? created.data.node.id : "" })
    expect(result).toMatchObject({ ok: false, error: { code: "has_history" } })
    expect(result.ok === false && result.error.message).toMatch(/archive/i)
  })

  it("refuses to archive or remove a system node", async () => {
    const user = await signedInSeededUser()
    const opening = await prisma.ledgerNode.findFirstOrThrow({ where: { userId: user.id, systemRole: "OPENING_BALANCE" } })
    expect(await actions.archiveNodeAction({ nodeId: opening.id })).toMatchObject({ ok: false, error: { code: "system_node" } })
    expect(await actions.archiveResidualAction({ nodeId: opening.id })).toMatchObject({ ok: false, error: { code: "system_node" } })
    expect(await actions.removeNodeAction({ nodeId: opening.id })).toMatchObject({ ok: false, error: { code: "system_node" } })
  })

  it("rejects a malformed payload", async () => {
    await signedInUser()
    for (const action of [actions.archiveNodeAction, actions.archiveResidualAction, actions.restoreNodeAction, actions.removeNodeAction]) {
      expect(await action({ nodeId: "" })).toMatchObject({ ok: false, error: { code: "invalid_input" } })
      expect(await action("not-an-object")).toMatchObject({ ok: false, error: { code: "invalid_input" } })
    }
  })
})

describe("cache invalidation", () => {
  const revalidated = () => revalidatePath.mock.calls.map(([path]) => path).sort()
  const everywhere = ["/", "/investments", "/investments/prices", "/nodes", "/transactions"]

  // A node write changes what other screens show: net worth on "/" and the balances and pickers on "/transactions" move
  // with an opening balance, an archive or a rename. router.refresh() renews only the page the user is on.
  it("invalidates the ledger, the transaction screen and the home page after every write that succeeds", async () => {
    await signedInSeededUser()
    const created = await actions.createNodeAction({ ...bankInput, openingBalance: "500" })
    expect(created.ok).toBe(true)
    expect(revalidated()).toEqual(everywhere)
    const id = created.ok ? created.data.node.id : ""
    const scratch = await actions.createNodeAction({ kind: "EXPENSE", name: "Scratch" })
    const scratchId = scratch.ok ? scratch.data.node.id : ""

    const writes: [string, () => Promise<unknown>][] = [
      ["rename", () => actions.renameNodeAction({ nodeId: id, name: "HDFC Current" })],
      ["archive", () => actions.archiveNodeAction({ nodeId: id })],
      ["restore", () => actions.restoreNodeAction({ nodeId: id })],
      ["remove", () => actions.removeNodeAction({ nodeId: scratchId })],
    ]
    for (const [name, write] of writes) {
      revalidatePath.mockReset()
      expect(await write(), name).toMatchObject({ ok: true })
      expect(revalidated(), name).toEqual(everywhere)
    }
  })

  it("invalidates nothing when the write was refused, and nothing for a read", async () => {
    const user = await signedInSeededUser()
    const opening = await prisma.ledgerNode.findFirstOrThrow({ where: { userId: user.id, systemRole: "OPENING_BALANCE" } })
    const created = await actions.createNodeAction({ ...bankInput, openingBalance: "500" })
    const id = created.ok ? created.data.node.id : ""
    revalidatePath.mockReset()

    await actions.createNodeAction({ kind: "ASSET", name: "" }) // invalid input
    await actions.renameNodeAction({ nodeId: opening.id, name: "Mine" }) // system node
    await actions.removeNodeAction({ nodeId: id }) // has history
    await actions.archiveNodeAction({ nodeId: "no-such-node" }) // not found
    expect(revalidatePath).not.toHaveBeenCalled()
    expect(await actions.archiveResidualAction({ nodeId: id })).toMatchObject({ ok: true })
    expect(revalidatePath).not.toHaveBeenCalled()
  })
})
