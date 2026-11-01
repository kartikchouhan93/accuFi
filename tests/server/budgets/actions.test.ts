import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { prisma } from "@/server/db"
import { NotFoundError } from "@/server/repositories/errors"
import { createRegistry } from "../repositories/fixtures"

// The budget Server Actions and the form loader, against the real database. The session is replaced (what these tests
// care about is what each action does with the answer requireUserId gives), and revalidatePath is a spy. "Today" is moved
// with a fake Date where it matters: 2026-05-19 06:00Z is the same day in Kolkata and in New York, so the current month
// is 2026-05 in both runs.
const { requireUserId, UnauthenticatedError } = vi.hoisted(() => {
  class UnauthenticatedError extends Error {}
  return { requireUserId: vi.fn(), UnauthenticatedError }
})
vi.mock("@/server/auth", () => ({ requireUserId, UnauthenticatedError }))
const { revalidatePath } = vi.hoisted(() => ({ revalidatePath: vi.fn() }))
vi.mock("next/cache", () => ({ revalidatePath }))

const actions = await import("@/app/budgets/actions")
const report = await import("@/server/services/budget-report")

const registry = createRegistry()
afterAll(registry.cleanup)
beforeEach(() => {
  requireUserId.mockReset()
  revalidatePath.mockReset()
})
afterEach(() => vi.useRealTimers())

const at = (iso: string) => vi.useFakeTimers({ toFake: ["Date"], now: new Date(iso) })
const TODAY = "2026-05-19T06:00:00Z"

const NOT_FOUND = "This budget no longer exists. It may have been deleted in another tab."

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

/** A signed-in user with a food and a rent expense ledger and a bank. */
async function signedInWorld() {
  const user = await registry.makeUser()
  requireUserId.mockResolvedValue(user.id)
  const bank = await registry.makeNode(user.id, "ASSET", "Bank")
  const food = await registry.makeNode(user.id, "EXPENSE", "Food")
  const rent = await registry.makeNode(user.id, "EXPENSE", "Rent")
  const createInput = (over: Record<string, unknown> = {}) => ({
    nodeId: food.id,
    amount: "5,000",
    startMonth: "2026-05",
    endMonth: null,
    rollover: false,
    ...over,
  })
  return { user, bank, food, rent, createInput }
}

/** Someone else's budget on their own ledger. */
async function strangersBudget() {
  const stranger = await registry.makeUser()
  const theirs = await registry.makeNode(stranger.id, "EXPENSE", "Theirs")
  const budget = await registry.makeBudget(stranger.id, theirs.id, { startMonth: "2026-04-01" })
  return { stranger, theirs, budget }
}

const budgetCount = (userId: string) => prisma.budget.count({ where: { userId } })

describe("every Server Action", () => {
  it("sends the user to /login, before reading its input, when the session is gone", async () => {
    const exported = Object.entries(actions)
    expect(exported.map(([name]) => name).sort()).toEqual([
      "createBudgetAction",
      "deleteBudgetAction",
      "reviseBudgetAction",
      "updateBudgetSettingsAction",
    ])
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

  it("answers bad input with invalid_input and field errors, and writes nothing", async () => {
    const w = await signedInWorld()
    const budget = await registry.makeBudget(w.user.id, w.food.id)
    for (const [name, action] of Object.entries(actions)) {
      revalidatePath.mockReset()
      const result = await (action as (input: unknown) => Promise<unknown>)({ id: budget.id, junk: 1 })
      expect(result, name).toMatchObject({ ok: false, error: { code: "invalid_input" } })
      expectNoBigint(result)
      expect(revalidatePath, name).not.toHaveBeenCalled()
    }
    expect(await budgetCount(w.user.id)).toBe(1)
    const stored = await prisma.budget.findUniqueOrThrow({ where: { id: budget.id } })
    expect(stored.amountPaise).toBe(500_000n)
  })
})

describe("createBudgetAction", () => {
  it("parses rupee and month text, creates the budget for the signed-in user and returns a plain view", async () => {
    at(TODAY)
    const w = await signedInWorld()
    const result = await actions.createBudgetAction(w.createInput({ amount: "5,000.50", endMonth: "2026-09", rollover: true }))
    expect(result).toMatchObject({
      ok: true,
      data: { nodeId: w.food.id, nodeName: "Food", amountPaise: "500050", startMonth: "2026-05-01", endMonth: "2026-09-01", rollover: true },
    })
    expectNoBigint(result)
    expect(await budgetCount(w.user.id)).toBe(1)
    expect(revalidatePath).toHaveBeenCalledWith("/budgets")
    expect(revalidatePath).toHaveBeenCalledWith("/")
  })

  it("takes the owner from the session, never from the input", async () => {
    const w = await signedInWorld()
    const other = await registry.makeUser()
    const result = await actions.createBudgetAction(w.createInput({ userId: other.id }))
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_input" } })
    expectNoBigint(result)
    expect(await budgetCount(w.user.id)).toBe(0)
    expect(await budgetCount(other.id)).toBe(0)
  })

  it("returns field errors for invalid input and writes nothing", async () => {
    const w = await signedInWorld()
    const result = await actions.createBudgetAction(w.createInput({ amount: "0", startMonth: "2026-13", nodeId: "" }))
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_input" } })
    expect(!result.ok && Object.keys(result.error.fieldErrors ?? {}).sort()).toEqual(["amount", "nodeId", "startMonth"])
    expectNoBigint(result)
    expect(await budgetCount(w.user.id)).toBe(0)
    expect(revalidatePath).not.toHaveBeenCalled()
  })

  it("answers an overlap as invalid under startMonth, as plain data, and writes nothing more", async () => {
    at(TODAY)
    const w = await signedInWorld()
    expect(await actions.createBudgetAction(w.createInput())).toMatchObject({ ok: true })
    revalidatePath.mockReset()
    const again = await actions.createBudgetAction(w.createInput({ startMonth: "2026-07" }))
    expect(again).toMatchObject({ ok: false, error: { code: "invalid", fieldErrors: { startMonth: [expect.stringContaining("Food")] } } })
    expectNoBigint(again)
    expect(await budgetCount(w.user.id)).toBe(1)
    expect(revalidatePath).not.toHaveBeenCalled()
  })

  it("files a ledger that cannot have a budget under nodeId, and an end before the start under endMonth", async () => {
    const w = await signedInWorld()
    const result = await actions.createBudgetAction(w.createInput({ nodeId: w.bank.id }))
    expect(result).toMatchObject({ ok: false, error: { code: "invalid", fieldErrors: { nodeId: [expect.any(String)] } } })
    expectNoBigint(result)
    const backwards = await actions.createBudgetAction(w.createInput({ startMonth: "2026-05", endMonth: "2026-03" }))
    expect(backwards).toMatchObject({ ok: false, error: { code: "invalid", fieldErrors: { endMonth: [expect.any(String)] } } })
    expect(await budgetCount(w.user.id)).toBe(0)
  })

  it("answers a ledger that is not the user's as not_found, saying the ledger", async () => {
    const w = await signedInWorld()
    const { theirs } = await strangersBudget()
    const result = await actions.createBudgetAction(w.createInput({ nodeId: theirs.id }))
    expect(result).toEqual({ ok: false, error: { code: "not_found", message: "That ledger was not found" } })
    expect(await budgetCount(w.user.id)).toBe(0)
  })
})

describe("reviseBudgetAction", () => {
  it("corrects the amount in place from the start month, answering one plain view per budget", async () => {
    at(TODAY)
    const w = await signedInWorld()
    const budget = await registry.makeBudget(w.user.id, w.food.id, { startMonth: "2026-04-01" })
    const result = await actions.reviseBudgetAction({ id: budget.id, amount: "7,500", appliesFrom: "2026-04" })
    expect(result).toMatchObject({ ok: true, data: [{ id: budget.id, amountPaise: "750000", startMonth: "2026-04-01" }] })
    expectNoBigint(result)
    expect(revalidatePath).toHaveBeenCalledWith("/budgets")
  })

  it("splits the span from a later month: the old one ends the month before, a new one starts", async () => {
    at(TODAY)
    const w = await signedInWorld()
    const budget = await registry.makeBudget(w.user.id, w.food.id, { startMonth: "2026-03-01" })
    const result = await actions.reviseBudgetAction({ id: budget.id, amount: "9000", appliesFrom: "2026-05" })
    expect(result).toMatchObject({
      ok: true,
      data: [
        { id: budget.id, endMonth: "2026-04-01", amountPaise: "500000" },
        { startMonth: "2026-05-01", endMonth: null, amountPaise: "900000" },
      ],
    })
    expectNoBigint(result)
    expect(await budgetCount(w.user.id)).toBe(2)
  })

  it("says in plain words when the budget ended, naming the month once", async () => {
    at(TODAY)
    const w = await signedInWorld()
    const budget = await registry.makeBudget(w.user.id, w.food.id, { startMonth: "2026-01-01", endMonth: "2026-03-01" })
    const result = await actions.reviseBudgetAction({ id: budget.id, amount: "9000", appliesFrom: "2026-05" })
    expect(result).toEqual({
      ok: false,
      error: {
        code: "invalid",
        message: "This budget ended in Mar 2026. Pick a month it applies to.",
        fieldErrors: { appliesFrom: ["This budget ended in Mar 2026. Pick a month it applies to."] },
      },
    })
    expect(revalidatePath).not.toHaveBeenCalled()
  })

  it("an unchanged amount answers with the one span as it is, writes nothing and creates no split", async () => {
    at(TODAY)
    const w = await signedInWorld()
    const budget = await registry.makeBudget(w.user.id, w.food.id, { startMonth: "2026-03-01" })
    const result = await actions.reviseBudgetAction({ id: budget.id, amount: "5,000.00", appliesFrom: "2026-05" })
    expect(result).toMatchObject({ ok: true, data: [{ id: budget.id, amountPaise: "500000", startMonth: "2026-03-01", endMonth: null }] })
    expect((result as { data: unknown[] }).data).toHaveLength(1)
    expectNoBigint(result)
    expect(await budgetCount(w.user.id)).toBe(1)
    expect(await prisma.budget.findUniqueOrThrow({ where: { id: budget.id } })).toEqual(budget)
  })

  it("files a future month under appliesFrom and writes nothing", async () => {
    at(TODAY)
    const w = await signedInWorld()
    const budget = await registry.makeBudget(w.user.id, w.food.id, { startMonth: "2026-04-01" })
    const result = await actions.reviseBudgetAction({ id: budget.id, amount: "7500", appliesFrom: "2026-08" })
    expect(result).toMatchObject({ ok: false, error: { code: "invalid", fieldErrors: { appliesFrom: [expect.any(String)] } } })
    expectNoBigint(result)
    expect(revalidatePath).not.toHaveBeenCalled()
    expect(await budgetCount(w.user.id)).toBe(1)
    expect((await prisma.budget.findUniqueOrThrow({ where: { id: budget.id } })).amountPaise).toBe(500_000n)
  })

  it("answers a budget that is not the user's as not_found with the exact message, changing nothing", async () => {
    at(TODAY)
    await signedInWorld()
    const { budget } = await strangersBudget()
    const result = await actions.reviseBudgetAction({ id: budget.id, amount: "1", appliesFrom: "2026-04" })
    expect(result).toEqual({ ok: false, error: { code: "not_found", message: NOT_FOUND } })
    expectNoBigint(result)
    expect((await prisma.budget.findUniqueOrThrow({ where: { id: budget.id } })).amountPaise).toBe(500_000n)
    expect(revalidatePath).not.toHaveBeenCalled()
  })
})

describe("updateBudgetSettingsAction", () => {
  it("sets the end month and the rollover, and clears the end with null", async () => {
    const w = await signedInWorld()
    const budget = await registry.makeBudget(w.user.id, w.food.id, { startMonth: "2026-04-01" })
    const set = await actions.updateBudgetSettingsAction({ id: budget.id, endMonth: "2026-08", rollover: true })
    expect(set).toMatchObject({ ok: true, data: { id: budget.id, endMonth: "2026-08-01", rollover: true } })
    expectNoBigint(set)
    expect(revalidatePath).toHaveBeenCalledWith("/budgets")
    const cleared = await actions.updateBudgetSettingsAction({ id: budget.id, endMonth: null, rollover: true })
    expect(cleared).toMatchObject({ ok: true, data: { endMonth: null } })
  })

  it("files an end that runs into the next span under endMonth", async () => {
    const w = await signedInWorld()
    const first = await registry.makeBudget(w.user.id, w.food.id, { startMonth: "2026-01-01", endMonth: "2026-03-01" })
    await registry.makeBudget(w.user.id, w.food.id, { startMonth: "2026-04-01" })
    const result = await actions.updateBudgetSettingsAction({ id: first.id, endMonth: null, rollover: false })
    expect(result).toMatchObject({ ok: false, error: { code: "invalid", fieldErrors: { endMonth: [expect.any(String)] } } })
    expectNoBigint(result)
    expect(revalidatePath).not.toHaveBeenCalled()
  })

  it("answers a budget that is not the user's as not_found with the exact message, changing nothing", async () => {
    await signedInWorld()
    const { budget } = await strangersBudget()
    const result = await actions.updateBudgetSettingsAction({ id: budget.id, endMonth: "2026-09", rollover: true })
    expect(result).toEqual({ ok: false, error: { code: "not_found", message: NOT_FOUND } })
    const stored = await prisma.budget.findUniqueOrThrow({ where: { id: budget.id } })
    expect(stored.endMonth).toBeNull()
    expect(stored.rollover).toBe(false)
  })
})

describe("deleteBudgetAction", () => {
  it("deletes the budget, once", async () => {
    const w = await signedInWorld()
    const budget = await registry.makeBudget(w.user.id, w.food.id)
    expect(await actions.deleteBudgetAction({ id: budget.id })).toEqual({ ok: true, data: null })
    expect(await budgetCount(w.user.id)).toBe(0)
    expect(revalidatePath).toHaveBeenCalledWith("/budgets")
    expect(revalidatePath).toHaveBeenCalledWith("/")
    const again = await actions.deleteBudgetAction({ id: budget.id })
    expect(again).toEqual({ ok: false, error: { code: "not_found", message: NOT_FOUND } })
    expectNoBigint(again)
  })

  it("answers a budget that is not the user's as not_found with the exact message, deleting nothing", async () => {
    await signedInWorld()
    const { budget } = await strangersBudget()
    revalidatePath.mockReset()
    expect(await actions.deleteBudgetAction({ id: budget.id })).toEqual({ ok: false, error: { code: "not_found", message: NOT_FOUND } })
    expect(await prisma.budget.count({ where: { id: budget.id } })).toBe(1)
    expect(revalidatePath).not.toHaveBeenCalled()
  })
})

describe("cache invalidation", () => {
  const revalidated = () => revalidatePath.mock.calls.map(([path]) => path).sort()
  const everywhere = ["/", "/budgets", "/import", "/investments", "/investments/prices", "/nodes", "/recurring", "/transactions"]

  it("invalidates /budgets, with every other screen wrote() covers, after each write that succeeds", async () => {
    at(TODAY)
    const w = await signedInWorld()
    const created = await actions.createBudgetAction(w.createInput({ startMonth: "2026-04" }))
    if (!created.ok) throw new Error("setup failed")
    expect(revalidated()).toEqual(everywhere)
    const id = created.data.id
    const writes: [string, () => Promise<unknown>][] = [
      ["revise", () => actions.reviseBudgetAction({ id, amount: "6000", appliesFrom: "2026-04" })],
      ["settings", () => actions.updateBudgetSettingsAction({ id, endMonth: "2026-12", rollover: true })],
      ["delete", () => actions.deleteBudgetAction({ id })],
    ]
    for (const [name, write] of writes) {
      revalidatePath.mockReset()
      expect(await write(), name).toMatchObject({ ok: true })
      expect(revalidated(), name).toEqual(everywhere)
    }
  })
})

describe("loadBudgetForm", () => {
  it("lists only the live, non-system expense ledgers for a new budget, with today and no budget", async () => {
    at(TODAY)
    const w = await signedInWorld()
    await registry.makeNode(w.user.id, "EXPENSE", "Old gym", { archivedAt: new Date() })
    await registry.makeNode(w.user.id, "EXPENSE", "Contra", { systemRole: "OPENING_BALANCE_CONTRA" })
    await registry.makeNode(w.user.id, "INCOME_SOURCE", "Salary")
    const stranger = await registry.makeUser()
    await registry.makeNode(stranger.id, "EXPENSE", "Theirs")

    const form = await report.loadBudgetForm(w.user.id)
    expect(form.nodes.map((n) => n.name).sort()).toEqual(["Food", "Rent"])
    expect(form.nodes.every((n) => n.kind === "EXPENSE" && !n.archived && n.systemRole === null)).toBe(true)
    expect(form.budget).toBeNull()
    expect(form.today).toBe("2026-05-19")
    expectNoBigint(form)
  })

  it("returns the budget and includes its own ledger even when that ledger is archived", async () => {
    const w = await signedInWorld()
    const gym = await registry.makeNode(w.user.id, "EXPENSE", "Old gym", { archivedAt: new Date() })
    const other = await registry.makeNode(w.user.id, "EXPENSE", "Old pool", { archivedAt: new Date() })
    const budget = await registry.makeBudget(w.user.id, gym.id, { amountPaise: 123_450n })
    const form = await report.loadBudgetForm(w.user.id, budget.id)
    expect(form.budget).toMatchObject({ id: budget.id, nodeId: gym.id, nodeName: "Old gym", amountPaise: "123450" })
    const names = form.nodes.map((n) => n.name).sort()
    expect(names).toEqual(["Food", "Old gym", "Rent"])
    expect(names).not.toContain(other.name)
    expect(form.nodes.find((n) => n.id === gym.id)?.archived).toBe(true)
    expectNoBigint(form)
  })

  it("lists a live ledger once for its own budget", async () => {
    const w = await signedInWorld()
    const budget = await registry.makeBudget(w.user.id, w.food.id)
    const form = await report.loadBudgetForm(w.user.id, budget.id)
    expect(form.nodes.map((n) => n.name).sort()).toEqual(["Food", "Rent"])
  })

  it("refuses a budget that is not the user's, or that does not exist", async () => {
    const w = await signedInWorld()
    const { budget } = await strangersBudget()
    const error = await report.loadBudgetForm(w.user.id, budget.id).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(NotFoundError)
    expect((error as NotFoundError).entity).toBe("budget")
    await expect(report.loadBudgetForm(w.user.id, "missing-id")).rejects.toBeInstanceOf(NotFoundError)
  })
})
