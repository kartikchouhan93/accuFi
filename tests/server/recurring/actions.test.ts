import { randomUUID } from "node:crypto"
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { prisma } from "@/server/db"
import { NotFoundError } from "@/server/repositories/errors"
import { createRegistry } from "../repositories/fixtures"

// The recurring Server Actions and the screen loaders, against the real database. The session is replaced (what these
// tests care about is what each action does with the answer requireUserId gives), and revalidatePath is a spy.
const { requireUserId, UnauthenticatedError } = vi.hoisted(() => {
  class UnauthenticatedError extends Error {}
  return { requireUserId: vi.fn(), UnauthenticatedError }
})
vi.mock("@/server/auth", () => ({ requireUserId, UnauthenticatedError }))
const { revalidatePath } = vi.hoisted(() => ({ revalidatePath: vi.fn() }))
vi.mock("next/cache", () => ({ revalidatePath }))

const actions = await import("@/app/recurring/actions")
const service = await import("@/server/services/recurring-service")

const registry = createRegistry()
afterAll(registry.cleanup)
beforeEach(() => {
  requireUserId.mockReset()
  revalidatePath.mockReset()
})
afterEach(() => vi.useRealTimers())

const at = (iso: string) => vi.useFakeTimers({ toFake: ["Date"], now: new Date(iso) })

const NOT_FOUND = "This entry no longer exists. It may have been handled or its rule deleted in another tab."

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

/** A signed-in user with Rs 1,000.00 in a bank, a food expense and a gold investment valued by quantity. */
async function signedInWorld() {
  const user = await registry.makeUser()
  requireUserId.mockResolvedValue(user.id)
  const income = await registry.makeNode(user.id, "INCOME_SOURCE", "Salary")
  const bank = await registry.makeNode(user.id, "ASSET", "Bank")
  const food = await registry.makeNode(user.id, "EXPENSE", "Food")
  const gold = await registry.makeNode(user.id, "INVESTMENT", "Gold", { valuationMode: "QUANTITY", unitLabel: "g" })
  await registry.makeTransaction(user.id, income.id, bank.id, { amountPaise: 1_000_00n, occurredAt: "2026-01-01" })
  const ruleInput = (over: Record<string, unknown> = {}) => ({
    name: "Rent",
    fromNodeId: bank.id,
    toNodeId: food.id,
    amount: "100",
    frequency: "MONTHLY",
    interval: 1,
    startDate: "2027-01-05",
    autoPost: false,
    idempotencyKey: randomUUID(),
    ...over,
  })
  /** A rule bank -> food of Rs 100.00 with one PENDING occurrence due 2026-03-05. */
  const pending = async (over: Parameters<typeof registry.makeRule>[3] = {}, dueOn = "2026-03-05") => {
    const rule = await registry.makeRule(user.id, bank.id, food.id, { amountPaise: 100_00n, note: "monthly", ...over })
    const occurrence = await registry.makeOccurrence(user.id, rule.id, dueOn)
    return { rule, occurrence }
  }
  return { user, income, bank, food, gold, ruleInput, pending }
}

const ruleCount = (userId: string) => prisma.recurringRule.count({ where: { userId } })
const transactionCount = (userId: string) => prisma.transaction.count({ where: { userId } })

describe("every Server Action", () => {
  it("sends the user to /login, before reading its input, when the session is gone", async () => {
    const exported = Object.entries(actions)
    expect(exported.map(([name]) => name).sort()).toEqual([
      "createRuleAction",
      "deleteRuleAction",
      "dismissOccurrenceAction",
      "editRuleAction",
      "pauseRuleAction",
      "postOccurrenceAction",
      "restoreOccurrenceAction",
      "resumeRuleAction",
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
    const { occurrence } = await w.pending()
    for (const [name, action] of Object.entries(actions)) {
      revalidatePath.mockReset()
      const result = await (action as (input: unknown) => Promise<unknown>)({ id: occurrence.id, junk: 1 })
      expect(result, name).toMatchObject({ ok: false, error: { code: "invalid_input" } })
      expect(revalidatePath, name).not.toHaveBeenCalled()
    }
    expect(await transactionCount(w.user.id)).toBe(1)
    expect((await prisma.recurringOccurrence.findUniqueOrThrow({ where: { id: occurrence.id } })).status).toBe("PENDING")
  })
})

describe("createRuleAction", () => {
  it("parses rupee text, creates the rule for the signed-in user and returns a plain view", async () => {
    const w = await signedInWorld()
    const result = await actions.createRuleAction(w.ruleInput({ amount: "1,200.50", note: "flat" }))
    expect(result).toMatchObject({
      ok: true,
      data: { name: "Rent", amountPaise: "120050", note: "flat", startDate: "2027-01-05", nextDueOn: "2027-01-05", state: "active", version: 0 },
    })
    expectNoBigint(result)
    expect(await ruleCount(w.user.id)).toBe(1)
    expect(revalidatePath).toHaveBeenCalledWith("/recurring")
    expect(revalidatePath).toHaveBeenCalledWith("/")
  })

  it("answers a replayed key with the first rule", async () => {
    const w = await signedInWorld()
    const body = w.ruleInput()
    const first = await actions.createRuleAction(body)
    const second = await actions.createRuleAction({ ...body, name: "Other" })
    expect(first.ok && second.ok && second.data.id === first.data.id).toBe(true)
    expect(await ruleCount(w.user.id)).toBe(1)
  })

  it("takes the owner from the session, never from the input", async () => {
    const w = await signedInWorld()
    const other = await registry.makeUser()
    expect(await actions.createRuleAction(w.ruleInput({ userId: other.id }))).toMatchObject({ ok: false, error: { code: "invalid_input" } })
    expect(await ruleCount(w.user.id)).toBe(0)
    expect(await ruleCount(other.id)).toBe(0)
  })

  it("returns field errors for invalid input and writes nothing", async () => {
    const w = await signedInWorld()
    const result = await actions.createRuleAction(w.ruleInput({ amount: "0", name: " ", startDate: "2027-02-30", idempotencyKey: "" }))
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_input" } })
    expect(!result.ok && Object.keys(result.error.fieldErrors ?? {}).sort()).toEqual(["amount", "idempotencyKey", "name", "startDate"])
    expect(await ruleCount(w.user.id)).toBe(0)
    expect(revalidatePath).not.toHaveBeenCalled()
  })

  it("files a broken rule under the field to fix", async () => {
    const w = await signedInWorld()
    expect(await actions.createRuleAction(w.ruleInput({ toNodeId: w.bank.id }))).toMatchObject({
      ok: false,
      error: { code: "invalid", fieldErrors: { toNodeId: [expect.any(String)] } },
    })
    expect(await actions.createRuleAction(w.ruleInput({ toNodeId: w.gold.id, autoPost: true }))).toMatchObject({
      ok: false,
      error: { code: "invalid", fieldErrors: { autoPost: [expect.any(String)] } },
    })
    expect(await ruleCount(w.user.id)).toBe(0)
  })

  it("answers a node that is not the user's as not_found", async () => {
    const w = await signedInWorld()
    const stranger = await registry.makeUser()
    const theirs = await registry.makeNode(stranger.id, "EXPENSE", "Theirs")
    const result = await actions.createRuleAction(w.ruleInput({ toNodeId: theirs.id }))
    expect(result).toMatchObject({ ok: false, error: { code: "not_found" } })
    expect(await ruleCount(w.user.id)).toBe(0)
  })
})

describe("editRuleAction", () => {
  const editBody = (rule: { id: string; version: number }, over: Record<string, unknown> = {}, nodes: { from: string; to: string }) => ({
    id: rule.id,
    expectedVersion: rule.version,
    rule: {
      name: "Rent v2",
      fromNodeId: nodes.from,
      toNodeId: nodes.to,
      amount: "250",
      frequency: "MONTHLY",
      interval: 1,
      nextDue: "2027-02-05",
      autoPost: false,
      ...over,
    },
  })

  it("edits, answers the new view and invalidates the screens", async () => {
    const w = await signedInWorld()
    const created = await actions.createRuleAction(w.ruleInput())
    if (!created.ok) throw new Error("setup")
    revalidatePath.mockReset()
    const result = await actions.editRuleAction(editBody(created.data, {}, { from: w.bank.id, to: w.food.id }))
    expect(result).toMatchObject({ ok: true, data: { name: "Rent v2", amountPaise: "25000", nextDueOn: "2027-02-05", version: 1 } })
    expectNoBigint(result)
    expect(revalidatePath).toHaveBeenCalledWith("/recurring")
  })

  it("answers a stale version with version_conflict and a message only", async () => {
    const w = await signedInWorld()
    const created = await actions.createRuleAction(w.ruleInput())
    if (!created.ok) throw new Error("setup")
    await actions.editRuleAction(editBody(created.data, {}, { from: w.bank.id, to: w.food.id }))
    revalidatePath.mockReset()
    const stale = await actions.editRuleAction(editBody(created.data, { name: "Late" }, { from: w.bank.id, to: w.food.id }))
    expect(stale).toEqual({
      ok: false,
      error: { code: "version_conflict", message: "This rule was changed somewhere else since you opened it." },
    })
    expect(revalidatePath).not.toHaveBeenCalled()
    expect((await prisma.recurringRule.findUniqueOrThrow({ where: { id: created.data.id } })).name).toBe("Rent v2")
  })

  it("answers a rule that is not the user's as not_found", async () => {
    const w = await signedInWorld()
    const stranger = await registry.makeUser()
    const sBank = await registry.makeNode(stranger.id, "ASSET", "Bank")
    const sFood = await registry.makeNode(stranger.id, "EXPENSE", "Food")
    const theirs = await registry.makeRule(stranger.id, sBank.id, sFood.id)
    const result = await actions.editRuleAction(editBody(theirs, {}, { from: w.bank.id, to: w.food.id }))
    expect(result).toMatchObject({ ok: false, error: { code: "not_found", message: NOT_FOUND } })
    expect((await prisma.recurringRule.findUniqueOrThrow({ where: { id: theirs.id } })).name).toBe("Rent")
  })

  it("files a broken edit under the field to fix", async () => {
    const w = await signedInWorld()
    const created = await actions.createRuleAction(w.ruleInput())
    if (!created.ok) throw new Error("setup")
    const result = await actions.editRuleAction(editBody(created.data, { toNodeId: w.bank.id }, { from: w.bank.id, to: w.bank.id }))
    expect(result).toMatchObject({ ok: false, error: { code: "invalid", fieldErrors: { toNodeId: [expect.any(String)] } } })
  })
})

describe("pauseRuleAction and resumeRuleAction", () => {
  it("pauses and resumes, as plain views", async () => {
    const w = await signedInWorld()
    const created = await actions.createRuleAction(w.ruleInput())
    if (!created.ok) throw new Error("setup")
    const paused = await actions.pauseRuleAction({ id: created.data.id })
    expect(paused).toMatchObject({ ok: true, data: { state: "paused" } })
    expectNoBigint(paused)
    const resumed = await actions.resumeRuleAction({ id: created.data.id })
    expect(resumed).toMatchObject({ ok: true, data: { state: "active" } })
    expectNoBigint(resumed)
    expect(revalidatePath).toHaveBeenCalledWith("/recurring")
  })

  it("answers a rule that is not the user's as not_found", async () => {
    await signedInWorld()
    const stranger = await registry.makeUser()
    const sBank = await registry.makeNode(stranger.id, "ASSET", "Bank")
    const sFood = await registry.makeNode(stranger.id, "EXPENSE", "Food")
    const theirs = await registry.makeRule(stranger.id, sBank.id, sFood.id)
    for (const action of [actions.pauseRuleAction, actions.resumeRuleAction]) {
      expect(await action({ id: theirs.id })).toMatchObject({ ok: false, error: { code: "not_found", message: NOT_FOUND } })
    }
    expect((await prisma.recurringRule.findUniqueOrThrow({ where: { id: theirs.id } })).pausedAt).toBeNull()
  })
})

describe("deleteRuleAction", () => {
  it("deletes the rule and its pending entries, once", async () => {
    const w = await signedInWorld()
    const { rule, occurrence } = await w.pending()
    expect(await actions.deleteRuleAction({ id: rule.id })).toEqual({ ok: true, data: null })
    expect(await prisma.recurringOccurrence.count({ where: { id: occurrence.id } })).toBe(0)
    expect(revalidatePath).toHaveBeenCalledWith("/recurring")
    expect(await actions.deleteRuleAction({ id: rule.id })).toMatchObject({ ok: false, error: { code: "not_found" } })
  })

  it("answers a rule that is not the user's as not_found", async () => {
    await signedInWorld()
    const stranger = await registry.makeUser()
    const sBank = await registry.makeNode(stranger.id, "ASSET", "Bank")
    const sFood = await registry.makeNode(stranger.id, "EXPENSE", "Food")
    const theirs = await registry.makeRule(stranger.id, sBank.id, sFood.id)
    expect(await actions.deleteRuleAction({ id: theirs.id })).toMatchObject({ ok: false, error: { code: "not_found", message: NOT_FOUND } })
    expect((await prisma.recurringRule.findUniqueOrThrow({ where: { id: theirs.id } })).deletedAt).toBeNull()
  })
})

describe("postOccurrenceAction", () => {
  it("posts as proposed and returns a plain, posted view", async () => {
    const w = await signedInWorld()
    const { occurrence } = await w.pending()
    const result = await actions.postOccurrenceAction({ id: occurrence.id })
    expect(result).toMatchObject({ ok: true, data: { id: occurrence.id, status: "POSTED", amountPaise: "10000", dueOn: "2026-03-05" } })
    expectNoBigint(result)
    expect(await transactionCount(w.user.id)).toBe(2)
    expect(revalidatePath).toHaveBeenCalledWith("/recurring")
    expect(revalidatePath).toHaveBeenCalledWith("/transactions")
  })

  it("takes the overrides as text: rupees, a day and a note", async () => {
    const w = await signedInWorld()
    const { occurrence } = await w.pending()
    const result = await actions.postOccurrenceAction({ id: occurrence.id, amount: "250.50", occurredAt: "2026-03-07", note: "changed" })
    expect(result).toMatchObject({ ok: true, data: { status: "POSTED", amountPaise: "25050", note: "changed" } })
    const posted = await prisma.transaction.findFirstOrThrow({ where: { idempotencyKey: `recurring:${occurrence.id}` } })
    expect(posted.amountPaise).toBe(250_50n)
    expect(posted.occurredAt.toISOString().slice(0, 10)).toBe("2026-03-07")
  })

  it("answers a second post with ok and records one transaction", async () => {
    const w = await signedInWorld()
    const { occurrence } = await w.pending()
    const first = await actions.postOccurrenceAction({ id: occurrence.id })
    const second = await actions.postOccurrenceAction({ id: occurrence.id })
    expect(first.ok && second.ok).toBe(true)
    expect(first.ok && second.ok && second.data.transactionId === first.data.transactionId).toBe(true)
    expect(await prisma.transaction.count({ where: { idempotencyKey: `recurring:${occurrence.id}` } })).toBe(1)
  })

  it("answers bad override text with field errors and posts nothing", async () => {
    const w = await signedInWorld()
    const { occurrence } = await w.pending()
    const result = await actions.postOccurrenceAction({ id: occurrence.id, amount: "0", occurredAt: "2026-02-30", quantity: "abc" })
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_input" } })
    expect(!result.ok && Object.keys(result.error.fieldErrors ?? {}).sort()).toEqual(["amount", "occurredAt", "quantity"])
    expect(await transactionCount(w.user.id)).toBe(1)
  })

  it("answers a rule deleted in another tab with not_found and the plain-words message", async () => {
    const w = await signedInWorld()
    const { rule, occurrence } = await w.pending()
    await actions.deleteRuleAction({ id: rule.id })
    revalidatePath.mockReset()
    const result = await actions.postOccurrenceAction({ id: occurrence.id })
    expect(result).toEqual({ ok: false, error: { code: "not_found", message: NOT_FOUND } })
    expect(revalidatePath).not.toHaveBeenCalled()
    expect(await transactionCount(w.user.id)).toBe(1)
  })

  it("answers an occurrence that is not the user's as not_found", async () => {
    await signedInWorld()
    const stranger = await registry.makeUser()
    const sBank = await registry.makeNode(stranger.id, "ASSET", "Bank")
    const sFood = await registry.makeNode(stranger.id, "EXPENSE", "Food")
    const theirs = await registry.makeRule(stranger.id, sBank.id, sFood.id)
    const theirOccurrence = await registry.makeOccurrence(stranger.id, theirs.id, "2026-03-05")
    for (const action of [actions.postOccurrenceAction, actions.dismissOccurrenceAction, actions.restoreOccurrenceAction]) {
      expect(await action({ id: theirOccurrence.id })).toEqual({ ok: false, error: { code: "not_found", message: NOT_FOUND } })
    }
    expect((await prisma.recurringOccurrence.findUniqueOrThrow({ where: { id: theirOccurrence.id } })).status).toBe("PENDING")
  })

  it("answers a skipped occurrence with invalid", async () => {
    const w = await signedInWorld()
    const { occurrence } = await w.pending()
    await actions.dismissOccurrenceAction({ id: occurrence.id })
    expect(await actions.postOccurrenceAction({ id: occurrence.id })).toMatchObject({ ok: false, error: { code: "invalid", message: "Put it back before posting it." } })
  })

  it("files the transaction rules under amount, quantity and toNodeId", async () => {
    const w = await signedInWorld()
    const { occurrence } = await w.pending()
    // A quantity for an expense, which is not valued by quantity.
    expect(await actions.postOccurrenceAction({ id: occurrence.id, quantity: "2" })).toMatchObject({
      ok: false,
      error: { code: "invalid", fieldErrors: { quantity: [expect.any(String)] } },
    })
    // A purchase of gold with no quantity.
    const buy = await w.pending({}, "2026-03-06")
    await prisma.recurringRule.update({ where: { id: buy.rule.id }, data: { toNodeId: w.gold.id } })
    expect(await actions.postOccurrenceAction({ id: buy.occurrence.id })).toMatchObject({
      ok: false,
      error: { code: "invalid", fieldErrors: { quantity: [expect.any(String)] } },
    })
    // An end that has been archived since.
    const archived = await w.pending({}, "2026-03-07")
    await prisma.ledgerNode.update({ where: { id: w.food.id }, data: { archivedAt: new Date() } })
    expect(await actions.postOccurrenceAction({ id: archived.occurrence.id })).toMatchObject({
      ok: false,
      error: { code: "invalid", fieldErrors: { toNodeId: [expect.any(String)] } },
    })
    expect(await transactionCount(w.user.id)).toBe(1)
    expect(revalidatePath).not.toHaveBeenCalled()
  })

  it("takes a quantity for an investment valued by quantity", async () => {
    const w = await signedInWorld()
    const { rule, occurrence } = await w.pending()
    await prisma.recurringRule.update({ where: { id: rule.id }, data: { toNodeId: w.gold.id } })
    const result = await actions.postOccurrenceAction({ id: occurrence.id, quantity: "1.5" })
    expect(result).toMatchObject({ ok: true, data: { status: "POSTED" } })
    expectNoBigint(result)
  })

  it("answers an overdraft the source forbids with overdraft_blocked", async () => {
    const w = await signedInWorld()
    await prisma.ledgerNode.update({ where: { id: w.bank.id }, data: { blockNegative: true } })
    const { occurrence } = await w.pending({ amountPaise: 5_000_00n })
    expect(await actions.postOccurrenceAction({ id: occurrence.id })).toMatchObject({ ok: false, error: { code: "overdraft_blocked" } })
    expect(await transactionCount(w.user.id)).toBe(1)
  })
})

describe("dismissOccurrenceAction and restoreOccurrenceAction", () => {
  it("skips and puts back, as plain views", async () => {
    const w = await signedInWorld()
    const { occurrence } = await w.pending()
    const skipped = await actions.dismissOccurrenceAction({ id: occurrence.id })
    expect(skipped).toMatchObject({ ok: true, data: { status: "DISMISSED" } })
    expectNoBigint(skipped)
    const back = await actions.restoreOccurrenceAction({ id: occurrence.id })
    expect(back).toMatchObject({ ok: true, data: { status: "PENDING" } })
    expectNoBigint(back)
    expect(revalidatePath).toHaveBeenCalledWith("/recurring")
  })

  it("answers a posted occurrence with invalid", async () => {
    const w = await signedInWorld()
    const { occurrence } = await w.pending()
    await actions.postOccurrenceAction({ id: occurrence.id })
    expect(await actions.dismissOccurrenceAction({ id: occurrence.id })).toMatchObject({ ok: false, error: { code: "invalid" } })
    expect(await actions.restoreOccurrenceAction({ id: occurrence.id })).toMatchObject({ ok: false, error: { code: "invalid" } })
  })
})

describe("loadRecurringScreen", () => {
  it("lists the inbox oldest first, the rules, and the nodes", async () => {
    at("2026-04-01T06:00:00Z")
    const w = await signedInWorld()
    const { rule } = await w.pending({ name: "Rent" }, "2026-03-20")
    await registry.makeOccurrence(w.user.id, rule.id, "2026-03-05")
    await registry.makeOccurrence(w.user.id, rule.id, "2026-03-12")
    const screen = await service.loadRecurringScreen(w.user.id)
    expect(screen.inbox.map((o) => o.dueOn)).toEqual(["2026-03-05", "2026-03-12", "2026-03-20"])
    expect(screen.rules.map((r) => r.id)).toEqual([rule.id])
    expect(screen.nodes.map((n) => n.name).sort()).toEqual(["Bank", "Food", "Gold", "Salary"])
    expect(screen.today).toBe("2026-04-01")
    expectNoBigint(screen)
  })

  it("lists a deleted rule's nothing: no rule, no pending entry, no history", async () => {
    const w = await signedInWorld()
    const { rule, occurrence } = await w.pending()
    const handled = await registry.makeOccurrence(w.user.id, rule.id, "2026-02-05", { status: "DISMISSED", resolvedAt: new Date() })
    expect(handled.id).not.toBe(occurrence.id)
    await actions.deleteRuleAction({ id: rule.id })
    const screen = await service.loadRecurringScreen(w.user.id)
    expect(screen.inbox).toEqual([])
    expect(screen.rules).toEqual([])
    expect(screen.recent).toEqual([])
  })

  it("keeps the last 20 handled, newest first", async () => {
    const w = await signedInWorld()
    const rule = await registry.makeRule(w.user.id, w.bank.id, w.food.id, { amountPaise: 100_00n })
    const base = Date.parse("2026-03-01T00:00:00Z")
    for (let i = 0; i < 22; i++) {
      const day = String(i + 1).padStart(2, "0")
      await registry.makeOccurrence(w.user.id, rule.id, `2026-02-${day}`, {
        status: "DISMISSED",
        resolvedAt: new Date(base + i * 60_000),
      })
    }
    const screen = await service.loadRecurringScreen(w.user.id)
    expect(screen.recent).toHaveLength(20)
    expect(screen.recent[0].dueOn).toBe("2026-02-22")
    expect(screen.recent[19].dueOn).toBe("2026-02-03")
  })
})

describe("countPendingFor", () => {
  it("counts only live pending entries", async () => {
    const w = await signedInWorld()
    const { rule } = await w.pending({}, "2026-03-05")
    await registry.makeOccurrence(w.user.id, rule.id, "2026-03-06")
    await registry.makeOccurrence(w.user.id, rule.id, "2026-03-07", { status: "DISMISSED", resolvedAt: new Date() })
    await registry.makeOccurrence(w.user.id, rule.id, "2026-03-08", { status: "POSTED", resolvedAt: new Date() })
    const other = await registry.makeRule(w.user.id, w.bank.id, w.food.id, { name: "Gone" })
    await registry.makeOccurrence(w.user.id, other.id, "2026-03-05")
    await actions.deleteRuleAction({ id: other.id })
    const stranger = await registry.makeUser()
    const sBank = await registry.makeNode(stranger.id, "ASSET", "Bank")
    const sFood = await registry.makeNode(stranger.id, "EXPENSE", "Food")
    const theirs = await registry.makeRule(stranger.id, sBank.id, sFood.id)
    await registry.makeOccurrence(stranger.id, theirs.id, "2026-03-05")
    expect(await service.countPendingFor(w.user.id)).toBe(2)
    expect(await service.countPendingFor((await registry.makeUser()).id)).toBe(0)
  })
})

describe("loadRuleForEdit", () => {
  it("returns the rule with the nodes and today", async () => {
    at("2026-04-01T06:00:00Z")
    const w = await signedInWorld()
    const { rule } = await w.pending()
    const loaded = await service.loadRuleForEdit(w.user.id, rule.id)
    expect(loaded.rule).toMatchObject({ id: rule.id, name: "Rent", amountPaise: "10000", version: 0 })
    expect(loaded.nodes.length).toBe(4)
    expect(loaded.today).toBe("2026-04-01")
    expect(loaded.occurrences).toBeGreaterThan(0) // the rule has the entry `pending()` made for it
    expectNoBigint(loaded)
  })

  it("refuses a rule that is not the user's or is deleted", async () => {
    const w = await signedInWorld()
    const stranger = await registry.makeUser()
    const sBank = await registry.makeNode(stranger.id, "ASSET", "Bank")
    const sFood = await registry.makeNode(stranger.id, "EXPENSE", "Food")
    const theirs = await registry.makeRule(stranger.id, sBank.id, sFood.id)
    await expect(service.loadRuleForEdit(w.user.id, theirs.id)).rejects.toBeInstanceOf(NotFoundError)
    const { rule } = await w.pending()
    await actions.deleteRuleAction({ id: rule.id })
    await expect(service.loadRuleForEdit(w.user.id, rule.id)).rejects.toBeInstanceOf(NotFoundError)
  })
})

describe("loadNewRule", () => {
  it("returns every node and today in the user's zone, as plain data", async () => {
    at("2026-04-01T06:00:00Z")
    const w = await signedInWorld()
    const loaded = await service.loadNewRule(w.user.id)
    expect(loaded.nodes.length).toBe(4)
    expect(loaded.today).toBe("2026-04-01")
    expectNoBigint(loaded)
  })
})

describe("templateFromTransaction", () => {
  it("seeds a monthly rule from the transaction, starting the same day next month", async () => {
    at("2026-04-01T06:00:00Z")
    const w = await signedInWorld()
    const tx = await registry.makeTransaction(w.user.id, w.bank.id, w.food.id, {
      amountPaise: 120_050n,
      occurredAt: "2026-01-31",
      note: "internet",
      tags: ["home"],
    })
    const result = await service.templateFromTransaction(w.user.id, tx.id)
    expect(result.draft).toEqual({
      fromNodeId: w.bank.id,
      toNodeId: w.food.id,
      amountPaise: "120050",
      note: "internet",
      tags: ["home"],
      frequency: "MONTHLY",
      interval: 1,
      startDate: "2026-02-28",
      autoPost: false,
    })
    expect(result.nodes.length).toBe(4)
    expect(result.today).toBe("2026-04-01")
    expectNoBigint(result)
  })

  it("rolls December over into January of the next year", async () => {
    const w = await signedInWorld()
    const tx = await registry.makeTransaction(w.user.id, w.bank.id, w.food.id, { occurredAt: "2026-12-31" })
    expect((await service.templateFromTransaction(w.user.id, tx.id)).draft.startDate).toBe("2027-01-31")
  })

  it("refuses a leg of a split", async () => {
    const w = await signedInWorld()
    const tx = await registry.makeTransaction(w.user.id, w.bank.id, w.food.id)
    const group = await prisma.transactionGroup.create({ data: { userId: w.user.id, kind: "MANUAL_SPLIT" } })
    await prisma.transaction.update({ where: { id: tx.id }, data: { groupId: group.id } })
    await expect(service.templateFromTransaction(w.user.id, tx.id)).rejects.toBeInstanceOf(NotFoundError)
  })

  it("refuses a transaction that touches a system node", async () => {
    const w = await signedInWorld()
    const opening = await registry.makeNode(w.user.id, "INCOME_SOURCE", "Opening Balance", { systemRole: "OPENING_BALANCE" })
    const tx = await registry.makeTransaction(w.user.id, opening.id, w.bank.id)
    await expect(service.templateFromTransaction(w.user.id, tx.id)).rejects.toBeInstanceOf(NotFoundError)
  })

  it("refuses a deleted transaction and another user's", async () => {
    const w = await signedInWorld()
    const gone = await registry.makeTransaction(w.user.id, w.bank.id, w.food.id, { deletedAt: new Date() })
    await expect(service.templateFromTransaction(w.user.id, gone.id)).rejects.toBeInstanceOf(NotFoundError)
    const stranger = await registry.makeUser()
    const sBank = await registry.makeNode(stranger.id, "ASSET", "Bank")
    const sFood = await registry.makeNode(stranger.id, "EXPENSE", "Food")
    const theirs = await registry.makeTransaction(stranger.id, sBank.id, sFood.id)
    await expect(service.templateFromTransaction(w.user.id, theirs.id)).rejects.toBeInstanceOf(NotFoundError)
  })
})
