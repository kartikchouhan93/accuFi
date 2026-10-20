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
// revalidatePath needs a request to belong to; here it is replaced by a spy so a test can say which pages a write invalidates.
const { revalidatePath } = vi.hoisted(() => ({ revalidatePath: vi.fn() }))
vi.mock("next/cache", () => ({ revalidatePath }))

const actions = await import("@/app/transactions/actions")

const registry = createRegistry()
afterAll(registry.cleanup)
beforeEach(() => {
  requireUserId.mockReset()
  revalidatePath.mockReset()
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
    expect(result).toMatchObject({ ok: false, error: { code: "invalid", message: "Money cannot flow from an account to an income source." } })
  })

  it("reports a blocked overdraft as a result", async () => {
    const { bank, input } = await signedInWorld(100_00n)
    await prisma.ledgerNode.update({ where: { id: bank.id }, data: { blockNegative: true } })
    const result = await actions.recordTransactionAction(input({ amount: "150" }))
    expect(result).toMatchObject({ ok: false, error: { code: "overdraft_blocked" } })
  })

  it("files an archived source under the source field and an archived target under the destination, so the right control is flagged", async () => {
    const { user, bank, food, input } = await signedInWorld()
    const old = await registry.makeNode(user.id, "ASSET", "Old account")
    await prisma.ledgerNode.update({ where: { id: old.id }, data: { archivedAt: new Date() } })
    const fromArchived = await actions.recordTransactionAction(input({ fromNodeId: old.id, toNodeId: food.id }))
    expect(fromArchived).toMatchObject({ ok: false, error: { code: "invalid", fieldErrors: { fromNodeId: ["The source node is archived."] } } })
    expect(!fromArchived.ok && Object.keys(fromArchived.error.fieldErrors ?? {})).toEqual(["fromNodeId"])
    const toArchived = await actions.recordTransactionAction(input({ fromNodeId: bank.id, toNodeId: old.id }))
    expect(toArchived).toMatchObject({ ok: false, error: { code: "invalid", fieldErrors: { toNodeId: ["The target node is archived."] } } })
    expect(!toArchived.ok && Object.keys(toArchived.error.fieldErrors ?? {})).toEqual(["toNodeId"])
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

describe("cache invalidation", () => {
  const revalidated = () => revalidatePath.mock.calls.map(([path]) => path).sort()

  it("invalidates the transaction list, the ledger and the home page after every write that succeeds", async () => {
    const { bank, food, input } = await signedInWorld()
    const writes: [string, () => Promise<unknown>][] = [
      ["record", () => actions.recordTransactionAction(input())],
      [
        "split",
        () =>
          actions.recordSplitAction({
            fromNodeId: bank.id,
            occurredAt: "2026-04-01",
            legs: [
              { toNodeId: food.id, amount: "10" },
              { toNodeId: food.id, amount: "20" },
            ],
            total: "30",
            idempotencyKey: randomUUID(),
          }),
      ],
    ]
    for (const [name, write] of writes) {
      revalidatePath.mockReset()
      expect(await write(), name).toMatchObject({ ok: true })
      expect(revalidated(), name).toEqual(["/", "/nodes", "/transactions"])
    }
    const recorded = await actions.recordTransactionAction(input())
    if (!recorded.ok) throw new Error("setup failed")
    const follow: [string, () => Promise<unknown>][] = [
      ["edit", () => actions.editTransactionAction({ id: recorded.data.id, expectedVersion: 0, changes: { note: "x" } })],
      ["remove", () => actions.removeTransactionAction({ id: recorded.data.id })],
      ["restore", () => actions.restoreTransactionAction({ id: recorded.data.id })],
      ["ungroup", () => actions.ungroupTransactionAction({ id: recorded.data.id })],
    ]
    for (const [name, write] of follow) {
      revalidatePath.mockReset()
      expect(await write(), name).toMatchObject({ ok: true })
      expect(revalidated(), name).toEqual(["/", "/nodes", "/transactions"])
    }
  })

  it("invalidates nothing when the write was refused, and nothing for a read", async () => {
    const { bank, income, input } = await signedInWorld()
    await actions.recordTransactionAction(input({ fromNodeId: bank.id, toNodeId: income.id })) // illegal flow
    await actions.recordTransactionAction(input({ amount: "0" })) // invalid input
    await actions.removeTransactionAction({ id: "no-such-transaction" }) // not found
    expect(revalidatePath).not.toHaveBeenCalled()
    expect(await actions.listTransactionsAction({})).toMatchObject({ ok: true })
    expect(revalidatePath).not.toHaveBeenCalled()
  })
})

describe("recordSplitAction", () => {
  async function splitWorld() {
    const world = await signedInWorld(10_000_00n)
    const clothes = await registry.makeNode(world.user.id, "EXPENSE", "Clothes")
    const body = (over: Record<string, unknown> = {}) => ({
      fromNodeId: world.bank.id,
      occurredAt: "2026-04-01",
      legs: [
        { toNodeId: world.food.id, amount: "60" },
        { toNodeId: clothes.id, amount: "40" },
      ],
      total: "100",
      idempotencyKey: randomUUID(),
      ...over,
    })
    return { ...world, clothes, body }
  }

  it("records the legs for the signed-in user and returns plain data", async () => {
    const { user, body } = await splitWorld()
    const result = await actions.recordSplitAction(body({ tags: ["trip"] }))
    expect(result).toMatchObject({ ok: true, data: { legs: [{ amountPaise: "6000" }, { amountPaise: "4000" }] } })
    expectNoBigint(result)
    expect(await prisma.transaction.count({ where: { userId: user.id, groupId: { not: null } } })).toBe(2)
  })

  it("will not take a split without a total: the legs-add-up check always runs", async () => {
    const { user, body } = await splitWorld()
    const withoutTotal = Object.fromEntries(Object.entries(body()).filter(([field]) => field !== "total"))
    const result = await actions.recordSplitAction(withoutTotal)
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_input", fieldErrors: { total: expect.any(Array) } } })
    expect(await prisma.transaction.count({ where: { userId: user.id, groupId: { not: null } } })).toBe(0)
  })

  it("answers legs that do not add up as an error on the total, and writes nothing", async () => {
    const { user, body } = await splitWorld()
    const result = await actions.recordSplitAction(body({ total: "120" }))
    expect(result).toEqual({
      ok: false,
      error: {
        code: "invalid",
        message: "The legs add up to ₹100.00 but the total is ₹120.00.",
        fieldErrors: { total: ["The legs add up to ₹100.00 but the total is ₹120.00."] },
      },
    })
    expect(await prisma.transaction.count({ where: { userId: user.id, groupId: { not: null } } })).toBe(0)
  })

  it("files a leg's violation under that leg, by index, without reading the message", async () => {
    const { bank, income, food, user, body } = await splitWorld()
    const result = await actions.recordSplitAction(
      body({
        legs: [
          { toNodeId: food.id, amount: "50" },
          { toNodeId: income.id, amount: "30" }, // an income source is never a destination
          { toNodeId: bank.id, amount: "20" }, // the source itself
        ],
      }),
    )
    expect(result).toMatchObject({ ok: false, error: { code: "invalid", fieldErrors: { "legs.1.toNodeId": [expect.stringContaining("an income source")], "legs.2.toNodeId": [expect.stringContaining("itself")] } } })
    expect(!result.ok && Object.keys(result.error.fieldErrors ?? {}).sort()).toEqual(["legs.1.toNodeId", "legs.2.toNodeId"])
    expect(await prisma.transaction.count({ where: { userId: user.id, groupId: { not: null } } })).toBe(0)
  })

  it("flags an archived source of a split once, on the source field, whatever the number of legs", async () => {
    const { user, food, clothes, body } = await splitWorld()
    const old = await registry.makeNode(user.id, "ASSET", "Old account")
    await prisma.ledgerNode.update({ where: { id: old.id }, data: { archivedAt: new Date() } })
    const legs = [
      { toNodeId: food.id, amount: "60" },
      { toNodeId: clothes.id, amount: "40" },
    ]
    const result = await actions.recordSplitAction(body({ fromNodeId: old.id, legs }))
    expect(result).toEqual({
      ok: false,
      error: { code: "invalid", message: "The source node is archived.", fieldErrors: { fromNodeId: ["The source node is archived."] } },
    })
  })

  it("reports the warnings once, not once per leg", async () => {
    const { food, clothes, bank, user } = await splitWorld()
    await prisma.transaction.create({
      data: { userId: user.id, fromNodeId: bank.id, toNodeId: food.id, amountPaise: 9_950_00n, occurredAt: new Date(Date.UTC(2026, 3, 1)) },
    }) // leaves 50.00, so a split of 100.00 overdraws the account
    const result = await actions.recordSplitAction({
      fromNodeId: bank.id,
      occurredAt: "2026-04-01",
      legs: [
        { toNodeId: food.id, amount: "60" },
        { toNodeId: clothes.id, amount: "40" },
      ],
      total: "100",
      idempotencyKey: randomUUID(),
    })
    expect(result.ok && result.data.warnings.map((w) => w.code)).toEqual(["OVERDRAWN"])
    expect(result.ok && result.data.legs.every((leg) => leg.warnings.length === 0)).toBe(true)
  })

  it("answers a blocked overdraft on the whole split as a result", async () => {
    const { bank, food, clothes, body } = await splitWorld()
    await prisma.ledgerNode.update({ where: { id: bank.id }, data: { blockNegative: true } })
    // Each leg fits in the 10,000 the account holds; together they do not.
    const legs = [
      { toNodeId: food.id, amount: "6,000" },
      { toNodeId: clothes.id, amount: "5,000" },
    ]
    expect(await actions.recordSplitAction(body({ legs, total: "11,000" }))).toMatchObject({ ok: false, error: { code: "overdraft_blocked" } })
  })

  it("answers a replay with the stored legs and writes nothing more", async () => {
    const { user, body } = await splitWorld()
    const request = body()
    const first = await actions.recordSplitAction(request)
    const again = await actions.recordSplitAction(request)
    expect(first.ok && again.ok && again.data.legs.map((leg) => leg.id)).toEqual(first.ok && first.data.legs.map((leg) => leg.id))
    expect(await prisma.transaction.count({ where: { userId: user.id, groupId: { not: null } } })).toBe(2)
  })

  it("does not tell the user a request key was misused as raw text, because the earlier request may have succeeded", async () => {
    const { clothes, food, body } = await splitWorld()
    const key = randomUUID()
    const first = await actions.recordSplitAction(body({ idempotencyKey: key }))
    expect(first.ok).toBe(true)
    // The same key, a different request: what a user sends after taking a leg out of the split and pressing the button again.
    const second = await actions.recordSplitAction(
      body({
        idempotencyKey: key,
        legs: [
          { toNodeId: food.id, amount: "30" },
          { toNodeId: clothes.id, amount: "30" },
          { toNodeId: food.id, amount: "40" },
        ],
      }),
    )
    expect(second).toMatchObject({ ok: false, error: { code: "request_conflict" } })
    const message = !second.ok ? second.error.message : ""
    expect(message).not.toContain("request key")
    expect(message).toContain("check the list")
  })
})

describe("ungroupTransactionAction", () => {
  it("takes a leg out of its split and answers with the leg as plain data", async () => {
    const world = await signedInWorld(10_000_00n)
    const clothes = await registry.makeNode(world.user.id, "EXPENSE", "Clothes")
    const split = await actions.recordSplitAction({
      fromNodeId: world.bank.id,
      occurredAt: "2026-04-01",
      legs: [
        { toNodeId: world.food.id, amount: "60" },
        { toNodeId: clothes.id, amount: "40" },
      ],
      total: "100",
      idempotencyKey: randomUUID(),
    })
    if (!split.ok) throw new Error("setup failed")
    const result = await actions.ungroupTransactionAction({ id: split.data.legs[0].id })
    expect(result).toMatchObject({ ok: true, data: { id: split.data.legs[0].id, groupId: null } })
    expectNoBigint(result)
    expect(await actions.ungroupTransactionAction({ id: "no-such-transaction" })).toMatchObject({ ok: false, error: { code: "not_found" } })
  })
})

describe("listTransactionsAction", () => {
  it("answers a page of entries for the filters it is given, and refuses a cursor it did not issue", async () => {
    const { user, bank, food } = await signedInWorld()
    for (let day = 1; day <= 3; day++) {
      await registry.makeTransaction(user.id, bank.id, food.id, { occurredAt: `2026-05-0${day}`, note: `May ${day}` })
    }
    const result = await actions.listTransactionsAction({ from: "2026-05-01", to: "2026-05-02", q: "may" })
    expect(result.ok && result.data.entries.map((entry) => (entry.kind === "single" ? entry.transaction.note : null))).toEqual(["May 2", "May 1"])
    expectNoBigint(result)
    expect(await actions.listTransactionsAction({ cursor: "not-a-cursor" })).toMatchObject({ ok: false, error: { code: "invalid" } })
    expect(await actions.listTransactionsAction({ from: "2026-02-30" })).toMatchObject({ ok: false, error: { code: "invalid_input" } })
    expect(await actions.listTransactionsAction({ userId: "someone-else" })).toMatchObject({ ok: false, error: { code: "invalid_input" } })
  })
})
