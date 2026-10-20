import { randomUUID } from "node:crypto"
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"
import { prisma } from "@/server/db"
import { createRegistry } from "./repositories/fixtures"

// Replace the session: what these tests care about is what each action does with the answer requireUserId gives
// (a user id, or UnauthenticatedError), not Auth.js itself.
const { requireUserId, UnauthenticatedError } = vi.hoisted(() => {
  class UnauthenticatedError extends Error {}
  return { requireUserId: vi.fn(), UnauthenticatedError }
})
vi.mock("@/server/auth", () => ({ requireUserId, UnauthenticatedError }))

const actions = await import("@/app/transactions/actions")

const registry = createRegistry()
afterAll(registry.cleanup)
beforeEach(() => {
  requireUserId.mockReset()
})

async function signedInWorld(opening = 1_000_00n) {
  const user = await registry.makeUser()
  requireUserId.mockResolvedValue(user.id)
  const income = await registry.makeNode(user.id, "INCOME_SOURCE", "Salary")
  const bank = await registry.makeNode(user.id, "ASSET", "Bank")
  const food = await registry.makeNode(user.id, "EXPENSE", "Food")
  await registry.makeTransaction(user.id, income.id, bank.id, { amountPaise: opening, occurredAt: "2026-01-01" })
  const input = (over: Record<string, unknown> = {}) => ({
    fromNodeId: bank.id,
    toNodeId: food.id,
    amount: "300",
    occurredAt: "2026-04-01",
    idempotencyKey: randomUUID(),
    ...over,
  })
  return { user, income, bank, food, input }
}

// Server Actions are the boundary: their return value is serialised to the browser, and JSON.stringify throws on bigint.
const expectNoBigint = (value: unknown) => expect(() => JSON.stringify(value)).not.toThrow()

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

describe("recordTransactionAction", () => {
  it("parses rupee text, records for the signed-in user and returns a view with no bigint", async () => {
    const { user, input } = await signedInWorld(5_000_00n)
    const result = await actions.recordTransactionAction(input({ amount: "1,200.50", note: "lunch" }))
    expect(result).toMatchObject({ ok: true, data: { amountPaise: "120050", note: "lunch", occurredAt: "2026-04-01", warnings: [] } })
    expectNoBigint(result)
    expect(await prisma.transaction.count({ where: { userId: user.id } })).toBe(2)
  })

  it("returns warnings with the successful result", async () => {
    const { input } = await signedInWorld(100_00n)
    const result = await actions.recordTransactionAction(input({ amount: "150" }))
    expect(result.ok && result.data.warnings.map((w) => w.code)).toEqual(["OVERDRAWN"])
  })

  it("answers a replayed key with the first result", async () => {
    const { user, input } = await signedInWorld()
    const body = input()
    const first = await actions.recordTransactionAction(body)
    const second = await actions.recordTransactionAction({ ...body, amount: "999" })
    expect(first.ok && second.ok && second.data.id === first.data.id).toBe(true)
    expect(await prisma.transaction.count({ where: { userId: user.id } })).toBe(2)
  })

  it("takes the owner from the session, never from the input", async () => {
    const { user, input } = await signedInWorld()
    const other = await registry.makeUser()
    expect(await actions.recordTransactionAction(input({ userId: other.id }))).toMatchObject({ ok: false, error: { code: "invalid_input" } })
    expect(await prisma.transaction.count({ where: { userId: { in: [user.id, other.id] } } })).toBe(1)
  })

  it("returns field errors for invalid input, an empty idempotency key included, and writes nothing", async () => {
    const { user, input } = await signedInWorld()
    const result = await actions.recordTransactionAction(input({ amount: "0", occurredAt: "2026-02-30", idempotencyKey: "" }))
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_input" } })
    const fieldErrors = result.ok ? {} : result.error.fieldErrors
    expect(Object.keys(fieldErrors ?? {}).sort()).toEqual(["amount", "idempotencyKey", "occurredAt"])
    expect(await prisma.transaction.count({ where: { userId: user.id } })).toBe(1)
  })

  it("reports an illegal flow as a result carrying the domain's message", async () => {
    const { bank, income, input } = await signedInWorld()
    const result = await actions.recordTransactionAction(input({ fromNodeId: bank.id, toNodeId: income.id }))
    expect(result).toMatchObject({ ok: false, error: { code: "invalid", message: "Money cannot flow from ASSET to INCOME_SOURCE." } })
  })

  it("reports a blocked overdraft as a result", async () => {
    const { bank, input } = await signedInWorld(100_00n)
    await prisma.ledgerNode.update({ where: { id: bank.id }, data: { blockNegative: true } })
    const result = await actions.recordTransactionAction(input({ amount: "150" }))
    expect(result).toMatchObject({ ok: false, error: { code: "overdraft_blocked" } })
  })

  it("answers not-found for another user's node", async () => {
    const { input } = await signedInWorld()
    const other = await signedInWorld() // the session is now the other user; ids below are the first user's
    const result = await actions.recordTransactionAction({ ...other.input(), fromNodeId: input().fromNodeId })
    expect(result).toMatchObject({ ok: false, error: { code: "not_found" } })
  })
})

describe("editTransactionAction", () => {
  it("edits, bumps the version and returns plain data", async () => {
    const { input } = await signedInWorld()
    const created = await actions.recordTransactionAction(input())
    if (!created.ok) throw new Error("setup failed")
    const result = await actions.editTransactionAction({
      id: created.data.id,
      expectedVersion: created.data.version,
      changes: { amount: "400", note: null },
    })
    expect(result).toMatchObject({ ok: true, data: { amountPaise: "40000", note: null, version: 1 } })
    expectNoBigint(result)
  })

  it("answers version_conflict with the current row as plain data, so a screen can show both versions", async () => {
    const { input } = await signedInWorld()
    const created = await actions.recordTransactionAction(input({ note: "original" }))
    if (!created.ok) throw new Error("setup failed")
    const body = { id: created.data.id, expectedVersion: created.data.version }
    await actions.editTransactionAction({ ...body, changes: { note: "tab one", amount: "250" } })
    const result = await actions.editTransactionAction({ ...body, changes: { note: "tab two" } })
    expect(result).toMatchObject({
      ok: false,
      error: { code: "version_conflict", current: { id: created.data.id, version: 1, note: "tab one", amountPaise: "25000" } },
    })
    expectNoBigint(result) // the repository's error carries a bigint and Date fields; none may reach here
  })

  it("answers not-found for an unknown or another user's transaction", async () => {
    const mine = await signedInWorld()
    const created = await actions.recordTransactionAction(mine.input())
    await signedInWorld() // a different user is now signed in
    if (!created.ok) throw new Error("setup failed")
    expect(await actions.editTransactionAction({ id: created.data.id, expectedVersion: 0, changes: { note: "x" } })).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    })
  })

  it("rejects an edit with no version or no changes as invalid input", async () => {
    await signedInWorld()
    expect(await actions.editTransactionAction({ id: "t", changes: { note: "x" } })).toMatchObject({ ok: false, error: { code: "invalid_input" } })
    expect(await actions.editTransactionAction({ id: "t", expectedVersion: 0, changes: {} })).toMatchObject({
      ok: false,
      error: { code: "invalid_input" },
    })
  })
})

describe("removeTransactionAction and restoreTransactionAction", () => {
  it("removes and restores, returning plain data", async () => {
    const { user, input } = await signedInWorld()
    const created = await actions.recordTransactionAction(input())
    if (!created.ok) throw new Error("setup failed")
    expect(await actions.removeTransactionAction({ id: created.data.id })).toEqual({ ok: true, data: null })
    expect((await prisma.transaction.findUniqueOrThrow({ where: { id: created.data.id } })).deletedAt).not.toBeNull()
    const restored = await actions.restoreTransactionAction({ id: created.data.id })
    expect(restored).toMatchObject({ ok: true, data: { id: created.data.id, amountPaise: "30000" } })
    expectNoBigint(restored)
    expect(await prisma.transaction.count({ where: { userId: user.id, deletedAt: null } })).toBe(2)
  })

  it("answers not-found for a second removal, and rejects a payload carrying a userId", async () => {
    const { input } = await signedInWorld()
    const created = await actions.recordTransactionAction(input())
    if (!created.ok) throw new Error("setup failed")
    await actions.removeTransactionAction({ id: created.data.id })
    expect(await actions.removeTransactionAction({ id: created.data.id })).toMatchObject({ ok: false, error: { code: "not_found" } })
    expect(await actions.restoreTransactionAction({ id: created.data.id, userId: "x" })).toMatchObject({
      ok: false,
      error: { code: "invalid_input" },
    })
  })
})
